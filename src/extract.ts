import * as cheerio from "cheerio";
import type { CodeType, RawHit, SourceId } from "./types.js";

const ALWAYS_BLOCK = new Set(
  `THE AND FOR YOU YOUR GET OFF NEW APP FREE CODE PROMO BONUS COUPON OFFER SAVE DEAL SALE HTTP HTTPS WWW HTML JSON NULL TRUE FALSE FAQ USA CEO API URL SEO PDF PNG JPG JPEG GIF SVG IOS TBD ETA ASAP DIY VIP PIN OTP SMS GPS USB CPU GPU RAM SSD WIFI NAV IMG SRC CSS DIV SPAN HREF REL ALT INC LLC LTD NOT ARE BUT CAN HAS WAS WERE THIS THAT WITH FROM HAVE WILL JUST ONLY MORE SIGN LOGIN EMAIL USER PASS WORD ACCOUNT REWARD REWARDS POINTS COINS CASH MONEY GIFT CARD SHOP STORE GAME GAMES VIDEO WATCH FOLLOW SHARE LIKE POST COMMENT EXPIRED INVALID WORKING WORKS TODAY MONTH YEAR WEEK DAILY HERE CLICK OPEN COPY LINK HOME BLOG HELP MENU NOTE STEP ITEM PAGE ABOUT CONTACT PRIVACY TERMS POLICY OFFICIAL CHANNEL SIGNUP REFER REFERRAL LOTTERY TICKET TICKETS BONUSES CODES USERS PLEASE ENTER REDEEM USING CURRENT UPDATED JANUARY FEBRUARY MARCH APRIL MAY JUNE JULY AUGUST SEPTEMBER OCTOBER NOVEMBER DECEMBER JAN FEB MAR APR JUN JUL AUG SEP OCT NOV DEC DISCORD INSTAGRAM TIKTOK YOUTUBE TWITTER FACEBOOK SNAPCHAT THREADS REDDIT SUPPORT PROFILE EARNINGS CREDIT BALANCE SURVEY SURVEYS PAYPAL ORDER ORDERS FIRST SHOW COUPON DETAILS SAVE WITH CODE OFFICIAL CODE USD EUR GBP CAD AUD NA OK ID UI UX RGB AMP TODO FIXME HD FHD UHD ANDROID APPLE GOOGLE BING CHROME FREESHIP SHIPPING LIMITED EXCLUSIVE ONLINE STOREWIDE ANY PURCHASE CHECKOUT MEMBER MEMBERS TRIAL DASHPASS BLACK FRIDAY`.split(
    /\s+/,
  ),
);

export interface ExtractMeta {
  url: string;
  title?: string;
  sourceId: SourceId;
  brand: string;
  official?: boolean;
  seenAt?: string | null;
  hintedType?: CodeType | null;
}

