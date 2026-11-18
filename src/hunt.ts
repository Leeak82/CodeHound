import { brandSlug, cleanBrand, discoverCodeArticleUrls, extractFromHtml, extractFromText, findDate, isOfficialUrl, parseLooseDate, typeFromLabel } from "./extract.js";
import { discoverUrls, extractVerbatim } from "./gemini.js";
import { fetchPage, parseYoutubeResults, searchWeb, stripTracking } from "./net.js";
import { mergeHits } from "./score.js";
import { cacheTtlFor, getCache, getVotes, rememberSearch, setCache } from "./store.js";
import type { CodeType, FetchTrace, HuntResult, RawHit, SearchHit, SourceCheck, SourceId, SourceState } from "./types.js";

const COUPON_HOSTS = [
  "retailmenot.com",
  "slickdeals.net",
  "dealspotr.com",
  "knoji.com",
  "couponfollow.com",
  "simplycodes.com",
  "groupon.com",
  "offers.com",
  "retailcoupons.com",
  "hotdeals.com",
  "dealdrop.com",
  "coupons.com",
  "savings.com",
];

const SOCIAL_HOSTS = ["x.com", "twitter.com", "instagram.com", "tiktok.com", "youtube.com", "youtu.be", "facebook.com", "discord.com", "discord.gg", "threads.net", "snapchat.com"];

const SKIP_FETCH = ["wikipedia.org", "play.google.com", "apps.apple.com", "amazon.com", "trustpilot.com"];

export interface HuntOptions {
  hintedType?: CodeType | null;
  hint?: string;
  fresh?: boolean;
  signal?: AbortSignal;
  onEvent?: (event: string, data: unknown) => void;
}

interface Passage {
  url: string;
  text: string;
  title: string;
  sourceId: SourceId;
  official: boolean;
  seenAt: string | null;
}

interface Ctx {
  brand: string;
  slug: string;
  hintedType: CodeType | null;
  signal: AbortSignal;
  hits: RawHit[];
  passages: Passage[];
  sources: SourceState[];
  onEvent?: (event: string, data: unknown) => void;
  pages: number;
  pageCache: Map<string, StoredPage>;
  inflight: Map<string, Promise<StoredPage>>;
  fetches: FetchTrace[];
  subreddit?: string;
}

interface StoredPage {
  url: string;
  body: string;
  status: number;
  via: FetchTrace["via"];
  blocked: boolean;
  bytes: number;
}

export async function hunt(input: string, options: HuntOptions = {}): Promise<HuntResult> {
  const brand = cleanBrand(input);
  if (brand.length < 2) throw new Error("Enter an app, game, or store name.");
  const slug = brandSlug(brand);
  await rememberSearch(brand, slug);
  const cached = options.fresh ? null : getCache(slug);
  if (cached) {
    options.onEvent?.("results", { codes: cached.codes });
    for (const source of cached.sources) options.onEvent?.("source", source);
    options.onEvent?.("done", cached);
    return cached;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 50_000);
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const ctx: Ctx = {
    brand,
    slug,
    hintedType: options.hintedType ?? null,
    signal,
    hits: [],
    passages: [],
    sources: sourceTemplates(),
    onEvent: options.onEvent,
    pages: 0,
    pageCache: new Map(),
    inflight: new Map(),
    fetches: [],
  };
  for (const source of ctx.sources) ctx.onEvent?.("source", source);

  const runners: Array<[SourceId, () => Promise<void>]> = [
    ["official", () => runOfficial(ctx)],
    ["social", () => runSocial(ctx)],
    ["reddit", () => runReddit(ctx)],
    ["coupons", () => runCoupons(ctx)],
    ["web", () => runWeb(ctx)],
    ["youtube", () => runYoutube(ctx)],
  ];
  await Promise.all(runners.map(([id, run]) => guard(ctx, id, run)));
  await guard(ctx, "gemini", () => runGemini(ctx));

  const result = finish(ctx, options.hint ?? "");
  const ttl = options.fresh ? null : cacheTtlFor(result);
  if (ttl) await setCache(slug, result, ttl);
  const { fetches: _fetches, ...published } = result;
  ctx.onEvent?.("results", { codes: result.codes });
  ctx.onEvent?.("done", published);
  clearTimeout(timer);
  return result;
}

