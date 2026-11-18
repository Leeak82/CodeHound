import * as cheerio from "cheerio";
import type { SearchHit } from "./types.js";

const UA = "Mozilla/5.0 (compatible; CodeHound/1.0; +https://github.com/codehound) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const searchMemory = new Map<string, { at: number; hits: SearchHit[] }>();
const hostNext = new Map<string, number>();
let slots = 4;
const waiters: (() => void)[] = [];

export class SearchError extends Error {}

export function assertPublicUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
  if (url.username || url.password) throw new Error("credentials in url");
  if (isBlockedHost(url.hostname)) throw new Error("blocked host");
  return url;
}

export function isBlockedHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host === "metadata.google.internal" || host === "169.254.169.254") return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 10 || a === 127 || a === 0 || (a === 192 && b === 168) || (a === 169 && b === 254)) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) return true;
  return false;
}

export function stripTracking(raw: string): string {
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|msockid|gclid|fbclid|mc_|ref|ref_|yclid)/i.test(key)) url.searchParams.delete(key);
    }
    return url.href;
  } catch {
    return raw;
  }
}

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (slots <= 0) await new Promise<void>((resolve) => waiters.push(resolve));
  slots -= 1;
  try {
    return await fn();
  } finally {
    slots += 1;
    waiters.shift()?.();
  }
}

async function polite(host: string): Promise<void> {
  const now = Date.now();
  const at = hostNext.get(host) ?? 0;
  const start = Math.max(now, at);
  hostNext.set(host, start + 250);
  if (start > now) await new Promise((resolve) => setTimeout(resolve, start - now));
}