export function cleanBrand(input: string): string {
  return input
    .replace(/[^\p{L}\p{N}\s.&''-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

export function brandSlug(brand: string): string {
  return brand.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const MULTI_TLDS = new Set(["co.uk", "com.au", "co.nz", "com.br", "co.jp", "co.za", "com.mx", "co.in"]);

/** The site name is the brand, or the host is a subdomain of that site. */
export function isOfficialUrl(url: string, brand: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    const slug = brandSlug(brand);
    if (slug.length < 3 || !host) return false;
    return registrableLabel(host) === slug;
  } catch {
    return false;
  }
}

function registrableLabel(host: string): string {
  const parts = host.split(".").filter(Boolean);
  const lastTwo = parts.slice(-2).join(".");
  if (MULTI_TLDS.has(lastTwo) && parts.length >= 3) return parts[parts.length - 3];
  return parts.length >= 2 ? parts[parts.length - 2] : (parts[0] ?? "");
}

export function isPlausibleCode(raw: string, strong: boolean, brand: string, explicit = false): boolean {
  const code = raw.toUpperCase().replace(/[^A-Z0-9-]/g, "");
  if (code.length < 3 || code.length > 16) return false;
  if (!/^[A-Z0-9][A-Z0-9-]{1,14}[A-Z0-9]$/.test(code) && code.length >= 3) {
    if (!/^[A-Z0-9]{3,16}$/.test(code)) return false;
  }
  if (!/[A-Z]/.test(code)) return false;
  if (/[a-z]/.test(raw)) return false;
  if (ALWAYS_BLOCK.has(code)) return false;
  const slug = brandSlug(brand).toUpperCase();
  if (slug.length >= 4 && code.includes(slug)) return false;
  if (/(OFF|SHOW|CODE|MONTH|HOUR|YEAR|STAR|DETAIL|COUPON|PROMO|BONUS|SAVE|WITH|COPY)/.test(code) && code.length > 6) return false;
  if (/^20\d{2}$/.test(code) || /^19\d{2}$/.test(code)) return false;
  if (/^(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\d{2,4}$/.test(code)) return false;
  if (/^[A-Z]20\d{2}$/.test(code)) return false;
  if (/^(1080P|720P|480P|2160P|4K|8K)$/.test(code)) return false;
  if (/^\d{1,2}H$/.test(code)) return false;
  if (/^(.)\1{2,}$/.test(code.replace(/-/g, ""))) return false;
  if (slug && code === slug) return false;
  const hasDigit = /\d/.test(code);
  if (code.length <= 3 && !explicit) return false;
  if (!hasDigit && !explicit) return false;
  if (!hasDigit) {
    if (code.length < 4) return false;
    const letters = raw.replace(/[^A-Za-z]/g, "");
    const upper = letters.replace(/[^A-Z]/g, "").length;
    if (!letters || upper / letters.length < 0.6) return false;
  }
  if (code.length === 3 && !hasDigit) return false;
  return true;
}

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

export function isCouponSource(sourceId: string, url: string): boolean {
  if (sourceId === "coupons") return true;
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    return COUPON_HOSTS.some((name) => host === name || host.endsWith(`.${name}`));
  } catch {
    return false;
  }
}

export function extractFromHtml(html: string, meta: ExtractMeta): RawHit[] {
  const $ = cheerio.load(html);
  $("script,style,noscript,svg,iframe,canvas").remove();
  if (isCouponSource(meta.sourceId, meta.url)) stripCouponTeasers($);
  const title = meta.title || $("title").first().text().replace(/\s+/g, " ").trim();
  const seenAt = meta.seenAt ?? findDate($.html() ?? html);
  const official = meta.official ?? isOfficialUrl(meta.url, meta.brand);
  const hits: RawHit[] = [];

  $("table").each((_, table) => {
    const headers = $(table)
      .find("th")
      .map((__, th) => $(th).text().replace(/\s+/g, " ").trim())
      .get();
    const codeCol = headers.findIndex((h) => /code/i.test(h) && !/zip|area|country|barcode|passcode|qr/i.test(h));
    if (codeCol < 0) return;
    const headerType = typeFromLabel(headers[codeCol] + " " + nearestHeading($, table));
    const section = sectionText($, table);
    $(table)
      .find("tr")
      .each((__, tr) => {
        const cells = $(tr).find("td");
        if (cells.length <= codeCol) return;
        const cell = $(cells[codeCol]).text().replace(/\s+/g, " ").trim();
        const neighbor = $(tr)
          .find("td")
          .toArray()
          .some((cell, index) => index !== codeCol && $(cell).text().replace(/\s+/g, " ").trim().length > 1);
        pushCode(hits, cell, {
          ...meta,
          title,
          seenAt,
          official,
          sectionType: headerType,
          section,
          strong: true,
          explicit: neighbor,
        });
      });
  });

  $("[data-code]").each((_, el) => {
    if (isCouponSource(meta.sourceId, meta.url)) {
      const around = $(el).parent().text();
      if (isTeaserElement($, el) || nearRevealButton($, el) || !hasCodeCue(around)) return;
    }
    const node = $(el);
    const value = node.text().replace(/\s+/g, " ").trim();
    const around = node.parent().text();
    const at = around.indexOf(value);
    if (isMasked(value) || (at >= 0 && isMasked(around.slice(at, at + value.length + 2)))) return;
    let flat = "";
    let current = node.parent();
    for (let depth = 0; depth < 8 && current.length; depth += 1) {
      const text = current.text().replace(/\s+/g, " ");
      if (text.length > 70) {
        flat = text;
        break;
      }
      current = current.parent();
    }
    if (!flat) flat = around.replace(/\s+/g, " ");
    const atCode = flat.toUpperCase().indexOf(value.toUpperCase());
    const section = (atCode >= 0 ? flat.slice(atCode, atCode + 240) : flat.slice(0, 240)).trim();
    pushCode(hits, value, {
      ...meta,
      title,
      seenAt,
      official,
      sectionType: typeFromLabel(section),
      section,
      strong: true,
      explicit: true,
    });
  });

  const pageText = bodyText($);
  const buckets = splitByHeading(pageText);
  for (const bucket of buckets) {
    hits.push(
      ...extractFromText(bucket.text, {
        ...meta,
        title,
        seenAt,
        official,
        hintedType: bucket.type ?? meta.hintedType,
        section: bucket.text,
      }),
    );
  }
  if (!buckets.length) {
    hits.push(...extractFromText(pageText, { ...meta, title, seenAt, official }));
  }
  return dedupe(hits);
}

export function extractFromText(text: string, meta: ExtractMeta & { section?: string }): RawHit[] {
  const cleaned = stripNoise(text).replace(/\b(code|promo|coupon|bonus|referral|sign-up|signup|use|enter|redeem|apply|with)\b/gi, (word) => word.toLowerCase());
  if (!cleaned) return [];
  const seenAt = meta.seenAt ?? parseLooseDate(cleaned);
  const official = meta.official ?? isOfficialUrl(meta.url, meta.brand);
  const hits: RawHit[] = [];
  const patterns: Array<{ re: RegExp; explicit: boolean }> = [
    { re: /(?:use|enter|redeem|apply)\s+(?:the\s+)?code\s*:?\s*([A-Z0-9][A-Z0-9-]{1,12})/g, explicit: true },
    { re: /\b(?:promo|bonus|sign[\s-]?up|referral)\s+codes?\s*:?\s*([A-Z0-9][A-Z0-9-]{1,12})/g, explicit: true },
    { re: /\bwith\s+code\s+([A-Z0-9][A-Z0-9-]{1,12})\b/g, explicit: true },
    { re: /\bcode\s*:\s*([A-Z0-9][A-Z0-9-]{1,12})\b/g, explicit: true },
    { re: /\bcode\s+([A-Z0-9]*\d[A-Z0-9]{2,11})\b/g, explicit: true },
    { re: /\bcode\s+([A-Z]{4,12})\b/g, explicit: true },
  ];
  for (const pattern of patterns) {
    pattern.re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.re.exec(cleaned))) {
      if (followedByMask(cleaned, match.index, match[0].length)) continue;
      if (isCouponSource(meta.sourceId, meta.url) && revealAdjacent(cleaned, match.index, match[0].length)) continue;
      const index = match.index;
      const window = cleaned.slice(Math.max(0, index - 180), index + match[0].length + 180);
      pushCode(hits, match[1], {
        ...meta,
        seenAt,
        official,
        sectionType: typeFromLabel(window) ?? meta.hintedType ?? null,
        section: meta.section || window,
        strong: true,
        explicit: pattern.explicit,
        index,
        full: cleaned,
      });
    }
  }

  return dedupe(hits);
}

/** Keep model suggestions only when the code and the quote are verbatim in a fetched passage. */
export function acceptVerbatimCodes(
  raw: unknown,
  passages: { url: string; text: string; title?: string; sourceId: SourceId; official: boolean; seenAt: string | null }[],
  brand: string,
): RawHit[] {
  const parsed = unwrapJson(raw);
  const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && Array.isArray((parsed as { codes?: unknown }).codes) ? (parsed as { codes: unknown[] }).codes : [];
  const hits: RawHit[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const row = item as { code?: unknown; type?: unknown; reward?: unknown; url?: unknown; quote?: unknown };
    const code = typeof row.code === "string" ? row.code.trim() : "";
    const quote = typeof row.quote === "string" ? row.quote.trim() : "";
    const url = typeof row.url === "string" ? row.url : "";
    if (!code || !quote) continue;
    const passage = passages.find((p) => p.url === url) ?? passages.find((p) => p.text.toLowerCase().includes(quote.toLowerCase()));
    if (!passage) continue;
    if (!passage.text.toLowerCase().includes(quote.toLowerCase())) continue;
    if (!quote.toLowerCase().includes(code.toLowerCase())) continue;
    const explicit = new RegExp(String.raw`(?:(?:use|enter|redeem|apply)\s+(?:the\s+)?code|(?:promo|bonus|sign[\s-]?up|referral)\s+codes?|with\s+code|code)\s*:?\s*${code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\b`, "i").test(quote);
    if (!isPlausibleCode(code, true, brand, explicit)) continue;
    const type = isCodeType(row.type) ? row.type : typeFromLabel(quote) ?? "promo";
    hits.push({
      code: code.toUpperCase(),
      type,
      reward: typeof row.reward === "string" ? row.reward.slice(0, 80) : rewardFrom(passage.text),
      url: passage.url,
      title: passage.title || "",
      sourceId: "gemini",
      seenAt: passage.seenAt,
      official: passage.official,
      workedNotes: sentiment(quote).worked,
      expiredNotes: sentiment(quote).expired,
      excerpt: quote.slice(0, 280),
      labeledOfficial: /official code/i.test(quote),
    });
  }
  return dedupe(hits);
}

function pushCode(
  hits: RawHit[],
  raw: string,
  ctx: ExtractMeta & {
    seenAt: string | null;
    official: boolean;
    sectionType: CodeType | null;
    section: string;
    strong: boolean;
    explicit?: boolean;
    index?: number;
    full?: string;
  },
): void {
  const trimmed = raw.replace(/\s+/g, "").replace(/[.…]+$/g, "");
  if (isMasked(raw) || isMasked(trimmed)) return;
  if (!isPlausibleCode(trimmed, ctx.strong, ctx.brand, ctx.explicit === true)) return;
  const code = trimmed.toUpperCase();
  if (isCouponSource(ctx.sourceId, ctx.url) && code.length < 5) return;
  const section = ctx.section.replace(/\s+/g, " ").trim();
  const local = localWindow(ctx.full || section, code, ctx.index);
  const feelings = sentiment(local);
  const type = ctx.sectionType ?? typeFromLabel(local) ?? ctx.hintedType ?? "promo";
  hits.push({
    code,
    type,
    reward: rewardFrom(section) || rewardFrom(local),
    url: ctx.url,
    title: ctx.title || "",
    sourceId: ctx.sourceId,
    seenAt: ctx.seenAt,
    official: ctx.official,
    workedNotes: feelings.worked,
    expiredNotes: feelings.expired,
    excerpt: local.slice(0, 280),
    labeledOfficial: /official code/i.test(local),
  });
}

function localWindow(text: string, code: string, index?: number): string {
  const at = index ?? text.toUpperCase().indexOf(code.toUpperCase());
  if (at < 0) return text.slice(0, 280);
  return text.slice(Math.max(0, at - 140), at + code.length + 160);
}

function isMasked(value: string): boolean {
  return /…|\.{3}|•{2,}|●{2,}|\*{2,}/.test(value);
}

function stripCouponTeasers($: cheerio.CheerioAPI): void {
  for (const el of $("*").toArray()) {
    if (isTeaserElement($, el) || nearRevealButton($, el)) $(el).remove();
  }
}

function isTeaserElement($: cheerio.CheerioAPI, el: unknown): boolean {
  const node = $(el as never);
  const klass = node.attr("class") ?? "";
  if (/(?:^|[\s_-])(?:reveal|show[-_]?code|hidden|partial|blur|masked|teaser)(?:$|[\s_-])/i.test(klass)) return true;
  const attribs = (el as { attribs?: Record<string, string> }).attribs ?? {};
  for (const [key, value] of Object.entries(attribs)) {
    if (!key.startsWith("data-") || key === "data-code") continue;
    if (/reveal|partial|blur|masked|teaser|hidden|show-?code/i.test(key)) return true;
    if (/^(reveal|partial|blur|masked|teaser|hidden)$/i.test(value)) return true;
  }
  return false;
}

function nearRevealButton($: cheerio.CheerioAPI, el: unknown): boolean {
  const node = $(el as never);
  const parent = node.parent();
  const parentIsControl = parent.is("button, a, [role='button']");
  const parentLabel = parentIsControl ? parent.text().replace(/\s+/g, " ").trim() : "";
  if (/^(?:show|get)\s+code\b|^reveal(?:\s+code)?\b/i.test(parentLabel)) return true;
  const labels = node
    .siblings("button, a, [role='button']")
    .toArray()
    .map((button) => $(button).text().replace(/\s+/g, " ").trim());
  return labels.some((label) => /^(?:show|get)\s+code$|^reveal(?:\s+code)?$/i.test(label));
}

function hasCodeCue(text: string): boolean {
  return /(?:use|enter|redeem|apply)\s+(?:the\s+)?code\b|(?:promo|bonus|sign[\s-]?up|referral)\s+codes?\b|\bwith\s+code\b|\bcode\s*:/i.test(text);
}

function revealAdjacent(text: string, index: number, length: number): boolean {
  const near = text.slice(Math.max(0, index - 48), index + length + 48);
  return /\b(?:show|get)\s+code\b|\breveal(?:\s+code)?\b/i.test(near);
}

function followedByMask(text: string, index: number, length: number): boolean {
  const after = text.slice(index + length, index + length + 3);
  return after.startsWith("…") || after.startsWith("...") || after.startsWith("•");
}

export function rewardFrom(text: string): string {
  const patterns: Array<[RegExp, (match: RegExpMatchArray) => string]> = [
    [/account credit of\s+\$(\d+(?:\.\d{2})?)/i, (match) => `$${match[1]} account credit`],
    [/save\s+(\d{1,2}%)/i, (match) => `${match[1]} off`],
    [/(\d{1,2}%\s*off)/i, (match) => match[1]],
    [/save\s+\$(\d+(?:\.\d{2})?)/i, (match) => `$${match[1]} off`],
    [/(\$\d+(?:\.\d{2})?\s*off)\b/i, (match) => match[1]],
    [/(\$0\s+delivery(?:\s+fee)?)/i, (match) => match[1]],
    [/(\$\d+(?:\.\d{2})?\s*(?:welcome\s+)?(?:bonus|credit))/i, (match) => match[1]],
    [/(\d[\d,]*\s?(?:coins|points|credits|gems|diamonds))/i, (match) => match[1]],
    [/(free\s+(?:shipping|trial|delivery|month))/i, (match) => match[1]],
  ];
  let best: { at: number; text: string } | null = null;
  for (const [pattern, format] of patterns) {
    const match = text.match(pattern);
    if (!match || match.index === undefined) continue;
    if (!best || match.index < best.at) best = { at: match.index, text: cleanReward(format(match)) };
  }
  if (best) return best.text;
  if (/welcome bonus/i.test(text)) return "Welcome bonus";
  if (/lottery ticket/i.test(text)) return "Lottery tickets";
  if (/free shipping/i.test(text)) return "Free shipping";
  return "";
}

function cleanReward(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/(\d)%\s*off/gi, "$1% off")
    .replace(/\$(\d+(?:\.\d{2})?)\s*off/gi, (_, amount: string) => `$${amount} off`)
    .trim()
    .slice(0, 80);
}