function sourceTemplates(): SourceState[] {
  const item = (id: SourceId, label: string, detail = "Looking"): SourceState => ({
    id,
    label,
    status: "searching",
    detail,
    count: 0,
    items: [],
  });
  return [
    item("official", "Official pages"),
    item("social", "Socials"),
    item("reddit", "Reddit"),
    item("coupons", "Coupon sites"),
    item("web", "Web search"),
    item("youtube", "YouTube"),
    item("gemini", "Gemini", process.env.GEMINI_API_KEY ? "Looking" : "Not configured"),
  ];
}

export function redditUrl(permalink: string): string {
  if (permalink.startsWith("http")) return permalink;
  return `https://www.reddit.com${permalink.startsWith("/") ? permalink : `/${permalink}`}`;
}

export function sourceOutcome(codesFound: number, items: SourceCheck[], emptyDetail: string): Pick<SourceState, "status" | "detail" | "count" | "items"> {
  const listed = items.slice(0, 20);
  if (codesFound > 0) return { status: "found", detail: `${codesFound} posted`, count: codesFound, items: listed };
  if (listed.length > 0) return { status: "nothing", detail: `checked ${listed.length} posts, no codes`, count: 0, items: listed };
  return { status: "nothing", detail: emptyDetail, count: 0, items: [] };
}

async function guard(ctx: Ctx, id: SourceId, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    const hits = ctx.hits.filter((hit) => hit.sourceId === id);
    const state = ctx.sources.find((source) => source.id === id);
    if (state && state.status === "searching") {
      setSource(ctx, id, hits.length ? "found" : "nothing", hits.length ? `${hits.length} posted` : "Nothing public", uniqueCodes(hits));
    }
  } catch (error) {
    const aborted = ctx.signal.aborted || (error instanceof Error && error.name === "AbortError");
    setSource(ctx, id, "failed", aborted ? "Timed out" : "Source blocked", 0);
  }
}

async function runOfficial(ctx: Ctx): Promise<void> {
  const origin = await resolveOfficialOrigin(ctx);
  if (origin) {
    for (const path of ["/academy/en/support", "/academy", "/help", "/support", "/faq", "/promo", "/blog"]) {
      if (officialCodes(ctx) >= 4) break;
      const url = new URL(path, origin).href;
      const page = await loadPage(ctx, url, "official");
      if (!page?.body || page.blocked) continue;
      absorbPage(ctx, page, "official", "", "Official help");
      const articles = discoverCodeArticleUrls(page.body, page.url)
        .filter((link) => isOfficialUrl(link, ctx.brand))
        .sort((a, b) => articleRank(a) - articleRank(b));
      for (const article of articles.slice(0, 4)) {
        if (officialCodes(ctx) >= 4) break;
        await readPage(ctx, article, "official", "", "Official help");
      }
    }
  }
  const siteQuery = origin ? `site:${new URL(origin).hostname.replace(/^www\./, "")} sign-up code` : `${ctx.brand} sign up code`;
  const hits = await searchOrEmpty(ctx, siteQuery, "official");
  const extra = await searchOrEmpty(ctx, `${ctx.brand} bonus code help`, "official");
  const official = dedupeSearch([...hits, ...extra])
    .filter((hit) => isOfficialUrl(hit.url, ctx.brand) && !skipUrl(hit.url))
    .sort((a, b) => urlScore(b.url) - urlScore(a.url));
  for (const page of official.slice(0, 3)) {
    if (officialCodes(ctx) >= 8) break;
    await readPage(ctx, page.url, "official", page.snippet, page.title);
  }
  report(ctx, "official", "No codes on the public help pages");
}

function articleRank(url: string): number {
  if (/where-[\w-]*codes?|sign-?up/i.test(url)) return 0;
  if (/bonus-codes?/i.test(url)) return 1;
  if (/code/i.test(url)) return 2;
  return 3;
}

function officialCodes(ctx: Ctx): number {
  return ctx.hits.filter((hit) => hit.sourceId === "official" && hit.official).length;
}

async function resolveOfficialOrigin(ctx: Ctx): Promise<string | null> {
  for (const url of [`https://${ctx.slug}.com`, `https://www.${ctx.slug}.com`]) {
    const page = await loadPage(ctx, url, "official");
    if (!page?.body || page.blocked) continue;
    const title = page.body.match(/<title>([^<]{0,180})/i)?.[1] ?? "";
    if (new RegExp(escapeRegExp(ctx.brand), "i").test(`${title} ${page.body.slice(0, 2500)}`)) return new URL(page.url).origin;
  }
  return null;
}

