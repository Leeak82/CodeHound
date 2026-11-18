import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { connect } from "node:tls";
import { alertReason, matchPrices, type PricePoint, type ProductQuote } from "./price.js";

export interface Watch {
  id: string;
  token: string;
  email: string;
  ntfy: string | null;
  target: number | null;
  name: string;
  url: string;
  image: string | null;
  store: string;
  baseUrl: string;
  createdAt: string;
  lastCheckedAt: string | null;
  lastAlertKey: string | null;
  stopped: boolean;
  history: PricePoint[];
}

interface PriceFile {
  watches: Watch[];
}

const memory: PriceFile = { watches: [] };
let loaded = false;
let chain: Promise<unknown> = Promise.resolve();

export function emailReady(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM) || Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.SMTP_FROM);
}

export function alertsReady(): boolean {
  return emailReady();
}

function dataFile(): string {
  const dir = process.env.DATA_DIR || path.resolve("data");
  mkdirSync(dir, { recursive: true });
  return path.join(dir, "prices.json");
}

function load(): void {
  if (loaded) return;
  loaded = true;
  const file = dataFile();
  if (!existsSync(file)) return;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as PriceFile;
    if (Array.isArray(parsed.watches)) memory.watches = parsed.watches;
  } catch {
    memory.watches = [];
  }
}

function saveFile(): void {
  writeFileSync(dataFile(), JSON.stringify(memory));
}

function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(() => undefined, () => undefined);
  return run;
}

function supabase(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url, key };
}

async function pushWatch(watch: Watch): Promise<void> {
  const db = supabase();
  if (!db) return;
  await fetch(`${db.url}/rest/v1/codehound_watches`, {
    method: "POST",
    headers: {
      apikey: db.key,
      authorization: `Bearer ${db.key}`,
      "content-type": "application/json",
      prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify([{ id: watch.id, payload: watch, updated_at: new Date().toISOString() }]),
  }).catch(() => undefined);
}

export async function hydrateWatches(): Promise<void> {
  load();
  const db = supabase();
  if (!db) return;
  try {
    const response = await fetch(`${db.url}/rest/v1/codehound_watches?select=payload`, {
      headers: { apikey: db.key, authorization: `Bearer ${db.key}` },
    });
    if (!response.ok) return;
    const rows = (await response.json()) as { payload?: Watch }[];
    const remote = rows.map((row) => row.payload).filter((watch): watch is Watch => Boolean(watch?.id && watch.token));
    if (!remote.length) return;
    const byId = new Map(memory.watches.map((watch) => [watch.id, watch]));
    for (const watch of remote) byId.set(watch.id, watch);
    memory.watches = [...byId.values()];
    saveFile();
  } catch {
    /* local file remains the fallback */
  }
}

export async function createWatch(input: {
  email: string;
  ntfy: string | null;
  target: number | null;
  product: ProductQuote;
  baseUrl: string;
}): Promise<Watch> {
  if (!input.email && !input.ntfy) throw new Error("Add an email, or an ntfy topic.");
  if (input.email && !emailReady()) {
    if (!input.ntfy) throw new Error("Email alerts are not turned on yet. Add RESEND_API_KEY and RESEND_FROM, or SMTP settings, on the server.");
    input = { ...input, email: "" };
  }
  if (!input.product.url || input.product.price == null) throw new Error("Match a product with a price before watching it.");
  const watch: Watch = {
    id: randomUUID(),
    token: randomBytes(18).toString("hex"),
    email: input.email,
    ntfy: input.ntfy,
    target: input.target,
    name: input.product.name,
    url: input.product.url,
    image: input.product.image,
    store: input.product.store,
    baseUrl: input.baseUrl.replace(/\/$/, ""),
    createdAt: new Date().toISOString(),
    lastCheckedAt: new Date().toISOString(),
    lastAlertKey: null,
    stopped: false,
    history: [{ at: new Date().toISOString(), price: input.product.price, source: input.product.source }],
  };
  await locked(async () => {
    load();
    memory.watches.push(watch);
    saveFile();
    await pushWatch(watch);
  });
  return watch;
}

export async function getWatch(id: string, token: string): Promise<Watch | null> {
  load();
  const watch = memory.watches.find((item) => item.id === id);
  if (!watch || !safeEqual(watch.token, token)) return null;
  return watch;
}

export async function stopWatch(id: string, token: string): Promise<Watch | null> {
  return locked(async () => {
    load();
    const watch = memory.watches.find((item) => item.id === id);
    if (!watch || !safeEqual(watch.token, token)) return null;
    watch.stopped = true;
    saveFile();
    await pushWatch(watch);
    return watch;
  });
}

export async function runDueWatches(signal: AbortSignal): Promise<{ checked: number; alerted: number; skipped: number }> {
  load();
  const due = memory.watches.filter((watch) => !watch.stopped && dueForCheck(watch));
  let checked = 0;
  let alerted = 0;
  let skipped = memory.watches.length - due.length;
  for (const watch of due.slice(0, 8)) {
    if (signal.aborted) break;
    try {
      const result = await checkWatch(watch, signal);
      checked += 1;
      if (result) alerted += 1;
    } catch {
      skipped += 1;
    }
  }
  return { checked, alerted, skipped };
}

async function checkWatch(watch: Watch, signal: AbortSignal): Promise<boolean> {
  const matched = await matchPrices(watch.url, signal);
  const own = matched.offers.find((offer) => hostOf(offer.url) === hostOf(watch.url)) ?? matched.offers[0];
  const price = own?.price ?? matched.product.price;
  if (price == null) {
    watch.lastCheckedAt = new Date().toISOString();
    await persist(watch);
    return false;
  }
  const source = own?.source === "shopping" ? "search" : own?.source ?? matched.product.source;
  const prior = watch.history.map((point) => point.price);
  const reason = alertReason(watch.target, prior, price);
  const at = new Date().toISOString();
  const today = at.slice(0, 10);
  const existing = watch.history.findIndex((point) => point.at.slice(0, 10) === today);
  const point = { at, price, source };
  if (existing >= 0) watch.history[existing] = point;
  else watch.history.push(point);
  watch.history = watch.history.slice(-400);
  watch.lastCheckedAt = at;
  const alertKey = reason ? `${today}:${reason}:${price}` : null;
  let sent = false;
  if (reason && alertKey !== watch.lastAlertKey) {
    await notify(watch, price, reason);
    watch.lastAlertKey = alertKey;
    sent = true;
  }
  await persist(watch);
  return sent;
}

function dueForCheck(watch: Watch): boolean {
  if (!watch.lastCheckedAt) return true;
  return Date.now() - Date.parse(watch.lastCheckedAt) >= 20 * 60 * 60 * 1000;
}

async function persist(watch: Watch): Promise<void> {
  await locked(async () => {
    const index = memory.watches.findIndex((item) => item.id === watch.id);
    if (index >= 0) memory.watches[index] = watch;
    saveFile();
    await pushWatch(watch);
  });
}

async function notify(watch: Watch, price: number, reason: "target" | "lowest" | "drop"): Promise<void> {
  const why = reason === "target" ? "It is at or below your target." : reason === "lowest" ? "It is the lowest price recorded since tracking began." : "It dropped by a meaningful amount.";
  const stop = `${watch.baseUrl}/api/watch/stop?id=${encodeURIComponent(watch.id)}&token=${encodeURIComponent(watch.token)}`;
  const text = `${watch.name} is now $${price.toFixed(2)} at ${watch.store}.\n${why}\n${watch.url}\n\nStop watching: ${stop}\n\nHistory starts the day tracking began. This is not a prediction.`;
  if (watch.email && emailReady()) await sendEmail(watch.email, `Price alert: ${watch.name}`, text);
  if (watch.ntfy) await sendNtfy(watch.ntfy, `Price alert: ${watch.name}`, text);
}

async function sendEmail(to: string, subject: string, text: string): Promise<void> {
  if (process.env.RESEND_API_KEY && process.env.RESEND_FROM) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: process.env.RESEND_FROM, to: [to], subject, text }),
    });
    if (!response.ok) throw new Error("email failed");
    return;
  }
  await smtpSend(to, subject, text);
}

