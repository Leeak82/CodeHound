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
  seller?: string | null;
  title: string;
  url: string;
  price: number;
  currency: string;
  source: "page" | "search" | "shopping";
  image?: string | null;
  rating?: number | null;
  ratingCount?: number | null;
  delivery?: string | null;
  kind?: "trusted" | "other" | "resale";
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
  const cleaned = titleCaseProduct(cleanName(name).replace(/^amazon\.com\s*:\s*/i, ""));
  if (cleaned && !junkTitle(cleaned) && !fragmentTitle(cleaned)) return cleaned;
  const alt = titleCaseProduct(cleanName(fallback).replace(/^amazon\.com\s*:\s*/i, ""));
  return alt && !junkTitle(alt) && !fragmentTitle(alt) ? alt : "";
}

export function titleCaseProduct(value: string): string {
  const brands: Record<string, string> = { airpods: "AirPods", magsafe: "MagSafe", iphone: "iPhone", ipad: "iPad", "usb-c": "USB-C" };
  const small = new Set(["a", "an", "and", "of", "the", "with", "for", "to", "in", "on"]);
  return value
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (brands[lower]) return brands[lower];
      if (/[a-z]/i.test(word) && /\d/.test(word)) return word.toUpperCase();
      if (index > 0 && small.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

export function fragmentTitle(title: string): boolean {
  const text = title.replace(/\s+/g, " ").trim();
  if (/^amazon\.com\b/i.test(text)) return true;
  if (/\bweight\b/i.test(text) && text.split(/\s+/).length < 6) return true;
  return text.split(/\s+/).length < 2;
}

export function accessoryTitle(title: string, query: string): boolean {
  const extra = /\b(silicone|leather|protective|replacement)\b|\bcase cover\b|\bskin\b|\bstrap\b|\bcable\b|\bfilter\b/i;
  return extra.test(title) && !extra.test(query);
}

export function isProductPage(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
  const path = parsed.pathname;
  if (/\/(s|search|b|sch|c|browse|stores)(\/|$)/i.test(path)) return false;
  if (/[?&](k|q|search|field-keywords)=/i.test(parsed.search) && !/\/dp\/|\/ip\/|\/itm\//i.test(path)) return false;
  if (host === "amazon.com" || host.endsWith(".amazon.com")) return /\/(?:dp|gp\/product)\/[A-Z0-9]{10}/i.test(path);
  if (host === "walmart.com" || host.endsWith(".walmart.com")) return /\/ip\/(?:.+\/)?\d+/.test(path);
  if (host === "target.com" || host.endsWith(".target.com")) return /\/p\/.+\/-\/A-\d+/i.test(path);
  if (host === "bestbuy.com" || host.endsWith(".bestbuy.com")) return /\/site\/.+\/\d+\.p/i.test(path);
  if (host === "ebay.com" || host.endsWith(".ebay.com")) return /\/itm\/(?:.+\/)?\d+/.test(path);
  return false;
}

export function productId(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname;
    return (
      path.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1] ||
      path.match(/\/ip\/(?:.+\/)?(\d+)/)?.[1] ||
      path.match(/\/-\/A-(\d+)/i)?.[1] ||
      path.match(/\/(\d+)\.p/i)?.[1] ||
      path.match(/\/itm\/(?:.+\/)?(\d+)/)?.[1] ||
      ""
    );
  } catch {
    return "";
  }
}

export function citedBySources(offerUrl: string, sources: string[]): boolean {
  const id = productId(offerUrl);
  const host = hostKey(offerUrl);
  return sources.some((source) => {
    if (!source) return false;
    if (source === offerUrl || source.includes(offerUrl)) return true;
    if (id && source.toLowerCase().includes(id.toLowerCase()) && source.toLowerCase().includes(host.split(".")[0])) return true;
    try {
      return hostKey(source) === host && Boolean(id) && `${new URL(source).pathname}${new URL(source).search}`.toLowerCase().includes(id.toLowerCase());
    } catch {
      return false;
    }
  });
}

export function saneOffers(offers: StoreOffer[]): StoreOffer[] {
  const trusted = offers.filter((offer) => isTrustedOffer(offer));
  return offers.filter((offer) => {
    const pool = trusted.length ? trusted : offers;
    const others = pool.filter((item) => item !== offer).map((item) => item.price);
    if (!others.length) return true;
    const median = medianOf(others);
    if (offer.price >= median * 0.55) return true;
    const agreed = pool.filter((item) => Math.abs(item.price - offer.price) <= offer.price * 0.15).length;
    return agreed >= 3;
  });
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function geminiRetailOffers(name: string, signal: AbortSignal): Promise<StoreOffer[]> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return [];
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${geminiModel()}:generateContent?key=${encodeURIComponent(key)}`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [{
            text: `Find the current new retail price for the exact product "${name}" at Amazon, Walmart, Target, Best Buy, and eBay. Return JSON only: {"offers":[{"store":"Amazon","title":"exact product title","price":249,"url":"https://www.amazon.com/dp/..."}]}. Each url must be that store's product page, not a search or category page. title is the product name, not a page fragment. price is the current new item price in USD, not a discount, monthly payment, accessory, or refurbished price. Omit a store if you are not sure.`,
          }],
        }],
        tools: [{ googleSearch: {} }],
        generationConfig: { temperature: 0 },
      }),
    });
    if (!response.ok) return [];
    const data = (await response.json()) as {
      candidates?: {
        content?: { parts?: { text?: string }[] };
        groundingMetadata?: { groundingChunks?: { web?: { uri?: string; title?: string } }[] };
      }[];
    };
    const candidate = data.candidates?.[0];
    const raw = candidate?.content?.parts?.map((part) => part.text ?? "").join("\n") ?? "";
    const parsed = parseJson(raw) as { offers?: { store?: unknown; title?: unknown; price?: unknown; url?: unknown }[] } | null;
    const chunks = candidate?.groundingMetadata?.groundingChunks ?? [];
    const sources = chunks.flatMap((chunk) => [chunk.web?.uri, chunk.web?.title].filter((value): value is string => Boolean(value)));
    for (const source of [...sources]) {
      const resolved = await resolveGroundingUrl(source, signal);
      if (resolved) sources.push(resolved);
    }
    const rows = (parsed?.offers ?? []).map((row) => ({
      title: typeof row.title === "string" ? row.title : "",
      url: typeof row.url === "string" ? row.url : "",
      price: typeof row.price === "number" ? row.price : Number(row.price),
    }));
    return filterGroundedOffers(name, rows, sources);
  } catch {
    return [];
  }
}

