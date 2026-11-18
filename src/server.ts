import express, { type Request, type Response } from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { brandSlug, cleanBrand } from "./extract.js";
import { analyzeScreenshot, GeminiConfigError } from "./gemini.js";
import { hunt } from "./hunt.js";
import { applyVote, clearCache, getCache, hydrateFromSupabase, trending } from "./store.js";
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
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) start();
