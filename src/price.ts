import * as cheerio from "cheerio";
import { geminiModel } from "./gemini.js";
import { fetchPage, searchWeb } from "./net.js";

export interface PricePoint {
  at: string;
  price: number;
  source: "page" | "search";
}

export interface ProductQuote {
  name: string;
  image: string | null;
  price: number | null;
  currency: string;
  url: string;
  store: string;
  source: "page" | "search";
  upc: string | null;
}

export interface StoreOffer {
  store: string;
  title: string;
  url: string;
  price: number;
  currency: string;
  source: "page" | "search";
}

export interface HistorySummary {
  low: number;
  high: number;
  avg: number;
  points: PricePoint[];
  verdict: string;
  note: string;
}

const STORES: { host: string; name: string }[] = [
  { host: "amazon.com", name: "Amazon" },
  { host: "walmart.com", name: "Walmart" },
  { host: "target.com", name: "Target" },
  { host: "bestbuy.com", name: "Best Buy" },
  { host: "ebay.com", name: "eBay" },
  { host: "homedepot.com", name: "Home Depot" },
  { host: "costco.com", name: "Costco" },
];

const SELECTORS: Record<string, string[]> = {
  "amazon.com": ["#corePrice_feature_div .a-price .a-offscreen", "span.a-price .a-offscreen", "#priceblock_ourprice"],
  "walmart.com": ["[itemprop='price']", "[data-automation-id='product-price'] span"],
  "target.com": ["[data-test='product-price']"],
  "bestbuy.com": [".priceView-customer-price span", "[data-testid='customer-price'] span"],
  "ebay.com": [".x-price-primary span", "#prcIsum"],
};

const STOP = new Set("the and for with from this that pack size new set kit box inch inches color colour black white blue red green gold silver wireless bluetooth official genuine authentic free shipping".split(" "));

export function formatMoney(amount: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
}

export function storeName(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    const known = STORES.find((store) => host === store.host || host.endsWith(`.${store.host}`));
    if (known) return known.name;
    const parts = host.split(".");
    const label = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    return label ? label[0].toUpperCase() + label.slice(1) : host;
  } catch {
    return "Store";
  }
}

export function extractPriceFromHtml(html: string, pageUrl: string): ProductQuote {
  const $ = cheerio.load(html);
  const fromJson = jsonLdProduct($);
  const metaPrice = metaPriceAmount($);
  const selectorPrice = selectorAmount($, pageUrl);
  const visible = visibleAmount($);
  const embedded = embeddedRetailPrice(html);
  const price = fromJson?.price ?? metaPrice ?? selectorPrice ?? embedded?.price ?? visible;
  const name = usableName(fromJson?.name || embedded?.name || $('meta[property="og:title"]').attr("content") || $("title").first().text() || "", "");
  const image = fromJson?.image || embedded?.image || $('meta[property="og:image"]').attr("content") || null;
  return {
    name,
    image,
    price,
    currency: fromJson?.currency || metaCurrency($) || "USD",
    url: pageUrl,
    store: storeName(pageUrl),
    source: "page",
    upc: fromJson?.upc ?? null,
  };
}

export function sameProduct(origin: { name: string; upc?: string | null }, candidateTitle: string, candidateUpc?: string | null): boolean {
  if (junkTitle(candidateTitle)) return false;
  if (origin.upc && candidateUpc) return origin.upc === candidateUpc;
  const queryTokens = significant(origin.name);
  const titleTokens = significant(candidateTitle);
  if (queryTokens.length < 2 || !titleTokens.length) return false;
  const queryCodes = codeTokens(queryTokens);
  const titleCodes = codeTokens(titleTokens);
  if (queryCodes.length && !queryCodes.every((token) => titleTokens.includes(token))) return false;
  if (titleCodes.some((token) => !queryTokens.includes(token))) return false;
  const generations = queryTokens.filter((token) => /^\d{1,2}$/.test(token));
  if (generations.length && !generations.every((token) => titleTokens.includes(token))) return false;
  const shared = queryTokens.filter((token) => titleTokens.includes(token));
  const needed = Math.min(queryTokens.length, Math.max(2, Math.ceil(queryTokens.length * 0.6)));
  return shared.length >= needed;
}

export function junkTitle(title: string): boolean {
  const text = title.replace(/\s+/g, " ").trim();
  if (text.length < 6) return true;
  return /not found|prime modal|page open|sign in|robot check|captcha|access denied|verify you are|enable javascript|just a moment|product unavailable|cookies/i.test(text);
}

