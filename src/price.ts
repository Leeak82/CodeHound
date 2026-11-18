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
  const price = fromJson?.price ?? metaPrice ?? selectorPrice ?? visible;
  const name = cleanName(fromJson?.name || $('meta[property="og:title"]').attr("content") || $("title").first().text() || "");
  const image = fromJson?.image || $('meta[property="og:image"]').attr("content") || null;
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
  if (origin.upc && candidateUpc) return origin.upc === candidateUpc;
  const queryTokens = significant(origin.name);
  const titleTokens = significant(candidateTitle);
  if (!queryTokens.length || !titleTokens.length) return false;
  const queryModels = modelTokens(queryTokens);
  const titleModels = modelTokens(titleTokens);
  if (queryModels.length && !queryModels.every((token) => titleTokens.includes(token))) return false;
  if (titleModels.some((token) => !queryTokens.includes(token))) return false;
  const shared = queryTokens.filter((token) => titleTokens.includes(token));
  const needed = Math.min(queryTokens.length, Math.max(2, Math.ceil(queryTokens.length * 0.5)));
  return shared.length >= needed;
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

export async function matchPrices(input: string, signal: AbortSignal): Promise<{ product: ProductQuote; offers: StoreOffer[] }> {
  const trimmed = input.replace(/\s+/g, " ").trim();
  if (trimmed.length < 2) throw new Error("Paste a product link or type a product name.");
  const origin = /^https?:\/\//i.test(trimmed) ? await quoteFromUrl(trimmed, signal) : await quoteFromName(trimmed, signal);
  if (!origin?.name) throw new Error("Could not read a product from that. Try the product page URL.");
  const offers: StoreOffer[] = [];
  const seen = new Set<string>();
  if (origin.price != null) {
    offers.push(offerFrom(origin, origin.name));
    seen.add(hostKey(origin.url));
  }
  const found = await searchWeb(`${origin.name} price`, signal).catch(() => ({ hits: [], attempts: [] }));
  const extra = found.hits.some((hit) => isKnownStore(hit.url))
    ? found.hits
    : (await searchWeb(`${origin.name} site:amazon.com OR site:walmart.com OR site:bestbuy.com`, signal).catch(() => ({ hits: [], attempts: [] }))).hits;
  const candidates = [...found.hits, ...extra].filter((hit) => isKnownStore(hit.url) && sameProduct(origin, hit.title));
  for (const hit of candidates) {
    if (signal.aborted || offers.length >= 6) break;
    const key = hostKey(hit.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const snippetPrice = priceFromText(`${hit.title} ${hit.snippet}`);
    let quote: ProductQuote | null = null;
    try {
      quote = await quoteFromUrl(hit.url, signal, { title: hit.title, snippetPrice });
    } catch {
      quote = null;
    }
    const price = quote?.price ?? snippetPrice;
    const title = quote?.name || hit.title;
    if (price == null || !sameProduct(origin, title)) continue;
    offers.push({
      store: storeName(hit.url),
      title,
      url: hit.url,
      price,
      currency: quote?.currency || "USD",
      source: quote?.price != null && quote.source === "page" ? "page" : "search",
    });
  }
  offers.sort((a, b) => a.price - b.price);
  if (offers.length < 2) await fillStores(origin, offers, seen, signal);
  offers.sort((a, b) => a.price - b.price);
  return { product: origin, offers };
}

async function fillStores(origin: ProductQuote, offers: StoreOffer[], seen: Set<string>, signal: AbortSignal): Promise<void> {
  for (const store of ["walmart.com", "bestbuy.com", "target.com"]) {
    if (signal.aborted || offers.length >= 4 || seen.has(store)) continue;
    const found = await searchWeb(`${origin.name} site:${store}`, signal).catch(() => ({ hits: [], attempts: [] }));
    const hit = found.hits.find((item) => hostKey(item.url) === store && sameProduct(origin, item.title));
    if (!hit) continue;
    seen.add(store);
    const snippetPrice = priceFromText(`${hit.title} ${hit.snippet}`);
    let quote: ProductQuote | null = null;
    try {
      quote = await quoteFromUrl(hit.url, signal, { title: hit.title, snippetPrice });
    } catch {
      quote = null;
    }
    const price = quote?.price ?? snippetPrice;
    const title = quote?.name || hit.title;
    if (price == null || !sameProduct(origin, title)) continue;
    offers.push({
      store: storeName(hit.url),
      title,
      url: hit.url,
      price,
      currency: quote?.currency || "USD",
      source: quote?.price != null && quote.source === "page" ? "page" : "search",
    });
  }
}

async function quoteFromName(name: string, signal: AbortSignal): Promise<ProductQuote | null> {
  const found = await searchWeb(`${name} price`, signal).catch(() => ({ hits: [], attempts: [] }));
  const hit = found.hits.find((item) => isKnownStore(item.url) && sameProduct({ name }, item.title)) ?? found.hits.find((item) => isKnownStore(item.url));
  if (!hit) return { name, image: null, price: null, currency: "USD", url: "", store: "", source: "search", upc: null };
  try {
    const quote = await quoteFromUrl(hit.url, signal, { title: hit.title, snippetPrice: priceFromText(`${hit.title} ${hit.snippet}`) });
    return quote?.name ? quote : { name: hit.title, image: null, price: priceFromText(`${hit.title} ${hit.snippet}`), currency: "USD", url: hit.url, store: storeName(hit.url), source: "search", upc: null };
  } catch {
    return { name: hit.title, image: null, price: priceFromText(`${hit.title} ${hit.snippet}`), currency: "USD", url: hit.url, store: storeName(hit.url), source: "search", upc: null };
  }
}

async function quoteFromUrl(url: string, signal: AbortSignal, hint?: { title?: string; snippetPrice?: number | null }): Promise<ProductQuote | null> {
  const page = await fetchPage(url, signal, 800_000, 12_000).catch(() => null);
  if (!page || page.blocked || !page.body) {
    const name = cleanName(hint?.title || nameFromUrl(url));
    if (!name && hint?.snippetPrice == null) return null;
    return {
      name,
      image: null,
      price: hint?.snippetPrice ?? null,
      currency: "USD",
      url,
      store: storeName(url),
      source: "search",
      upc: null,
    };
  }
  const quote = extractPriceFromHtml(page.body, url);
  if (quote.price == null) {
    const guessed = await geminiPrice(page.body, signal);
    if (guessed?.price != null && page.body.includes(guessed.price.toFixed(2))) {
      quote.price = guessed.price;
      if (!quote.name && guessed.name) quote.name = cleanName(guessed.name);
    }
  }
  if (!quote.name) quote.name = cleanName(hint?.title || "");
  if (quote.price == null && hint?.snippetPrice != null) {
    quote.price = hint.snippetPrice;
    quote.source = "search";
  }
  return quote.name ? quote : null;
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
    return decodeURIComponent(parts[parts.length - 1] || "").replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ");
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
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((token) => token.length >= 2 && !STOP.has(token));
}

function modelTokens(tokens: string[]): string[] {
  return tokens.filter((token) => /\d/.test(token) && (/[a-z]/.test(token) || token.length >= 3));
}

export function rangeLabel(range: "7d" | "30d" | "90d" | "all"): string {
  if (range === "7d") return "7 days";
  if (range === "30d") return "30 days";
  if (range === "90d") return "90 days";
  return "the tracked history";
}