export function typeFromLabel(value: string): CodeType | null {
  const text = value.toLowerCase();
  if (/sign[\s-]?up|signup/.test(text)) return "signup";
  if (/lottery|lotto|raffle/.test(text)) return "lottery";
  if (/referral|refer-a-friend|refer a friend/.test(text)) return "referral";
  if (/bonus/.test(text)) return "bonus";
  if (/coupon|checkout|% off|off your/.test(text)) return "coupon";
  if (/promo/.test(text)) return "promo";
  return null;
}

function sentiment(text: string): { worked: number; expired: number } {
  const negative = /didn.?t work|did not work|not work|doesn.?t work|not working|expired|invalid|no longer|but not for you|dead code|fake code|\bdead\b/i.test(text);
  const positive = /worked for me|it worked|still works|just worked|just used|confirmed/i.test(text);
  if (negative) return { worked: 0, expired: 1 };
  if (positive) return { worked: 1, expired: 0 };
  return { worked: 0, expired: 0 };
}

export function discoverCodeArticleUrls(html: string, pageUrl: string): string[] {
  const urls = new Set<string>();
  const base = new URL(pageUrl);
  const $ = cheerio.load(html);
  $("a[href]").each((_, anchor) => {
    const href = $(anchor).attr("href") ?? "";
    if (!href || href.startsWith("#") || href.startsWith("mailto:")) return;
    let absolute: URL;
    try {
      absolute = new URL(href, base);
    } catch {
      return;
    }
    if (absolute.hostname.replace(/^www\./, "") !== base.hostname.replace(/^www\./, "")) return;
    if (/code|promo|bonus|coupon|referral|lottery/i.test(absolute.pathname)) urls.add(absolute.href.split("#")[0]);
  });
  const text = html.replace(/\\u0026/g, "&").replace(/\\"/g, '"');
  const article = /"title":"([^"]{0,160})","slug":"([a-z0-9-]{3,80})"/g;
  let match: RegExpExecArray | null;
  while ((match = article.exec(text))) {
    const title = match[1];
    const slug = match[2];
    if (!/code|promo|bonus|coupon|referral|lottery/i.test(`${title} ${slug}`)) continue;
    const before = text.slice(Math.max(0, match.index - 4000), match.index);
    const topic = [...before.matchAll(/"slug":"([a-z0-9-]+)","articles"/g)].pop()?.[1];
    const category = [...before.matchAll(/"slug":"([a-z0-9-]+)","topics"/g)].pop()?.[1];
    if (!topic || !category || topic === slug) continue;
    urls.add(new URL(`/academy/en/support/${category}/${topic}/${slug}`, base.origin).href);
  }
  return [...urls];
}