async function sendNtfy(topic: string, title: string, text: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(topic)) return;
  const server = (process.env.NTFY_SERVER || "https://ntfy.sh").replace(/\/$/, "");
  await fetch(`${server}/${topic}`, {
    method: "POST",
    headers: { title, tags: "moneybag" },
    body: text,
  }).catch(() => undefined);
}

function smtpSend(to: string, subject: string, text: string): Promise<void> {
  const host = process.env.SMTP_HOST || "";
  const port = Number(process.env.SMTP_PORT || 465);
  const user = process.env.SMTP_USER || "";
  const pass = process.env.SMTP_PASS || "";
  const from = process.env.SMTP_FROM || user;
  const message = [`From: ${from}`, `To: ${to}`, `Subject: ${subject}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", text].join("\r\n");
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port, servername: host }, () => undefined);
    const steps = [
      `EHLO codehound`,
      `AUTH LOGIN`,
      Buffer.from(user).toString("base64"),
      Buffer.from(pass).toString("base64"),
      `MAIL FROM:<${from.match(/<([^>]+)>/)?.[1] || from}>`,
      `RCPT TO:<${to}>`,
      `DATA`,
      `${message}\r\n.`,
      `QUIT`,
    ];
    let index = 0;
    let buffer = "";
    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(15_000, () => fail(new Error("smtp timeout")));
    socket.on("error", fail);
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      const complete = lines.filter((line) => line && !/^\d{3}-/.test(line));
      const line = complete[complete.length - 1];
      if (!line) return;
      if (!/^[23]/.test(line)) return fail(new Error("smtp rejected"));
      const next = steps[index];
      index += 1;
      if (!next) {
        socket.end();
        resolve();
        return;
      }
      socket.write(`${next}\r\n`);
    });
  });
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 180;
}

export function resetWatchMemory(): void {
  memory.watches = [];
  loaded = false;
}