export function usableName(name: string, fallback: string): string {
  const cleaned = cleanName(name).replace(/^amazon\.com:\s*/i, "");
  if (cleaned && !junkTitle(cleaned)) return cleaned;
  const alt = cleanName(fallback).replace(/^amazon\.com:\s*/i, "");
  return alt && !junkTitle(alt) ? alt : "";
}

export function summarizeHistory(points: PricePoint[], range: "7d" | "30d" | "90d" | "all", now = Date.now()): HistorySummary {
  const ordered = [...points].filter((point) => Number.isFinite(point.price)).sort((a, b) => a.at.localeCompare(b.at));
  const requested = range === "7d" ? 7 : range === "30d" ? 30 : range === "90d" ? 90 : Number.POSITIVE_INFINITY;
  const windowed = ordered.filter((point) => now - Date.parse(point.at) <= requested * 86_400_000);
  const used = windowed;
  const note = "History starts the day tracking began. This is not a prediction.";
  if (!used.length) {
    return { low: 0, high: 0, avg: 0, points: [], verdict: "No prices in that range yet.", note };
  }
  const prices = used.map((point) => point.price);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const avg = roundMoney(prices.reduce((sum, price) => sum + price, 0) / prices.length);
  const latest = used[used.length - 1];
  const spanDays = used.length < 2 ? 0 : Math.max(1, Math.round((Date.parse(used[used.length - 1].at) - Date.parse(used[0].at)) / 86_400_000));
  let verdict = "About average since tracking began. This is not a forecast.";
  if (used.length < 2) verdict = "Tracking just started. History begins today, and this is not a forecast.";
  else if (latest.price <= low + 0.009) {
    const span = range !== "all" && spanDays >= requested ? rangeLabel(range) : `${spanDays} days of tracking`;
    verdict = `Lowest price in ${span}, good time to buy`;
  } else if (latest.price > avg * 1.03) verdict = "Above average, consider waiting";
  return { low, high, avg, points: used, verdict, note };
}

export function alertReason(target: number | null, prior: number[], price: number): "target" | "lowest" | "drop" | null {
  if (!Number.isFinite(price) || price <= 0) return null;
  if (target != null && price <= target) return "target";
  if (!prior.length) return null;
  const low = Math.min(...prior);
  if (price < low - 0.009) return "lowest";
  const previous = prior[prior.length - 1];
  if (previous - price >= 1 && price <= previous * 0.95) return "drop";
  return null;
}

const RETAIL_DOMAINS = ["amazon.com", "walmart.com", "target.com", "bestbuy.com", "ebay.com"];
const matchCache = new Map<string, { at: number; result: { product: ProductQuote; offers: StoreOffer[] } }>();
const tavilyCache = new Map<string, { at: number; value: string }>();

interface TavilyBudget {
  searches: number;
  extracts: number;
  gemini: number;
}

