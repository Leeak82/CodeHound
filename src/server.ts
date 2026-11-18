import express, { type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { brandSlug, cleanBrand } from "./extract.js";
import { analyzeScreenshot, GeminiConfigError } from "./gemini.js";
import { hunt } from "./hunt.js";
import { applyVote, clearCache, getCache, hydrateFromSupabase, trending } from "./store.js";
import { matchPrices, summarizeHistory, type ProductQuote } from "./price.js";
import { alertsReady, createWatch, emailReady, getWatch, hydrateWatches, runDueWatches, stopWatch, validEmail } from "./watch.js";
import { CODE_TYPES, type CodeType } from "./types.js";

const hits = new Map<string, number[]>();

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "6mb" }));
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    next();
  });

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.get("/api/trending", (_req, res) => {
    res.json({ searches: trending() });
  });

  app.get("/api/search", async (req, res) => {
    const brand = cleanBrand(String(req.query.q ?? ""));
    if (brand.length < 2) {
      res.status(400).json({ error: "Enter an app, game, or store name." });
      return;
    }
    if (!allow(req, "search", 12)) {
      res.status(429).json({ error: "Too many searches. Wait a minute and try again." });
      return;
    }
    const hintedType = CODE_TYPES.includes(String(req.query.type) as CodeType) ? (String(req.query.type) as CodeType) : null;
    const hint = String(req.query.hint ?? "").replace(/\s+/g, " ").trim().slice(0, 180);
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    const controller = new AbortController();
    req.on("close", () => controller.abort());
    try {
      await hunt(brand, {
        hintedType,
        hint,
        fresh: req.query.fresh === "1",
        signal: controller.signal,
        onEvent: (event, data) => writeEvent(res, event, data),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Search failed";
      writeEvent(res, "error", { error: message });
    }
    res.end();
  });

  app.get("/api/debug/sources", async (req, res) => {
    const brand = cleanBrand(String(req.query.q ?? ""));
    if (brand.length < 2) {
      res.status(400).json({ error: "Enter an app, game, or store name." });
      return;
    }
    if (!allow(req, "search", 12)) {
      res.status(429).json({ error: "Too many searches. Wait a minute and try again." });
      return;
    }
    try {
      const result = await hunt(brand, { fresh: true, signal: AbortSignal.timeout(50_000) });
      res.json({
        brand: result.brand,
        codes: result.codes.map((card) => ({
          code: card.code,
          type: card.type,
          reward: card.reward,
          confidence: card.confidence,
          urls: card.sources.map((source) => source.url),
        })),
        sources: result.sources,
        fetches: result.fetches,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Search failed";
      res.status(502).json({ error: message });
    }
  });

  app.post("/api/screenshot", async (req, res) => {
    if (!allow(req, "shot", 8)) {
      res.status(429).json({ error: "Too many screenshots. Wait a minute and try again." });
      return;
    }
    const mimeType = String(req.body?.mimeType ?? "");
    if (!/^image\/(png|jpeg|webp|gif)$/.test(mimeType)) {
      res.status(400).json({ error: "Upload a PNG, JPEG, WebP, or GIF." });
      return;
    }
    const image = normalizeImage(String(req.body?.image ?? ""));
    if (image.length < 32 || image.length > 5_500_000) {
      res.status(400).json({ error: "That image is empty or too large (max 4 MB)." });
      return;
    }
    try {
      const vision = await analyzeScreenshot(image, mimeType, AbortSignal.timeout(20_000));
      const brand = cleanBrand(vision.brand);
      res.json({ brand, codeType: vision.codeType, hints: vision.hints });
    } catch (error) {
      if (error instanceof GeminiConfigError) {
        res.status(503).json({ error: error.message, code: error.code });
        return;
      }
      res.status(502).json({ error: "The screenshot could not be read. Type the app name instead." });
    }
  });

  app.post("/api/votes", async (req, res) => {
    const brand = cleanBrand(String(req.body?.brand ?? ""));
    const code = String(req.body?.code ?? "").toUpperCase().replace(/[^A-Z0-9-]/g, "");
    const vote = req.body?.vote === "worked" || req.body?.vote === "failed" ? req.body.vote : null;
    const previous = req.body?.previous === "worked" || req.body?.previous === "failed" ? req.body.previous : null;
    if (brand.length < 2 || code.length < 3 || !vote) {
      res.status(400).json({ error: "Vote needs a brand, a code, and worked or failed." });
      return;
    }
    if (!allow(req, "vote", 30)) {
      res.status(429).json({ error: "Too many votes. Slow down a little." });
      return;
    }
    const row = await applyVote(brand, code, vote, previous);
    const cached = getCache(brandSlug(brand));
    const card = cached?.codes.find((item) => item.code === code);
    res.json({ code, worked: row.worked, failed: row.failed, confidence: card?.confidence ?? null, reasons: card?.reasons ?? [] });
  });

  app.delete("/api/cache", async (req, res) => {
    const brand = cleanBrand(String(req.query.q ?? ""));
    if (brand.length < 2) {
      res.status(400).json({ error: "Name the app to clear." });
      return;
    }
    await clearCache(brandSlug(brand));
    res.json({ cleared: brand });
  });

  app.get("/api/price/config", (_req, res) => {
    res.json({ email: emailReady(), alerts: alertsReady() });
  });

  app.post("/api/price/match", async (req, res) => {
    const query = String(req.body?.query ?? "").trim();
    if (query.length < 2 || query.length > 500) {
      res.status(400).json({ error: "Paste a product link or type a product name." });
      return;
    }
    if (!allow(req, "price", 8)) {
      res.status(429).json({ error: "Too many price checks. Wait a minute and try again." });
      return;
    }
    try {
      const result = await matchPrices(query, AbortSignal.timeout(45_000));
      res.json({ ...result, alerts: alertsReady() });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Price match failed";
      res.status(502).json({ error: message });
    }
  });

  app.post("/api/watch", async (req, res) => {
    const email = String(req.body?.email ?? "").trim();
    const ntfy = String(req.body?.ntfy ?? "").trim();
    const targetRaw = req.body?.target;
    const target = targetRaw === "" || targetRaw == null ? null : Number(targetRaw);
    const product = req.body?.product as ProductQuote | undefined;
    if (email && !validEmail(email)) {
      res.status(400).json({ error: "That email does not look right." });
      return;
    }
    if (ntfy && !/^[A-Za-z0-9_-]{1,64}$/.test(ntfy)) {
      res.status(400).json({ error: "An ntfy topic is letters, numbers, dashes, or underscores." });
      return;
    }
    if (target != null && (!Number.isFinite(target) || target <= 0)) {
      res.status(400).json({ error: "Target price needs to be a number above zero, or left blank." });
      return;
    }
    if (!email && !ntfy) {
      res.status(400).json({ error: emailReady() ? "Add an email or an ntfy topic." : "Email alerts are not turned on yet. Add RESEND_API_KEY and RESEND_FROM, or SMTP settings, on the server. You can still use a free ntfy.sh topic." });
      return;
    }
    if (!allow(req, "watch", 6)) {
      res.status(429).json({ error: "Too many watches. Slow down a little." });
      return;
    }
    try {
      const watch = await createWatch({
        email,
        ntfy: ntfy || null,
        target,
        product: product ?? { name: "", image: null, price: null, currency: "USD", url: "", store: "", source: "page", upc: null },
        baseUrl: publicBase(req),
      });
      const summary = summarizeHistory(watch.history, "all");
      res.status(201).json({ id: watch.id, token: watch.token, name: watch.name, history: watch.history, summary, alerts: Boolean(email && emailReady()) || Boolean(ntfy) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save that watch.";
      res.status(emailReady() || ntfy ? 400 : 503).json({ error: message });
    }
  });

  app.get("/api/watch/stop", async (req, res) => {
    const watch = await stopWatch(String(req.query.id ?? ""), String(req.query.token ?? ""));
    res.type("html").send(watch
      ? `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Stopped</title><body style="font-family:sans-serif;background:#07110c;color:#e8f7ee;padding:24px"><h1>Stopped watching</h1><p>${escapeHtml(watch.name)}</p><p><a style="color:#3dff8a" href="/">Back to CodeHound</a></p></body>`
      : `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not found</title><body style="font-family:sans-serif;background:#07110c;color:#e8f7ee;padding:24px"><h1>That link does not match a watch.</h1></body>`);
  });

  app.get("/api/watch/:id", async (req, res) => {
    const token = String(req.query.token ?? "");
    const range = req.query.range === "7d" || req.query.range === "30d" || req.query.range === "90d" || req.query.range === "all" ? req.query.range : "all";
    const watch = await getWatch(String(req.params.id), token);
    if (!watch || watch.stopped) {
      res.status(404).json({ error: "That watch is not active." });
      return;
    }
    res.json({
      id: watch.id,
      name: watch.name,
      url: watch.url,
      image: watch.image,
      store: watch.store,
      target: watch.target,
      history: watch.history,
      summary: summarizeHistory(watch.history, range),
    });
  });

  app.post("/api/watch/run", async (req, res) => {
    const secret = process.env.CRON_SECRET || "";
    const given = String(req.get("x-cron-secret") ?? "");
    if (!secret) {
      res.status(503).json({ error: "Set CRON_SECRET before running the daily check." });
      return;
    }
    if (!safeSecret(secret, given)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!allow(req, "cron", 4)) {
      res.status(429).json({ error: "The daily check already ran recently." });
      return;
    }
    const result = await runDueWatches(AbortSignal.timeout(50_000));
    res.json(result);
  });

  const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
  app.use(express.static(publicDir, { index: "index.html", maxAge: "1h" }));
  return app;
}

function writeEvent(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function normalizeImage(value: string): string {
  const comma = value.indexOf(",");
  if (value.startsWith("data:") && comma >= 0) return value.slice(comma + 1).replace(/\s/g, "");
  return value.replace(/\s/g, "");
}

function publicBase(req: Request): string {
  const configured = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
  if (configured) return configured;
  const proto = req.get("x-forwarded-proto") || req.protocol;
  return `${proto}://${req.get("host")}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] ?? char));
}

function safeSecret(secret: string, given: string): boolean {
  const left = Buffer.from(secret);
  const right = Buffer.from(given);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function allow(req: Request, bucket: string, limit: number): boolean {
  const ip = req.ip || "local";
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((at) => now - at < 10 * 60_000);
  if (recent.length >= limit) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  return true;
}

export function start(): void {
  const port = Number(process.env.PORT) || 3000;
  const app = createApp();
  app.listen(port, "0.0.0.0", () => {
    console.log(`CodeHound listening on 0.0.0.0:${port}`);
    void hydrateFromSupabase();
    void hydrateWatches();
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) start();