async function runSocial(ctx: Ctx): Promise<void> {
  const hits = await searchOrEmpty(ctx, `${ctx.brand} (promo code OR bonus code OR "sign up code") (site:x.com OR site:instagram.com OR site:tiktok.com OR site:youtube.com OR site:facebook.com OR site:discord.com)`, "social");
  const social = dedupeSearch(hits).filter((hit) => hostIs(hit.url, SOCIAL_HOSTS) && !privateSocial(hit.url));
  absorbSnippets(ctx, social, "social");
  for (const hit of social.slice(0, 2)) {
    if (privateSocial(hit.url)) continue;
    await readPage(ctx, hit.url, "social", hit.snippet, hit.title);
  }
  report(ctx, "social", "No public posts");
}

async function runReddit(ctx: Ctx): Promise<void> {
  const archived = (await readArctic(ctx, "posts")) + (await readArctic(ctx, "comments"));
  if (archived === 0) {
    const query = encodeURIComponent(`${ctx.brand} promo code OR bonus code OR signup code`);
    const queries = [
      `https://www.reddit.com/search.json?q=${query}&sort=new&limit=12&t=year`,
      `https://old.reddit.com/search.json?q=${query}&sort=new&limit=12&t=year`,
    ];
    for (const url of queries) {
      const page = await fetchPage(url, ctx.signal, 600_000, 12_000, "text").catch(() => null);
      noteFetch(ctx, "reddit", url, page);
      if (!page || page.blocked || !page.body || looksLikeHtmlPage(page.body)) continue;
      readReddit(ctx, page.body);
    }
  }
  const codes = uniqueCodes(ctx.hits.filter((hit) => hit.sourceId === "reddit"));
  if (codes > 0) setSource(ctx, "reddit", "found", `${codes} posted`, codes);
  else report(ctx, "reddit", "No recent public posts");
}

function looksLikeHtmlPage(body: string): boolean {
  const head = body.trimStart().slice(0, 300).toLowerCase();
  return head.startsWith("<!doctype") || head.startsWith("<html");
}

async function readArctic(ctx: Ctx, kind: "posts" | "comments"): Promise<number> {
  const name = await resolveSubreddit(ctx);
  const hosts = ["https://arctic-shift.photon-reddit.com", "https://arctic-shift.com"];
  for (const host of hosts) {
    const timeout = host === "https://arctic-shift.com" ? 4_000 : 8_000;
    const url = arcticSearchUrl(host, kind, name, ctx.brand);
    let body = await fetchArctic(ctx, url, timeout);
    if (/slow down/i.test(arcticError(body)) && host !== "https://arctic-shift.com") {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      body = await fetchArctic(ctx, url.replace(/limit=\d+/, "limit=5"), timeout);
    }
    const found = ingestArctic(ctx, body);
    if (found > 0) return found;
    if (body.trim().startsWith("{") && !/requires one of: author, subreddit|unknown query parameter/i.test(arcticError(body))) return 0;
  }
  return 0;
}

function arcticSearchUrl(host: string, kind: "posts" | "comments", subreddit: string, brand: string): string {
  const name = encodeURIComponent(subreddit);
  if (kind === "posts") return `${host}/api/posts/search?subreddit=${name}&limit=10&sort=desc`;
  return `${host}/api/comments/search?subreddit=${name}&body=${encodeURIComponent(brand)}&limit=8&sort=desc`;
}

async function resolveSubreddit(ctx: Ctx): Promise<string> {
  if (ctx.subreddit) return ctx.subreddit;
  const hosts = ["https://arctic-shift.photon-reddit.com", "https://arctic-shift.com"];
  for (const host of hosts) {
    const url = `${host}/api/subreddits/search?subreddit_prefix=${encodeURIComponent(ctx.slug)}&limit=5`;
    const body = await fetchArctic(ctx, url, host === "https://arctic-shift.com" ? 4_000 : 8_000);
    let rows: { display_name?: string }[] = [];
    try {
      const parsed = JSON.parse(body) as { data?: { display_name?: string }[] };
      rows = Array.isArray(parsed.data) ? parsed.data : [];
    } catch {
      rows = [];
    }
    const exact = rows.find((row) => row.display_name?.toLowerCase() === ctx.slug);
    const name = exact?.display_name || rows[0]?.display_name;
    if (name) {
      ctx.subreddit = name;
      return name;
    }
    if (body.trim().startsWith("{")) break;
  }
  ctx.subreddit = ctx.brand;
  return ctx.brand;
}