function stripNoise(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\bwww\.\S+/gi, " ")
    .replace(/@[\w.]+/g, " ")
    .replace(/\br\/[\w]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function bodyText($: cheerio.CheerioAPI): string {
  $("br").replaceWith("\n");
  $("body *").append(" ");
  $("p,h1,h2,h3,li,tr,figcaption").append("\n");
  return $("body").text().replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
}

function splitByHeading(text: string): { type: CodeType | null; text: string }[] {
  const lines = text.split(/\n/);
  const buckets: { type: CodeType | null; text: string }[] = [];
  let current: { type: CodeType | null; lines: string[] } | null = null;
  for (const line of lines) {
    const heading = line.trim();
    const asHeading = heading.length > 0 && heading.length < 80 && typeFromLabel(heading) && heading.split(" ").length <= 8;
    if (asHeading && /code|bonus|referral|lottery|coupon|promo|sign/i.test(heading)) {
      if (current) buckets.push({ type: current.type, text: current.lines.join("\n") });
      current = { type: typeFromLabel(heading), lines: [heading] };
    } else if (current) current.lines.push(line);
    else {
      current = { type: null, lines: [line] };
    }
  }
  if (current) buckets.push({ type: current.type, text: current.lines.join("\n") });
  return buckets.filter((b) => b.text.trim().length > 0);
}

function nearestHeading($: cheerio.CheerioAPI, table: unknown): string {
  const h2 = $(table as never).prevAll("h1,h2,h3").first();
  return h2.text().replace(/\s+/g, " ").trim();
}

function sectionText($: cheerio.CheerioAPI, table: unknown): string {
  const start = $(table as never).prevAll("h1,h2,h3").first();
  if (!start.length) return $(table as never).text();
  const chunks = [start.text()];
  let el = start.next();
  let headings = 0;
  while (el.length && headings < 2) {
    if (el.is("h1,h2,h3")) headings += 1;
    if (headings >= 2) break;
    chunks.push(el.text());
    el = el.next();
  }
  return chunks.join("\n");
}

export function findDate(html: string): string | null {
  const modified = html.match(/"dateModified"\s*:\s*"([^"]+)"/i) || html.match(/"datePublished"\s*:\s*"([^"]+)"/i);
  if (modified) {
    const parsed = Date.parse(modified[1]);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  const meta = html.match(/property="article:modified_time"\s+content="([^"]+)"/i);
  if (meta) {
    const parsed = Date.parse(meta[1]);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return parseLooseDate(html.replace(/<[^>]+>/g, " ").slice(0, 4000));
}

export function parseLooseDate(text: string, now = new Date()): string | null {
  const iso = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (iso) {
    const parsed = Date.parse(`${iso[1]}T00:00:00Z`);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  const rel = text.match(/\b(\d+)\s+(minute|hour|day|week)s?\s+ago\b/i);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const ms = unit.startsWith("minute") ? n * 60_000 : unit.startsWith("hour") ? n * 3_600_000 : unit.startsWith("day") ? n * 86_400_000 : n * 7 * 86_400_000;
    return new Date(now.getTime() - ms).toISOString();
  }
  const months = "january february march april may june july august september october november december";
  const named = text.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/i);
  if (named) {
    const month = monthIndex(named[1]);
    if (month >= 0) return new Date(Date.UTC(Number(named[3]), month, Number(named[2]))).toISOString();
  }
  const monthYear = text.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})\b/i);
  if (monthYear) {
    const idx = months.split(" ").indexOf(monthYear[1].toLowerCase());
    if (idx >= 0) return new Date(Date.UTC(Number(monthYear[2]), idx, 1)).toISOString();
  }
  return null;
}

function monthIndex(name: string): number {
  const short = name.slice(0, 3).toLowerCase();
  return ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(short);
}

function dedupe(hits: RawHit[]): RawHit[] {
  const map = new Map<string, RawHit>();
  for (const hit of hits) {
    const key = `${hit.code}|${hit.url}|${hit.sourceId}`;
    const prev = map.get(key);
    if (!prev || hit.excerpt.length > prev.excerpt.length) map.set(key, hit);
  }
  return [...map.values()];
}

function isCodeType(value: unknown): value is CodeType {
  return value === "signup" || value === "bonus" || value === "coupon" || value === "referral" || value === "lottery" || value === "promo";
}

function unwrapJson(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const text = fenced ? fenced[1] : raw;
  const start = text.indexOf("{");
  const list = text.indexOf("[");
  const at = start >= 0 && (list < 0 || start < list) ? start : list;
  if (at < 0) return null;
  const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (end < at) return null;
  try {
    return JSON.parse(text.slice(at, end + 1));
  } catch {
    return null;
  }
}