export async function fetchPage(
  rawUrl: string,
  parent: AbortSignal,
  maxBytes = 800_000,
  timeoutMs = 12_000,
): Promise<{ status: number; url: string; body: string; contentType: string }> {
  return withSlot(async () => {
    let current = assertPublicUrl(rawUrl).href;
    const signal = AbortSignal.any([parent, AbortSignal.timeout(timeoutMs)]);
    for (let hop = 0; hop < 4; hop += 1) {
      const url = assertPublicUrl(current);
      await polite(url.hostname);
      const response = await fetch(url, {
        signal,
        redirect: "manual",
        headers: {
          "user-agent": UA,
          accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
          "accept-language": "en",
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.arrayBuffer().catch(() => undefined);
        if (!location) return { status: response.status, url: current, body: "", contentType: "" };
        current = new URL(location, current).href;
        continue;
      }
      const contentType = response.headers.get("content-type") ?? "";
      const body = await readLimited(response, maxBytes);
      return { status: response.status, url: stripTracking(current), body, contentType };
    }
    return { status: 0, url: current, body: "", contentType: "" };
  });
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size >= maxBytes) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  return buffer.subarray(0, maxBytes).toString("utf8");
}

export async function searchWeb(query: string, signal: AbortSignal): Promise<SearchHit[]> {
  const key = query.toLowerCase().trim();
  const cached = searchMemory.get(key);
  if (cached && Date.now() - cached.at < 30 * 60_000) return cached.hits;
  const providers: Array<() => Promise<SearchHit[]>> = [];
  if (process.env.BRAVE_API_KEY) providers.push(() => searchBrave(query, signal));
  if (process.env.SERPER_API_KEY) providers.push(() => searchSerper(query, signal));
  providers.push(() => searchBing(query, signal), () => searchDuckDuckGo(query, signal));
  let lastError: unknown;
  for (const provider of providers) {
    try {
      const hits = await provider();
      if (hits.length) {
        searchMemory.set(key, { at: Date.now(), hits });
        return hits;
      }
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw new SearchError("search providers failed");
  return [];
}

async function searchBing(query: string, signal: AbortSignal): Promise<SearchHit[]> {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en&count=10`;
  const page = await fetchPage(url, signal, 500_000, 12_000);
  if (page.status >= 400 || !page.body) throw new SearchError(`bing ${page.status}`);
  const hits = parseBing(page.body);
  if (!hits.length && /captcha|unusual traffic/i.test(page.body)) throw new SearchError("bing blocked");
  return hits;
}

async function searchDuckDuckGo(query: string, signal: AbortSignal): Promise<SearchHit[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const page = await fetchPage(url, signal, 500_000, 8_000);
  if (page.status >= 400 || !page.body) throw new SearchError(`ddg ${page.status}`);
  return parseDuckDuckGo(page.body);
}

async function searchBrave(query: string, signal: AbortSignal): Promise<SearchHit[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10`;
  const response = await fetch(url, {
    signal,
    headers: { accept: "application/json", "x-subscription-token": process.env.BRAVE_API_KEY ?? "" },
  });
  if (!response.ok) throw new SearchError(`brave ${response.status}`);
  const data = (await response.json()) as { web?: { results?: { title?: string; url?: string; description?: string }[] } };
  return (data.web?.results ?? [])
    .map((row) => ({ title: row.title ?? "", url: row.url ?? "", snippet: row.description ?? "" }))
    .filter((row) => row.url.startsWith("http"));
}

async function searchSerper(query: string, signal: AbortSignal): Promise<SearchHit[]> {
  const response = await fetch("https://google.serper.dev/search", {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", "x-api-key": process.env.SERPER_API_KEY ?? "" },
    body: JSON.stringify({ q: query, num: 10 }),
  });
  if (!response.ok) throw new SearchError(`serper ${response.status}`);
  const data = (await response.json()) as { organic?: { title?: string; link?: string; snippet?: string }[] };
  return (data.organic ?? [])
    .map((row) => ({ title: row.title ?? "", url: row.link ?? "", snippet: row.snippet ?? "" }))
    .filter((row) => row.url.startsWith("http"));
}

export function decodeBingUrl(href: string): string {
  try {
    const url = new URL(href, "https://www.bing.com");
    const packed = url.searchParams.get("u");
    if (packed) {
      const body = packed.startsWith("a1") ? packed.slice(2) : packed;
      const padded = body + "=".repeat((4 - (body.length % 4)) % 4);
      const decoded = Buffer.from(padded, "base64").toString("utf8");
      if (decoded.startsWith("http")) return stripTracking(decoded);
    }
  } catch {
    /* keep the original href */
  }
  if (href.startsWith("http") && !href.includes("bing.com/ck/")) return stripTracking(href);
  return "";
}

export function parseBing(html: string): SearchHit[] {
  const $ = cheerio.load(html);
  const hits: SearchHit[] = [];
  $("li.b_algo").each((_, item) => {
    const anchor = $(item).find("h2 a").first();
    const href = anchor.attr("href") ?? "";
    const url = decodeBingUrl(href);
    if (!url) return;
    const title = anchor.text().replace(/\s+/g, " ").trim();
    const snippet = $(item).find("p").first().text().replace(/\s+/g, " ").trim();
    hits.push({ title, url, snippet });
  });
  return hits;
}

export function parseDuckDuckGo(html: string): SearchHit[] {
  const $ = cheerio.load(html);
  const hits: SearchHit[] = [];
  $("a.result__a").each((_, anchor) => {
    const href = $(anchor).attr("href") ?? "";
    let url = "";
    try {
      const parsed = new URL(href, "https://duckduckgo.com");
      url = parsed.searchParams.get("uddg") || (parsed.protocol.startsWith("http") ? parsed.href : "");
    } catch {
      url = "";
    }
    if (!url.startsWith("http")) return;
    const snippet = $(anchor).closest(".result").find(".result__snippet").text().replace(/\s+/g, " ").trim();
    hits.push({ title: $(anchor).text().replace(/\s+/g, " ").trim(), url: stripTracking(url), snippet });
  });
  return hits;
}

export interface YoutubeVideo {
  id: string;
  title: string;
  description: string;
}

export function parseYoutubeResults(html: string): YoutubeVideo[] {
  const titles = [...html.matchAll(/"title":\{"runs":\[\{"text":"((?:\\.|[^"\\]){3,180})"/g)].map((m) => jsonUnescape(m[1]));
  const ids = [...html.matchAll(/"videoId":"([\w-]{11})"/g)].map((m) => m[1]);
  const descriptions = [...html.matchAll(/"descriptionSnippet":\{"runs":\[\{"text":"((?:\\.|[^"\\]){0,300})"/g)].map((m) => jsonUnescape(m[1]));
  const videos: YoutubeVideo[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < Math.min(titles.length, ids.length, 12); i += 1) {
    if (seen.has(ids[i])) continue;
    seen.add(ids[i]);
    videos.push({ id: ids[i], title: titles[i], description: descriptions[i] ?? "" });
  }
  return videos;
}

function jsonUnescape(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value.replace(/\\u0026/g, "&").replace(/\\"/g, '"');
  }
}