function arcticError(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : "";
  } catch {
    return "";
  }
}

async function fetchArctic(ctx: Ctx, url: string, timeoutMs = 8_000): Promise<string> {
  const page = await fetchPage(url, ctx.signal, 400_000, timeoutMs, "text").catch(() => null);
  noteFetch(ctx, "reddit", url, page);
  if (!page) return "";
  return page.body;
}

function ingestArctic(ctx: Ctx, body: string): number {
  const rows = parseArcticRows(body);
  for (const row of rows) {
    const url = redditUrl(row.permalink);
    const seenAt = row.createdUtc === null ? null : new Date(row.createdUtc * 1000).toISOString();
    const extracted = extractFromText(row.text, {
      url,
      title: row.title || "Reddit",
      sourceId: "reddit",
      brand: ctx.brand,
      official: false,
      seenAt,
      hintedType: ctx.hintedType,
    });
    ctx.hits.push(...extracted);
    noteChecked(ctx, "reddit", { title: row.title || "Reddit", url, date: seenAt, codes: uniqueCodes(extracted) });
    ctx.passages.push({ url, text: row.text, title: row.title || "Reddit", sourceId: "reddit", official: false, seenAt });
  }
  return rows.length;
}

export function parseArcticRows(body: string): { title: string; text: string; permalink: string; createdUtc: number | null }[] {
  let parsed: { data?: unknown };
  try {
    parsed = JSON.parse(body) as { data?: unknown };
  } catch {
    return [];
  }
  if (!Array.isArray(parsed.data)) return [];
  const rows = [];
  for (const item of parsed.data) {
    if (!item || typeof item !== "object") continue;
    const row = item as { title?: unknown; selftext?: unknown; body?: unknown; permalink?: unknown; created_utc?: unknown };
    const permalink = typeof row.permalink === "string" ? row.permalink : "";
    if (!permalink) continue;
    const title = typeof row.title === "string" ? row.title : "";
    const extra = [row.selftext, row.body].filter((part): part is string => typeof part === "string").join("\n");
    rows.push({
      title,
      text: `${title}\n${extra}`.trim(),
      permalink,
      createdUtc: typeof row.created_utc === "number" ? row.created_utc : null,
    });
  }
  return rows;
}

async function runCoupons(ctx: Ctx): Promise<void> {
  const hits = await searchOrEmpty(ctx, `${ctx.brand} promo code`, "coupons");
  let couponHits = dedupeSearch(hits).filter((hit) => hostIs(hit.url, COUPON_HOSTS));
  if (!couponHits.length && ctx.slug.length >= 4) {
    couponHits = [
      { title: "CouponFollow", url: `https://couponfollow.com/site/${ctx.slug}.com`, snippet: "" },
      { title: "DealDrop", url: `https://www.dealdrop.com/${ctx.slug}`, snippet: "" },
    ];
  }
  absorbSnippets(ctx, couponHits, "coupons");
  for (const hit of couponHits.slice(0, 3)) await readPage(ctx, hit.url, "coupons", hit.snippet, hit.title);
  report(ctx, "coupons", "Pages had no full codes");
}

async function runWeb(ctx: Ctx): Promise<void> {
  const month = monthYear();
  const queries = [`${ctx.brand} promo code ${month}`, `${ctx.brand} bonus code`, `${ctx.brand} sign up code`];
  const all: SearchHit[] = [];
  for (const query of queries) all.push(...(await searchOrEmpty(ctx, query, "web")));
  const hits = dedupeSearch(all).filter((hit) => !skipUrl(hit.url) && !privateSocial(hit.url));
  absorbSnippets(ctx, hits, "web");
  const pages = hits.filter((hit) => !hostIs(hit.url, SOCIAL_HOSTS)).slice(0, 2);
  for (const hit of pages) await readPage(ctx, hit.url, "web", hit.snippet, hit.title);
  report(ctx, "web", "No full codes in public results");
}