async function resolveGroundingUrl(url: string, signal: AbortSignal): Promise<string> {
  if (!/^https?:\/\//i.test(url) || !/vertexaisearch|grounding-api-redirect|google\./i.test(url)) return "";
  try {
    const response = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]) });
    const location = response.headers.get("location") || "";
    await response.arrayBuffer().catch(() => undefined);
    return location.startsWith("http") ? location : "";
  } catch {
    return "";
  }
}

function parseJson(raw: string): unknown {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function filterGroundedOffers(name: string, rows: { title: string; url: string; price: number }[], sources: string[]): StoreOffer[] {
  const offers: StoreOffer[] = [];
  for (const row of rows) {
    if (!row.url.startsWith("http") || !Number.isFinite(row.price) || row.price <= 0 || row.price > 100_000) continue;
    if (!isProductPage(row.url) || !citedBySources(row.url, sources)) continue;
    if (junkTitle(row.title) || fragmentTitle(row.title) || accessoryTitle(row.title, name) || !sameProduct({ name }, row.title)) continue;
    offers.push({
      store: storeName(row.url),
      title: titleCaseProduct(row.title),
      url: row.url,
      price: roundMoney(row.price),
      currency: "USD",
      source: "search",
    });
  }
  return saneOffers(dedupeOffers(offers)).sort((a, b) => a.price - b.price);
}

function dedupeOffers(offers: StoreOffer[]): StoreOffer[] {
  const seen = new Set<string>();
  const unique: StoreOffer[] = [];
  for (const offer of offers) {
    const key = hostKey(offer.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(offer);
  }
  return unique;
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
const matchCache = new Map<string, { at: number; result: { product: ProductQuote; offers: StoreOffer[]; resale: StoreOffer[] } }>();
const tavilyCache = new Map<string, { at: number; value: string }>();

interface TavilyBudget {
  searches: number;
  extracts: number;
  gemini: number;
}

export async function matchPrices(input: string, signal: AbortSignal): Promise<{ product: ProductQuote; offers: StoreOffer[]; resale: StoreOffer[] }> {
  const trimmed = input.replace(/\s+/g, " ").trim();
  if (trimmed.length < 2) throw new Error("Paste a product link or type a product name.");
  const cacheKey = trimmed.toLowerCase();
  const cached = matchCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 6 * 60 * 60 * 1000) return cached.result;
  const budget: TavilyBudget = { searches: 0, extracts: 0, gemini: 0 };
  const isUrl = /^https?:\/\//i.test(trimmed);
  const queryName = titleCaseProduct(isUrl ? nameFromUrl(trimmed) : trimmed) || trimmed;
  let origin: ProductQuote = {
    name: queryName,
    image: null,
    price: null,
    currency: "USD",
    url: isUrl ? trimmed : "",
    store: isUrl ? storeName(trimmed) : "",
    source: "search",
    upc: null,
  };
  if (isUrl && !isKnownStore(trimmed)) {
    const direct = await quoteFromUrl(trimmed, signal, budget);
    if (direct?.name) origin = { ...direct, name: usableName(direct.name, queryName) || queryName };
  }
  const retailer = isUrl ? retailerFromUrl(trimmed) : null;
  let rows = await serperShopping(origin.name, signal);
  if (retailer && !shoppingIncludesRetailer(rows, retailer)) {
    const extra = await serperShopping(retailerShoppingQuery(origin.name, retailer), signal);
    rows = rows.concat(extra);
  }
  let split = rows.length ? offersFromShopping(origin.name, rows) : { offers: [] as StoreOffer[], resale: [] as StoreOffer[] };
  if (!rows.length) {
    let fallback = await geminiRetailOffers(origin.name, signal);
    if (!fallback.length) {
      const hits = await retailSearch(origin.name, signal, budget);
      fallback = offersFromSearchHits(origin.name, hits).map((offer) => ({ ...offer, title: titleCaseProduct(offer.title) }));
    }
    split = offersFromShopping(origin.name, fallback.map((offer) => ({ source: offer.store, price: `$${offer.price}`, title: offer.title, link: offer.url, imageUrl: offer.image || "", rating: offer.rating ?? undefined, ratingCount: offer.ratingCount ?? undefined, delivery: offer.delivery || "" })));
  }
  const offers = split.offers.slice(0, 8);
  const resale = split.resale.slice(0, 8);
  if (!origin.image) origin.image = offers.find((offer) => offer.image)?.image ?? resale.find((offer) => offer.image)?.image ?? null;
  const reference = trustedReferencePrice(offers);
  if (reference != null) origin = { ...origin, price: reference, source: "search", image: origin.image };
  const result = { product: origin, offers, resale };
  if (offers.length || resale.length) matchCache.set(cacheKey, { at: Date.now(), result });
  return result;
}

const shoppingCache = new Map<string, { at: number; items: ShoppingRow[] }>();

export interface ShoppingRow {
  source?: string;
  price?: string;
  title?: string;
  link?: string;
  imageUrl?: string;
  rating?: number;
  ratingCount?: number;
  delivery?: string;
  productId?: string;
  position?: number;
}

const TRUSTED_RETAILERS: { name: string; match: RegExp; hosts: string[] }[] = [
  { name: "Amazon", match: /\bamazon\b/i, hosts: ["amazon.com"] },
  { name: "Walmart", match: /\bwalmart\b/i, hosts: ["walmart.com"] },
  { name: "Target", match: /\btarget\b/i, hosts: ["target.com"] },
  { name: "Best Buy", match: /\bbest\s*buy\b/i, hosts: ["bestbuy.com"] },
  { name: "Costco", match: /\bcostco\b/i, hosts: ["costco.com"] },
  { name: "Newegg", match: /\bnewegg\b/i, hosts: ["newegg.com"] },
  { name: "Apple", match: /\bapple\b/i, hosts: ["apple.com"] },
  { name: "Home Depot", match: /\bhome\s*depot\b/i, hosts: ["homedepot.com"] },
  { name: "Lowe's", match: /\blowe'?s\b/i, hosts: ["lowes.com"] },
  { name: "Kohl's", match: /\bkohl'?s\b/i, hosts: ["kohls.com"] },
  { name: "Macy's", match: /\bmacy'?s\b/i, hosts: ["macys.com"] },
  { name: "B&H", match: /\bb\s*&\s*h\b|\bbhphoto\b/i, hosts: ["bhphotovideo.com"] },
  { name: "Adorama", match: /\badorama\b/i, hosts: ["adorama.com"] },
  { name: "Crutchfield", match: /\bcrutchfield\b/i, hosts: ["crutchfield.com"] },
  { name: "Sam's Club", match: /\bsam'?s\s*club\b/i, hosts: ["samsclub.com"] },
  { name: "Dell", match: /\bdell\b/i, hosts: ["dell.com"] },
];

const RESALE_STORE = /\b(poshmark|mercari|whatnot|offer\s*up|depop|swappa|re-?cell|back\s*market|decluttr|ebay)\b/i;
const MISFIT_STORE = /\b(bearings?|tires?|tyres?|plumbing|lumber|pharmacy|auto\s*parts?|brake\s*pads?)\b/i;
const FOREIGN_TLD = "cl|uk|de|ca|mx|jp|fr|eu|in|br|es|it|nl|au|nz|kr|cn|ru|pl|se|no|dk|fi|ie|pt|be|at|ch|ar|pe|co";
const MANUFACTURERS = ["apple", "sony", "samsung", "ninja", "bose", "dyson", "dell", "hp", "lenovo", "microsoft", "lg", "google", "nike", "adidas", "kitchenaid", "cuisinart", "shark"];

export function offersFromShopping(queryName: string, rows: ShoppingRow[]): { offers: StoreOffer[]; resale: StoreOffer[] } {
  const accepted: StoreOffer[] = [];
  for (const row of rows) {
    const title = row.title?.trim() || "";
    const rawStore = row.source?.trim() || "";
    if (!title || !rawStore) continue;
    if (usedTitle(title, queryName) || accessoryTitle(title, queryName) || fragmentTitle(title) || junkTitle(title)) continue;
    if (!sameProduct({ name: queryName }, title)) continue;
    const price = parseShoppingPrice(row.price || "");
    if (price == null) continue;
    const seller = marketplaceSeller(rawStore);
    if (foreignStore(seller.store, row.link || "") || misfitStore(seller.store, queryName)) continue;
    const kind = classifyStore(seller.store, title, queryName);
    accepted.push({
      store: seller.store,
      seller: seller.seller,
      title: titleCaseProduct(title),
      url: shoppingLink(row.link, title),
      price,
      currency: "USD",
      source: "shopping",
      image: row.imageUrl || null,
      rating: typeof row.rating === "number" ? row.rating : null,
      ratingCount: typeof row.ratingCount === "number" ? row.ratingCount : null,
      delivery: row.delivery || null,
      kind,
    });
  }
  const byStore = new Map<string, StoreOffer>();
  for (const offer of accepted) {
    const key = `${offer.kind}:${offer.store.toLowerCase()}`;
    const current = byStore.get(key);
    if (!current || offer.price < current.price) byStore.set(key, offer);
  }
  const grouped = [...byStore.values()];
  const judged = saneOffers(grouped.filter((offer) => offer.kind !== "resale"));
  const trusted = judged.filter((offer) => offer.kind === "trusted").sort((a, b) => a.price - b.price);
  const others = judged.filter((offer) => offer.kind !== "trusted").sort((a, b) => a.price - b.price);
  let resale = grouped.filter((offer) => offer.kind === "resale").sort((a, b) => a.price - b.price);
  let offers = [...trusted, ...others];
  if (!trusted.length && !others.length) {
    const ebay = resale.filter((offer) => /\bebay\b/i.test(offer.store));
    const rest = resale.filter((offer) => !/\bebay\b/i.test(offer.store));
    if (ebay.length && !rest.length) {
      offers = ebay;
      resale = [];
    }
  }
  return { offers, resale };
}

export function trustedReferencePrice(offers: StoreOffer[]): number | null {
  const prices = offers.filter((offer) => offer.kind === "trusted").map((offer) => offer.price);
  if (!prices.length) return null;
  return roundMoney(medianOf(prices));
}

export function retailerFromUrl(url: string): string | null {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    return TRUSTED_RETAILERS.find((retailer) => retailer.hosts.some((item) => host === item || host.endsWith(`.${item}`)))?.name ?? null;
  } catch {
    return null;
  }
}

export function shoppingIncludesRetailer(rows: ShoppingRow[], retailer: string): boolean {
  const wanted = TRUSTED_RETAILERS.find((item) => item.name === retailer);
  if (!wanted) return false;
  return rows.some((row) => {
    if (trustedRetailerName(row.source || "") === retailer) return true;
    if (!row.link) return false;
    try {
      const host = new URL(row.link).hostname.replace(/^www\./, "").toLowerCase();
      return wanted.hosts.some((item) => host === item || host.endsWith(`.${item}`));
    } catch {
      return false;
    }
  });
}

export function retailerShoppingQuery(productName: string, retailer: string): string {
  return `${productName} ${retailer}`.replace(/\s+/g, " ").trim();
}

export function trustedRetailerName(source: string): string | null {
  const store = marketplaceSeller(source).store;
  return TRUSTED_RETAILERS.find((retailer) => retailer.match.test(store))?.name ?? null;
}

function isTrustedOffer(offer: StoreOffer): boolean {
  if (offer.kind === "other" || offer.kind === "resale") return false;
  if (offer.kind === "trusted") return true;
  return trustedRetailerName(offer.store) != null;
}

function classifyStore(store: string, title: string, query: string): "trusted" | "other" | "resale" {
  if (trustedRetailerName(store) || manufacturerStore(store, query)) return "trusted";
  if (isShopApp(store) || RESALE_STORE.test(store)) {
    if (/\bebay\b/i.test(store) && ebayListedAsNew(title)) return "other";
    return "resale";
  }
  return "other";
}

function manufacturerStore(store: string, query: string): boolean {
  const wanted = query.toLowerCase();
  return MANUFACTURERS.some((brand) => wanted.includes(brand) && new RegExp(`\\b${brand}\\b`, "i").test(store));
}

function isShopApp(store: string): boolean {
  const name = store.trim().toLowerCase();
  return name === "shop" || name === "shop app" || name === "shop.app" || name.startsWith("shop.app");
}

function ebayListedAsNew(title: string): boolean {
  if (/\b(used|refurbished|renewed|pre-?owned|open box)\b/i.test(title)) return false;
  return /\bbrand new\b/i.test(title) || /\bnew\b/i.test(title);
}

function misfitStore(store: string, query: string): boolean {
  return MISFIT_STORE.test(store) && !MISFIT_STORE.test(query);
}

function foreignStore(store: string, link: string): boolean {
  if (hasForeignDomain(store)) return true;
  if (!link || /(?:^|\.)google\.[a-z.]+$/i.test(hostOfLink(link))) return false;
  return hasForeignDomain(hostOfLink(link));
}

function hostOfLink(link: string): string {
  try {
    return new URL(link).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function hasForeignDomain(value: string): boolean {
  return new RegExp(`(?:^|[^a-z0-9])(?:[a-z0-9-]+\\.)+(?:${FOREIGN_TLD})(?:[^a-z0-9]|$)`, "i").test(value);
}

export function parseShoppingPrice(value: string): number | null {
  const match = value.replace(/,/g, "").match(/\$?\s*(\d+(?:\.\d{2})?)/);
  if (!match) return null;
  const price = Number(match[1]);
  if (!Number.isFinite(price) || price <= 0 || price > 100_000) return null;
  return Math.round(price * 100) / 100;
}

export function shoppingLink(link: string | undefined, title: string): string {
  if (link && /^https?:\/\//i.test(link)) return link;
  return `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(title)}`;
}

export function marketplaceSeller(source: string): { store: string; seller: string | null } {
  const parts = source.split(/\s+-\s+/);
  if (parts.length >= 2 && /\.[a-z]{2,}/i.test(parts[0])) return { store: parts[0].trim(), seller: parts.slice(1).join(" - ").trim() };
  return { store: source.trim(), seller: null };
}

function usedTitle(title: string, query: string): boolean {
  const mark = /\b(refurbished|renewed|pre-?owned|open box|used)\b/i;
  return mark.test(title) && !mark.test(query);
}

async function serperShopping(query: string, signal: AbortSignal): Promise<ShoppingRow[]> {
  const key = process.env.SERPER_API_KEY;
  if (!key) return [];
  const cacheKey = query.toLowerCase().trim();
  const cached = shoppingCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 6 * 60 * 60 * 1000) return cached.items;
  try {
    const response = await fetch("https://google.serper.dev/shopping", {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({ q: query, gl: "us" }),
    });
    if (!response.ok) return [];
    const data = (await response.json()) as { shopping?: ShoppingRow[] };
    const items = Array.isArray(data.shopping) ? data.shopping : [];
    shoppingCache.set(cacheKey, { at: Date.now(), items });
    return items;
  } catch {
    return [];
  }
}

export function offersFromSearchHits(originName: string, hits: { title: string; url: string; snippet: string }[]): StoreOffer[] {
  const offers: StoreOffer[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    if (!isKnownStore(hit.url) || !isProductPage(hit.url) || junkTitle(hit.title) || fragmentTitle(hit.title) || accessoryTitle(hit.title, originName) || !sameProduct({ name: originName }, hit.title)) continue;
    const price = firstGoodPrice(`${hit.title} ${hit.snippet}`);
    if (price == null) continue;
    const key = hostKey(hit.url);
    if (seen.has(key)) continue;
    seen.add(key);
    offers.push({
      store: storeName(hit.url),
      title: titleCaseProduct(usableName(hit.title, originName) || hit.title),
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