export async function matchPrices(input: string, signal: AbortSignal): Promise<{ product: ProductQuote; offers: StoreOffer[] }> {
  const trimmed = input.replace(/\s+/g, " ").trim();
  if (trimmed.length < 2) throw new Error("Paste a product link or type a product name.");
  const cacheKey = trimmed.toLowerCase();
  const cached = matchCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 6 * 60 * 60 * 1000) return cached.result;
  const budget: TavilyBudget = { searches: 0, extracts: 0, gemini: 0 };
  const isUrl = /^https?:\/\//i.test(trimmed);
  let origin: ProductQuote | null = isUrl ? await quoteFromUrl(trimmed, signal, budget) : null;
  if (!origin) origin = { name: trimmed, image: null, price: null, currency: "USD", url: isUrl ? trimmed : "", store: isUrl ? storeName(trimmed) : "", source: "search", upc: null };
  origin.name = usableName(origin.name, isUrl ? nameFromUrl(trimmed) : trimmed) || trimmed;
  const offers: StoreOffer[] = [];
  const seen = new Set<string>();
  if (origin.price != null && origin.url && !junkTitle(origin.name)) {
    offers.push(offerFrom(origin, origin.name));
    seen.add(hostKey(origin.url));
  }
  const hits = await retailSearch(origin.name, signal, budget);
  for (const offer of offersFromSearchHits(origin.name, hits)) {
    if (seen.has(hostKey(offer.url))) continue;
    seen.add(hostKey(offer.url));
    offers.push(offer);
  }
  const missingUrls: string[] = [];
  if (isUrl && isKnownStore(trimmed) && origin.price == null) missingUrls.push(trimmed);
  for (const hit of hits) {
    if (missingUrls.length >= 5) break;
    if (!isKnownStore(hit.url) || seen.has(hostKey(hit.url)) || !sameProduct(origin, hit.title)) continue;
    missingUrls.push(hit.url);
  }
  if (missingUrls.length) {
    const extracted = await tavilyExtract(missingUrls, signal, budget);
    for (const row of extracted) {
      const hint = hits.find((hit) => hit.url === row.url);
      let quote = quoteFromExtract(row.url, row.text, hint?.title || origin.name);
      if (quote && quote.price == null && budget.gemini < 1) {
        const guessed = await geminiPrice(row.text, signal);
        budget.gemini += 1;
        if (guessed?.price != null && row.text.includes(guessed.price.toFixed(2))) {
          quote.price = guessed.price;
          quote.source = "page";
        }
        if (guessed?.name) quote.name = usableName(guessed.name, quote.name);
      }
      if (!quote?.name || quote.price == null || junkTitle(quote.name) || !sameProduct(origin, quote.name)) continue;
      const key = hostKey(row.url);
      if (!key || seen.has(key)) {
        const existing = offers.find((offer) => hostKey(offer.url) === key);
        if (existing && quote.image) origin.image = origin.image || quote.image;
        continue;
      }
      seen.add(key);
      if (!origin.image && quote.image) origin.image = quote.image;
      if (key === hostKey(origin.url)) {
        origin = { ...origin, name: quote.name, price: quote.price, image: quote.image || origin.image, source: quote.source, store: quote.store, url: row.url };
      }
      offers.push(offerFrom(quote, quote.name));
    }
  }
  offers.sort((a, b) => a.price - b.price);
  if (!origin.price && offers[0]) {
    origin = { ...origin, price: offers[0].price, url: origin.url || offers[0].url, store: origin.store || offers[0].store, source: offers[0].source };
  }
  const result = { product: origin, offers: offers.slice(0, 6) };
  if (offers.length) matchCache.set(cacheKey, { at: Date.now(), result });
  return result;
}

export function offersFromSearchHits(originName: string, hits: { title: string; url: string; snippet: string }[]): StoreOffer[] {
  const offers: StoreOffer[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    if (!isKnownStore(hit.url) || junkTitle(hit.title) || !sameProduct({ name: originName }, hit.title)) continue;
    const price = firstGoodPrice(`${hit.title} ${hit.snippet}`);
    if (price == null) continue;
    const key = hostKey(hit.url);
    if (seen.has(key)) continue;
    seen.add(key);
    offers.push({
      store: storeName(hit.url),
      title: usableName(hit.title, originName),
      url: hit.url,
      price,
      currency: "USD",
      source: "search",
    });
  }
  return offers.sort((a, b) => a.price - b.price);
}

async function retailSearch(name: string, signal: AbortSignal, budget: TavilyBudget): Promise<{ title: string; url: string; snippet: string }[]> {
  const query = `${name} price`;
  const tavily = await tavilySearch(query, RETAIL_DOMAINS, signal, budget);
  if (tavily.length) return tavily;
  const domains = RETAIL_DOMAINS.map((host) => `site:${host}`).join(" OR ");
  const found = await searchWeb(`${name} (${domains})`, signal).catch(() => ({ hits: [], attempts: [] }));
  return found.hits;
}

async function quoteFromName(name: string, signal: AbortSignal, budget: TavilyBudget): Promise<ProductQuote | null> {
  const hits = await retailSearch(name, signal, budget);
  const hit = hits.find((item) => isKnownStore(item.url) && sameProduct({ name }, item.title) && firstGoodPrice(`${item.title} ${item.snippet}`) != null);
  if (!hit) return { name, image: null, price: null, currency: "USD", url: "", store: "", source: "search", upc: null };
  const price = firstGoodPrice(`${hit.title} ${hit.snippet}`);
  return { name: usableName(hit.title, name), image: null, price, currency: "USD", url: hit.url, store: storeName(hit.url), source: "search", upc: null };
}