async function runYoutube(ctx: Ctx): Promise<void> {
  const month = monthYear();
  const watchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(`${ctx.brand} promo code ${month}`)}`;
  const page = await fetchPage(watchUrl, ctx.signal, 1_200_000, 12_000).catch(() => null);
  noteFetch(ctx, "youtube", watchUrl, page);
  const videos = page && !page.blocked ? parseYoutubeResults(page.body) : [];
  let count = 0;
  for (const video of videos) {
    const blob = `${video.title}\n${video.description}`;
    if (!new RegExp(escapeRegExp(ctx.brand), "i").test(blob) && !/code|promo|bonus|coupon/i.test(blob)) continue;
    const url = `https://www.youtube.com/watch?v=${video.id}`;
    const before = ctx.hits.length;
    ctx.hits.push(
      ...extractFromText(`${video.title}. ${video.description}`, {
        url,
        title: video.title,
        sourceId: "youtube",
        brand: ctx.brand,
        official: false,
        hintedType: ctx.hintedType,
      }),
    );
    if (ctx.hits.length > before) count += 1;
    noteChecked(ctx, "youtube", { title: video.title, url, date: null, codes: uniqueCodes(ctx.hits.slice(before)) });
    ctx.passages.push({ url, text: blob, title: video.title, sourceId: "youtube", official: false, seenAt: null });
  }
  const codes = uniqueCodes(ctx.hits.filter((hit) => hit.sourceId === "youtube"));
  if (count) setSource(ctx, "youtube", "found", `${count} in titles`, count);
  else report(ctx, "youtube", videos.length ? "No code in titles" : "No matching videos");
}

async function runGemini(ctx: Ctx): Promise<void> {
  if (!process.env.GEMINI_API_KEY) {
    setSource(ctx, "gemini", "nothing", "Not configured", 0);
    return;
  }
  const urls = await discoverUrls(ctx.brand, ctx.signal).catch(() => []);
  for (const url of urls) {
    if (skipUrl(url) || privateSocial(url)) continue;
    await readPage(ctx, url, "gemini", "", "");
  }
  const extra = await extractVerbatim(ctx.brand, ctx.passages, ctx.signal).catch(() => []);
  ctx.hits.push(...extra);
  report(ctx, "gemini", "No extra public codes");
}

async function readPage(ctx: Ctx, rawUrl: string, sourceId: SourceId, snippet: string, title: string): Promise<number> {
  if (ctx.signal.aborted) return 0;
  let url = rawUrl;
  try {
    url = stripTracking(rawUrl);
  } catch {
    return 0;
  }
  if (skipUrl(url) || privateSocial(url)) return 0;
  const before = ctx.hits.length;
  const stored = await loadPage(ctx, url, sourceId);
  if (!stored) return 0;
  absorbPage(ctx, stored, sourceId, snippet, title);
  return ctx.hits.length > before ? 1 : 0;
}

async function loadPage(ctx: Ctx, url: string, sourceId: SourceId): Promise<StoredPage | null> {
  const cached = ctx.pageCache.get(url);
  if (cached) return cached;
  let pending = ctx.inflight.get(url);
  if (!pending) {
    if (ctx.pages >= 16) return null;
    ctx.pages += 1;
    pending = (async () => {
      const page = await fetchPage(url, ctx.signal).catch(() => null);
      noteFetch(ctx, sourceId, url, page);
      const row: StoredPage = {
        url,
        body: page && !page.blocked ? page.body : "",
        status: page?.status ?? 0,
        via: page?.via ?? "direct",
        blocked: page?.blocked ?? true,
        bytes: page?.bytes ?? 0,
      };
      ctx.pageCache.set(url, row);
      return row;
    })();
    ctx.inflight.set(url, pending);
  }
  return pending;
}

function absorbPage(
  ctx: Ctx,
  page: { url: string; body: string; status: number },
  sourceId: SourceId,
  snippet: string,
  title: string,
): void {
  const official = sourceId === "official" || isOfficialUrl(page.url, ctx.brand);
  if (snippet) {
    ctx.hits.push(
      ...extractFromText(snippet, {
        url: page.url,
        title,
        sourceId,
        brand: ctx.brand,
        official,
        seenAt: parseLooseDate(snippet),
        hintedType: ctx.hintedType,
      }),
    );
  }
  if (!page.body || page.status >= 400) {
    noteChecked(ctx, sourceId, { title: title || page.url, url: page.url, date: null, codes: 0 });
    return;
  }
  const seenAt = findDate(page.body) ?? parseLooseDate(snippet);
  const looksHtml = /<\s*(html|table|body|!doctype)/i.test(page.body.slice(0, 2000));
  if (!looksHtml) {
    ctx.hits.push(
      ...extractFromText(page.body, {
        url: page.url,
        title,
        sourceId,
        brand: ctx.brand,
        official,
        seenAt,
        hintedType: ctx.hintedType,
      }),
    );
    ctx.passages.push({ url: page.url, text: page.body.slice(0, 8000), title, sourceId, official, seenAt });
    notePage(ctx, sourceId, page.url, title, seenAt);
    publish(ctx);
    return;
  }
  ctx.hits.push(
    ...extractFromHtml(page.body, {
      url: page.url,
      title,
      sourceId,
      brand: ctx.brand,
      official,
      seenAt,
      hintedType: ctx.hintedType,
    }),
  );
  const text = page.body
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  ctx.passages.push({ url: page.url, text: text.slice(0, 8000), title, sourceId, official, seenAt });
  notePage(ctx, sourceId, page.url, title, seenAt);
  publish(ctx);
}

function readReddit(ctx: Ctx, body: string): number {
  let parsed: { data?: { children?: { data?: RedditPost }[] } };
  try {
    parsed = JSON.parse(body) as { data?: { children?: { data?: RedditPost }[] } };
  } catch {
    return 0;
  }
  const posts = parsed.data?.children ?? [];
  let kept = 0;
  for (const child of posts) {
    const post = child.data;
    if (!post) continue;
    const url = redditUrl(post.permalink ?? "");
    if (!url || url === "https://www.reddit.com") continue;
    const seenAt = post.created_utc ? new Date(post.created_utc * 1000).toISOString() : null;
    const text = `${post.title ?? ""}\n${post.selftext ?? ""}`;
    const extracted = extractFromText(text, {
      url,
      title: post.title ?? "Reddit",
      sourceId: "reddit",
      brand: ctx.brand,
      official: false,
      seenAt,
      hintedType: ctx.hintedType,
    });
    ctx.hits.push(...extracted);
    if (extracted.length) kept += 1;
    noteChecked(ctx, "reddit", { title: post.title ?? "Reddit", url, date: seenAt, codes: uniqueCodes(extracted) });
    ctx.passages.push({ url, text, title: post.title ?? "Reddit", sourceId: "reddit", official: false, seenAt });
  }
  return posts.length;
}

interface RedditPost {
  title?: string;
  selftext?: string;
  permalink?: string;
  created_utc?: number;
}

function absorbSnippets(ctx: Ctx, hits: SearchHit[], sourceId: SourceId): void {
  for (const hit of hits) {
    const seenAt = parseLooseDate(`${hit.snippet} ${hit.title}`);
    const extracted = extractFromText(`${hit.title}. ${hit.snippet}`, {
      url: hit.url,
      title: hit.title,
      sourceId,
      brand: ctx.brand,
      official: isOfficialUrl(hit.url, ctx.brand),
      seenAt,
      hintedType: ctx.hintedType ?? typeFromLabel(hit.title),
    });
    ctx.hits.push(...extracted);
    noteChecked(ctx, sourceId, { title: hit.title || hit.url, url: hit.url, date: seenAt, codes: uniqueCodes(extracted) });
  }
  publish(ctx);
}

async function searchOrEmpty(ctx: Ctx, query: string, sourceId: SourceId): Promise<SearchHit[]> {
  try {
    const found = await searchWeb(query, ctx.signal);
    for (const attempt of found.attempts) {
      ctx.fetches.push({ sourceId, url: `search:${query.slice(0, 90)}`, ...attempt });
    }
    return found.hits;
  } catch {
    ctx.fetches.push({ sourceId, url: `search:${query.slice(0, 90)}`, via: "direct", status: 0, bytes: 0, blocked: true, note: "search blocked" });
    return [];
  }
}

function noteFetch(ctx: Ctx, sourceId: SourceId, url: string, page: { attempts?: { via: FetchTrace["via"]; status: number; bytes: number; blocked: boolean; note: string }[] } | null): void {
  const attempts = page?.attempts ?? [{ via: "direct" as const, status: 0, bytes: 0, blocked: true, note: "no response" }];
  for (const attempt of attempts) ctx.fetches.push({ sourceId, url, ...attempt });
}