async function quoteFromUrl(url: string, signal: AbortSignal, _budget: TavilyBudget, hint?: { title?: string; snippetPrice?: number | null }): Promise<ProductQuote | null> {
  if (!isKnownStore(url)) {
    const page = await fetchPage(url, signal, 800_000, 10_000).catch(() => null);
    if (page && !page.blocked && page.body) {
      const quote = extractPriceFromHtml(page.body, url);
      quote.name = usableName(quote.name, hint?.title || nameFromUrl(url));
      if (quote.price == null && hint?.snippetPrice != null) {
        quote.price = hint.snippetPrice;
        quote.source = "search";
      }
      return quote.name ? quote : null;
    }
  }
  const name = usableName(hint?.title || "", nameFromUrl(url));
  if (!name && hint?.snippetPrice == null) return null;
  return { name, image: null, price: hint?.snippetPrice ?? null, currency: "USD", url, store: storeName(url), source: "search", upc: null };
}

async function geminiPrice(html: string, signal: AbortSignal): Promise<{ name: string; price: number } | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 6000);
  if (!text) return null;
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${geminiModel()}:generateContent?key=${encodeURIComponent(key)}`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: `From this product page text, return JSON only: {"name":"","price":0}. price is the current item price as a number. Ignore savings ("save $X"), monthly payments, and bundle prices. If you cannot tell, use price 0.\n\n${text}` }] }],
        generationConfig: { temperature: 0 },
      }),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const raw = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("\n") ?? "";
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end < start) return null;
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { name?: unknown; price?: unknown };
    const price = typeof parsed.price === "number" ? parsed.price : Number(parsed.price);
    if (!Number.isFinite(price) || price <= 0 || price > 100_000) return null;
    return { name: typeof parsed.name === "string" ? parsed.name : "", price: roundMoney(price) };
  } catch {
    return null;
  }
}

function offerFrom(quote: ProductQuote, title: string): StoreOffer {
  return {
    store: quote.store,
    title,
    url: quote.url,
    price: quote.price ?? 0,
    currency: quote.currency,
    source: quote.source,
  };
}

function jsonLdProduct($: cheerio.CheerioAPI): { name: string; price: number | null; currency: string; image: string | null; upc: string | null } | null {
  const nodes: Record<string, unknown>[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).text();
    try {
      collect(JSON.parse(raw), nodes);
    } catch {
      /* ignore broken blocks */
    }
  });
  const product = nodes.find((node) => typeOf(node).some((type) => /product$/i.test(type)));
  if (!product) return null;
  const offer = firstOffer(product.offers);
  return {
    name: typeof product.name === "string" ? product.name : "",
    price: offer?.price ?? null,
    currency: offer?.currency || "USD",
    image: imageOf(product.image),
    upc: stringOf(product.gtin13) || stringOf(product.gtin12) || stringOf(product.gtin) || stringOf(product.sku) || null,
  };
}

function firstOffer(value: unknown): { price: number | null; currency: string } | null {
  const offers = Array.isArray(value) ? value : value ? [value] : [];
  const parsed = offers
    .filter((offer): offer is Record<string, unknown> => Boolean(offer) && typeof offer === "object")
    .map((offer) => {
      if (isPaymentPlan(offer)) return null;
      const price = numberOf(offer.price ?? offer.lowPrice);
      if (price == null) return null;
      return { price, currency: stringOf(offer.priceCurrency) || "USD" };
    })
    .filter((offer): offer is { price: number; currency: string } => Boolean(offer));
  if (!parsed.length) return null;
  return parsed.sort((a, b) => a.price - b.price)[0];
}

function isPaymentPlan(offer: Record<string, unknown>): boolean {
  const spec = offer.priceSpecification;
  const blob = JSON.stringify(spec ?? "").toLowerCase();
  return /month|subscription|mon\b/.test(blob);
}

function metaPriceAmount($: cheerio.CheerioAPI): number | null {
  const selectors = [
    'meta[property="product:price:amount"]',
    'meta[property="og:price:amount"]',
    'meta[itemprop="price"]',
  ];
  for (const selector of selectors) {
    const content = $(selector).attr("content");
    const price = numberOf(content);
    if (price != null) return price;
  }
  return null;
}

function metaCurrency($: cheerio.CheerioAPI): string {
  return $('meta[property="product:price:currency"]').attr("content") || $('meta[property="og:price:currency"]').attr("content") || "USD";
}

function selectorAmount($: cheerio.CheerioAPI, pageUrl: string): number | null {
  const host = hostKey(pageUrl);
  const selectors = SELECTORS[host] ?? [];
  for (const selector of selectors) {
    const text = $(selector).first().text();
    if (rejectedPriceText(text)) continue;
    const price = priceFromText(text);
    if (price != null) return price;
  }
  return null;
}

function visibleAmount($: cheerio.CheerioAPI): number | null {
  let found: number | null = null;
  $("body *").each((_, el) => {
    if (found != null) return;
    const node = $(el);
    if (node.children().length) return;
    const text = node.text().replace(/\s+/g, " ").trim();
    if (!text || text.length > 40 || rejectedPriceText(text)) return;
    const price = priceFromText(text);
    if (price != null && text.replace(/[^0-9.]/g, "").length <= 8) found = price;
  });
  return found;
}

export function priceFromText(text: string): number | null {
  const match = text.match(/(?:\$|usd\s*)(\d{1,5}(?:\.\d{2})?)/i);
  if (!match) return null;
  return numberOf(match[1]);
}

function rejectedPriceText(text: string): boolean {
  return /save\s+\$|you save|was\s+\$|\/mo\b|per month|monthly|as low as|bundle/i.test(text);
}

function numberOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return rangePrice(value);
  if (typeof value !== "string") return null;
  const match = value.replace(/,/g, "").match(/(\d{1,5}(?:\.\d{2})?)/);
  if (!match) return null;
  return rangePrice(Number(match[1]));
}

function rangePrice(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0 || value > 100_000) return null;
  return roundMoney(value);
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function collect(value: unknown, out: Record<string, unknown>[]): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collect(item, out);
    return;
  }
  const record = value as Record<string, unknown>;
  out.push(record);
  if (record["@graph"]) collect(record["@graph"], out);
}

function typeOf(node: Record<string, unknown>): string[] {
  const value = node["@type"];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

function imageOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return imageOf(value[0]);
  if (value && typeof value === "object" && typeof (value as { url?: unknown }).url === "string") return (value as { url: string }).url;
  return null;
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanName(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 180);
}

function nameFromUrl(url: string): string {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    const named = parts.filter((part) => /[a-z]/i.test(part) && part.includes("-") && part.length > 8);
    const slug = named.sort((a, b) => b.length - a.length)[0] || parts[parts.length - 1] || "";
    return decodeURIComponent(slug).replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ");
  } catch {
    return "";
  }
}

function isKnownStore(url: string): boolean {
  const host = hostKey(url);
  return STORES.some((store) => store.host === host);
}

function hostKey(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    const known = STORES.find((store) => host === store.host || host.endsWith(`.${store.host}`));
    return known?.host || host;
  } catch {
    return "";
  }
}

function significant(value: string): string[] {
  const normalized = value
    .toLowerCase()
    .replace(/\b(\d+)(?:st|nd|rd|th)\b/g, "$1")
    .replace(/\bfirst generation\b/g, "1")
    .replace(/\bsecond generation\b/g, "2")
    .replace(/\bthird generation\b/g, "3");
  return normalized
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((token) => token && !STOP.has(token) && (token.length >= 2 || /^\d$/.test(token)));
}

function codeTokens(tokens: string[]): string[] {
  return tokens.filter((token) => /[a-z]/.test(token) && /\d/.test(token));
}

export function firstGoodPrice(text: string): number | null {
  const pattern = /(?:\$|usd\s*)(\d{1,5}(?:\.\d{2})?)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const lead = text.slice(Math.max(0, match.index - 16), match.index + 1);
    const tail = text.slice(match.index + match[0].length, match.index + match[0].length + 8);
    if (/save\s+\$|was\s+\$|you save/i.test(lead) || /\/mo|per month|monthly/i.test(tail) || /used|renewed|refurbished|open box/i.test(lead)) continue;
    const price = numberOf(match[1]);
    if (price != null) return price;
  }
  return null;
}

function quoteFromExtract(url: string, text: string, fallbackName: string): ProductQuote | null {
  const htmlQuote = /<html|application\/ld\+json|__NEXT_DATA__|__PRELOADED_STATE__/i.test(text) ? extractPriceFromHtml(text, url) : null;
  const heading = text.match(/^#\s+(.{6,180})/m)?.[1] || "";
  const name = usableName(htmlQuote?.name || heading, fallbackName);
  const price = htmlQuote?.price ?? firstGoodPrice(text);
  if (!name && price == null) return null;
  return {
    name,
    image: htmlQuote?.image || text.match(/https?:\/\/\S+\.(?:jpg|jpeg|png|webp)/i)?.[0] || null,
    price,
    currency: htmlQuote?.currency || "USD",
    url,
    store: storeName(url),
    source: htmlQuote?.price != null ? "page" : "search",
    upc: htmlQuote?.upc ?? null,
  };
}

function embeddedRetailPrice(html: string): { name: string; price: number | null; image: string | null } | null {
  const blocks = [
    html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i)?.[1],
    html.match(/__PRELOADED_STATE__\s*=\s*(\{[\s\S]*?\})\s*;/i)?.[1],
  ].filter((block): block is string => Boolean(block));
  const found: { name: string; price: number; image: string | null }[] = [];
  for (const block of blocks) {
    try {
      walkRetail(JSON.parse(block), 0, found);
    } catch {
      /* ignore broken embedded state */
    }
  }
  return found[0] ?? null;
}

function walkRetail(node: unknown, depth: number, found: { name: string; price: number; image: string | null }[]): void {
  if (!node || typeof node !== "object" || depth > 7 || found.length > 4) return;
  if (Array.isArray(node)) {
    for (const item of node.slice(0, 20)) walkRetail(item, depth + 1, found);
    return;
  }
  const record = node as Record<string, unknown>;
  const name = stringOf(record.productName) || stringOf(record.name) || stringOf(record.title);
  const price = numberOf(record.currentPrice) ?? numberOf(record.customerPrice) ?? numberOf(record.offerPrice) ?? (typeof record.price === "number" ? numberOf(record.price) : null);
  if (name && price != null && !junkTitle(name)) found.push({ name, price, image: imageOf(record.image) });
  for (const value of Object.values(record)) {
    if (value && typeof value === "object") walkRetail(value, depth + 1, found);
  }
}

async function tavilySearch(query: string, domains: string[], signal: AbortSignal, budget: TavilyBudget): Promise<{ title: string; url: string; snippet: string }[]> {
  const key = process.env.TAVILY_API_KEY;
  if (!key || budget.searches >= 2) return [];
  const cacheKey = `s:${domains.join(",")}:${query.toLowerCase()}`;
  const cached = readTavilyCache(cacheKey);
  if (cached) return JSON.parse(cached) as { title: string; url: string; snippet: string }[];
  budget.searches += 1;
  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: key,
        query,
        search_depth: "basic",
        topic: "general",
        max_results: 8,
        include_answer: false,
        include_raw_content: false,
        include_domains: domains,
      }),
    });
    if (!response.ok) return [];
    const data = (await response.json()) as { results?: { title?: string; url?: string; content?: string }[] };
    const hits = (data.results ?? [])
      .map((row) => ({ title: row.title ?? "", url: row.url ?? "", snippet: row.content ?? "" }))
      .filter((row) => row.url.startsWith("http"));
    writeTavilyCache(cacheKey, JSON.stringify(hits));
    return hits;
  } catch {
    return [];
  }
}

async function tavilyExtract(urls: string[], signal: AbortSignal, budget: TavilyBudget): Promise<{ url: string; text: string }[]> {
  const key = process.env.TAVILY_API_KEY;
  const unique = [...new Set(urls)].slice(0, 5);
  if (!key || !unique.length || budget.extracts >= 1) return [];
  const cacheKey = `e:${unique.join("|")}`;
  const cached = readTavilyCache(cacheKey);
  if (cached) return JSON.parse(cached) as { url: string; text: string }[];
  budget.extracts += 1;
  try {
    const response = await fetch("https://api.tavily.com/extract", {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: key, urls: unique, extract_depth: "basic", format: "markdown" }),
    });
    if (!response.ok) return [];
    const data = (await response.json()) as { results?: { url?: string; raw_content?: string }[] };
    const rows = (data.results ?? [])
      .map((row) => ({ url: row.url ?? "", text: row.raw_content ?? "" }))
      .filter((row) => row.url && row.text);
    writeTavilyCache(cacheKey, JSON.stringify(rows));
    return rows;
  } catch {
    return [];
  }
}

function readTavilyCache(key: string): string | null {
  const cached = tavilyCache.get(key);
  if (!cached || Date.now() - cached.at > 6 * 60 * 60 * 1000) return null;
  return cached.value;
}

function writeTavilyCache(key: string, value: string): void {
  tavilyCache.set(key, { at: Date.now(), value });
}

export function rangeLabel(range: "7d" | "30d" | "90d" | "all"): string {
  if (range === "7d") return "7 days";
  if (range === "30d") return "30 days";
  if (range === "90d") return "90 days";
  return "the tracked history";
}