function report(ctx: Ctx, id: SourceId, emptyDetail: string): void {
  const count = uniqueCodes(ctx.hits.filter((hit) => hit.sourceId === id));
  const items = ctx.sources.find((source) => source.id === id)?.items ?? [];
  if (count || items.length) {
    const outcome = sourceOutcome(count, items, emptyDetail);
    setSource(ctx, id, outcome.status, outcome.detail, outcome.count);
    return;
  }
  const attempts = ctx.fetches.filter((item) => item.sourceId === id && !item.url.includes("/api/subreddits/"));
  const readable = attempts.some((item) => !item.blocked && item.bytes >= 800 && !item.url.startsWith("search:"));
  const blocked = attempts.some((item) => item.blocked);
  if (!readable && blocked) {
    const note = attempts.find((item) => item.blocked && item.note)?.note || "Blocked";
    setSource(ctx, id, "blocked", note, 0);
    return;
  }
  setSource(ctx, id, "nothing", emptyDetail, 0);
}

function noteChecked(ctx: Ctx, sourceId: SourceId, item: SourceCheck): void {
  const source = ctx.sources.find((entry) => entry.id === sourceId);
  if (!source || !item.url.startsWith("http")) return;
  const existing = source.items.find((entry) => entry.url === item.url);
  if (existing) {
    existing.codes = Math.max(existing.codes, item.codes);
    if (item.title) existing.title = item.title;
    if (item.date) existing.date = item.date;
    return;
  }
  if (source.items.length >= 20) return;
  source.items.push(item);
}

function notePage(ctx: Ctx, sourceId: SourceId, url: string, title: string, date: string | null): void {
  const codes = uniqueCodes(ctx.hits.filter((hit) => hit.sourceId === sourceId && hit.url === url));
  noteChecked(ctx, sourceId, { title: title || url, url, date, codes });
}

function finish(ctx: Ctx, hint: string): HuntResult {
  const codes = mergeHits(ctx.hits, (code) => getVotes(ctx.brand, code), ctx.brand);
  if (ctx.hintedType) {
    for (const card of codes) {
      if (card.type === "promo") card.type = ctx.hintedType;
    }
  }
  return {
    brand: ctx.brand,
    hint,
    codes,
    sources: ctx.sources,
    fetches: ctx.fetches,
    cached: false,
    cachedAt: null,
  };
}

function publish(ctx: Ctx): void {
  const codes = mergeHits(ctx.hits, (code) => getVotes(ctx.brand, code), ctx.brand);
  ctx.onEvent?.("results", { codes });
}

function setSource(ctx: Ctx, id: SourceId, status: SourceState["status"], detail: string, count: number): void {
  const source = ctx.sources.find((item) => item.id === id);
  if (!source) return;
  source.status = status;
  source.detail = detail;
  source.count = count;
  ctx.onEvent?.("source", source);
}

function dedupeSearch(hits: SearchHit[]): SearchHit[] {
  const map = new Map<string, SearchHit>();
  for (const hit of hits) {
    if (!hit.url.startsWith("http")) continue;
    if (!map.has(hit.url)) map.set(hit.url, hit);
  }
  return [...map.values()];
}

function hostIs(raw: string, hosts: string[]): boolean {
  try {
    const host = new URL(raw).hostname.replace(/^www\./, "");
    return hosts.some((item) => host === item || host.endsWith(`.${item}`));
  } catch {
    return false;
  }
}

function skipUrl(raw: string): boolean {
  if (hostIs(raw, SKIP_FETCH)) return true;
  return /\/(login|signin|sign-in|signup\/auth)\b/i.test(raw);
}

function privateSocial(raw: string): boolean {
  return /discord\.com\/channels\//i.test(raw) || /facebook\.com\/groups\//i.test(raw) || /instagram\.com\/accounts\//i.test(raw);
}

function isLoginWall(html: string): boolean {
  const title = html.match(/<title>([^<]{0,120})/i)?.[1] ?? "";
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  return /log in|sign in/i.test(title) && text.length < 1200 && !/\bcode\b/i.test(text);
}

function uniqueCodes(hits: RawHit[]): number {
  return new Set(hits.map((hit) => hit.code)).size;
}

function urlScore(url: string): number {
  let score = 0;
  if (/code|promo|coupon|bonus|referral/i.test(url)) score += 5;
  if (/help|faq|support|academy|blog/i.test(url)) score += 3;
  return score;
}

function monthYear(now = new Date()): string {
  const month = now.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  return `${month} ${now.getUTCFullYear()}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
