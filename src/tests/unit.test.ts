import assert from "node:assert/strict";
import test from "node:test";
import { acceptVerbatimCodes, discoverCodeArticleUrls, extractFromHtml, extractFromText, isOfficialUrl, isPlausibleCode } from "../extract.js";
import { parseArcticRows } from "../hunt.js";
import { looksBlocked } from "../net.js";
import { cacheTtlFor } from "../store.js";
import { decodeBingUrl, parseBing } from "../net.js";
import { mergeHits, scoreCard } from "../score.js";
import { scamReasons } from "../scam.js";
import { parseVision } from "../gemini.js";
import type { CodeCard, RawHit } from "../types.js";

const HELP = `
<article>
  <h2>Sign-Up Codes</h2>
  <p>Sign-up codes are entered when you first create a Freecash account. The bonus is account credit of $10.</p>
  <table>
    <tr><th>Channel</th><th>Sign-Up Code</th></tr>
    <tr><td>Instagram</td><td>IG26</td></tr>
    <tr><td>X (Twitter)</td><td>X26</td></tr>
    <tr><td>TikTok</td><td>TT26</td></tr>
    <tr><td>YouTube</td><td>YT26</td></tr>
    <tr><td>Threads</td><td>-</td></tr>
  </table>
  <p>Updated Nov 9, 2026. Use code HTTPS and the year 2026 is not a code. Price $10.</p>
  <h2>Bonus Codes</h2>
  <p>Bonus codes go in Rewards → Bonuses → Bonus Codes.</p>
</article>`;

test("extracts official sign-up codes and drops junk", () => {
  const hits = extractFromHtml(HELP, {
    url: "https://freecash.com/academy/en/support/account/rewards/where-freecash-codes",
    sourceId: "official",
    brand: "Freecash",
  });
  const codes = hits.map((hit) => hit.code).sort();
  for (const code of ["X26", "IG26", "TT26", "YT26"]) assert.ok(codes.includes(code), codes.join(","));
  assert.equal(codes.includes("HTTPS"), false);
  assert.equal(codes.includes("2026"), false);
  const x26 = hits.find((hit) => hit.code === "X26");
  assert.equal(x26?.type, "signup");
  assert.equal(x26?.official, true);
  assert.match(x26?.reward ?? "", /\$10/);
});

test("ignores masked codes and keeps a fully posted coupon", () => {
  const html = `
    <p>Official Code 30% OFF <span data-code="true">Q26</span> Save 30% on your first order.</p>
    <p>Show code <span class="code">3X9CZ…</span></p>
    <p>Use code 3X9CZ… for a discount.</p>`;
  const hits = extractFromHtml(html, { url: "https://couponfollow.com/site/doordash.com", sourceId: "coupons", brand: "DoorDash" });
  assert.deepEqual(hits.map((hit) => hit.code), ["Q26"]);
  assert.match(hits[0].reward, /30%/);
});

test("flags unrealistic bonuses, generators, and password asks", () => {
  const rich = extractFromText("Use code RICH500 for a $500 bonus, no deposit.", {
    url: "https://example.com/scam",
    sourceId: "web",
    brand: "Freecash",
  });
  assert.equal(rich[0]?.code, "RICH500");
  assert.ok(scamReasons(rich[0].excerpt).some((reason) => /unrealistic/i.test(reason)));

  const generated = extractFromText("This code generator says use code SAVE10 instantly.", {
    url: "https://example.com/gen",
    sourceId: "web",
    brand: "Temu",
  });
  assert.equal(generated[0]?.code, "SAVE10");
  assert.ok(scamReasons(generated[0].excerpt).some((reason) => /generator/i.test(reason)));

  const password = extractFromText("Enter your password to unlock code GETCASH on this site.", {
    url: "https://example.com/phish",
    sourceId: "web",
    brand: "Temu",
  });
  assert.ok(scamReasons(password[0]?.excerpt ?? "").some((reason) => /password/i.test(reason)));
  assert.equal(isPlausibleCode("FREE", true, "Temu"), false);
  assert.equal(isPlausibleCode("2026", true, "Temu"), false);
});

test("scores official recent codes above a single coupon-site code", () => {
  const official = card({
    code: "X26",
    official: true,
    sourceCount: 1,
    lastSeen: new Date().toISOString(),
  });
  const coupon = card({
    code: "Q26",
    official: false,
    sourceCount: 1,
    lastSeen: new Date().toISOString(),
  });
  assert.ok(scoreCard(official, true, false) > scoreCard(coupon, false, false));
  assert.ok(scoreCard(official, true, false) >= 70);
});

test("merges duplicate codes and counts separate sites", () => {
  const hits: RawHit[] = [
    hit("X26", "https://freecash.com/a", "official", true),
    hit("X26", "https://www.reddit.com/r/FreeCash/comments/1", "reddit", false),
  ];
  const [merged] = mergeHits(hits, () => ({ worked: 2, failed: 0 }));
  assert.equal(merged.sourceCount, 2);
  assert.equal(merged.workedVotes, 2);
  assert.equal(merged.sources.length, 2);
  assert.match(merged.note, /new account/i);
});

test("user votes lower confidence when a code fails", () => {
  const fresh = card({ code: "X26", official: true, sourceCount: 1, lastSeen: new Date().toISOString(), failedVotes: 0 });
  const tired = { ...fresh, failedVotes: 3 };
  assert.ok(scoreCard(tired, true, false) < scoreCard(fresh, true, false));
});

test("decodes Bing redirect URLs", () => {
  const packed = "a1aHR0cHM6Ly9mcmVlY2FzaC5jb20vYWNhZGVteS9lbi9zdXBwb3J0L2FjY291bnQvcmV3YXJkcy93aGVyZS1mcmVlY2FzaC1jb2Rlcw";
  const href = `https://www.bing.com/ck/a?!&&p=abc&u=${packed}&ntb=1`;
  assert.equal(decodeBingUrl(href), "https://freecash.com/academy/en/support/account/rewards/where-freecash-codes");
  const html = `<ol><li class="b_algo"><h2><a href="${href}">Where to find codes</a></h2><p>Use code X26 today.</p></li></ol>`;
  const parsed = parseBing(html);
  assert.equal(parsed[0]?.url, "https://freecash.com/academy/en/support/account/rewards/where-freecash-codes");
  assert.match(parsed[0]?.snippet ?? "", /X26/);
});

test("classifies challenge pages separately from a real article", () => {
  assert.equal(looksBlocked(403, "blocked").blocked, true);
  assert.equal(looksBlocked(429, "").note, "HTTP 429");
  assert.equal(looksBlocked(200, "<html>Just a moment... cf-browser-verification</html>").note, "challenge page");
  assert.equal(looksBlocked(200, "<html><table><td>IG26</td></table></html>").blocked, false);
});

test("does not keep an all-blocked empty hunt in the long cache", () => {
  const empty = cacheTtlFor({
    brand: "Freecash",
    hint: "",
    codes: [],
    fetches: [],
    cached: false,
    cachedAt: null,
    sources: [
      { id: "official", label: "Official pages", status: "blocked", detail: "HTTP 403", count: 0 },
      { id: "gemini", label: "Gemini", status: "nothing", detail: "Not configured", count: 0 },
    ],
  });
  assert.equal(empty, null);
  const missed = cacheTtlFor({
    brand: "Freecash",
    hint: "",
    codes: [],
    fetches: [],
    cached: false,
    cachedAt: null,
    sources: [{ id: "official", label: "Official pages", status: "nothing", detail: "No codes", count: 0 }],
  });
  assert.equal(missed, 10 * 60 * 1000);
});

test("official bonus follows the real page URL", () => {
  const votes = () => ({ worked: 0, failed: 0 });
  const [real] = mergeHits([hit("X26", "https://freecash.com/academy/en/support", "official", false)], votes, "Freecash");
  assert.ok(real.reasons.some((reason) => reason.startsWith("official")));
  assert.equal(real.sources[0]?.official, true);
  const [keyed] = mergeHits([hit("X26", "official:freecash.com", "official", true)], votes, "Freecash");
  assert.equal(keyed.reasons.some((reason) => reason.startsWith("official")), false);
  const [copycat] = mergeHits([hit("X26", "https://freecashcodes.net/promo", "web", true)], votes, "Freecash");
  assert.equal(copycat.sources[0]?.official, false);
});

test("short codes need an explicit cue and copycat hosts are not official", () => {
  assert.equal(isOfficialUrl("https://freecash.com/academy/en/support/account/rewards/where-freecash-codes", "Freecash"), true);
  assert.equal(isOfficialUrl("https://help.freecash.com/article", "Freecash"), true);
  assert.equal(isOfficialUrl("https://freecashcodes.net/promo", "Freecash"), false);
  const table = extractFromHtml(`<table><tr><th>Channel</th><th>Sign-Up Code</th></tr><tr><td>X (Twitter)</td><td>X26</td></tr></table>`, {
    url: "https://freecash.com/help",
    sourceId: "official",
    brand: "Freecash",
  });
  assert.equal(table.some((item) => item.code === "X26"), true);
  assert.equal(extractFromText("code: X26", { url: "https://freecash.com/help", sourceId: "official", brand: "Freecash" }).some((item) => item.code === "X26"), true);
  assert.equal(extractFromText("Bonus Code - 100D", { url: "https://www.youtube.com/watch?v=abc", sourceId: "youtube", brand: "Freecash" }).some((item) => item.code === "100D"), false);
  assert.equal(extractFromText("use code WELCOME", { url: "https://example.com/offer", sourceId: "web", brand: "Temu" }).some((item) => item.code === "WELCOME"), true);
  assert.equal(extractFromText("WELCOME is the word on the button", { url: "https://example.com/offer", sourceId: "web", brand: "Temu" }).some((item) => item.code === "WELCOME"), false);
  const articles = discoverCodeArticleUrls(
    '{"slug":"account","topics":[{"slug":"rewards","articles":[{"title":"Where to Find Codes","slug":"where-freecash-codes"}]}]}',
    "https://freecash.com/academy/en/support",
  );
  assert.ok(articles.some((url) => url.endsWith("/academy/en/support/account/rewards/where-freecash-codes")));
});

test("reads Arctic Shift post rows", () => {
  const rows = parseArcticRows(JSON.stringify({
    data: [{ title: "Code referral", selftext: "use code X26", permalink: "/r/FreeCash/comments/1xym8c5/code_referral/", created_utc: 1794926672 }],
  }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.permalink, "/r/FreeCash/comments/1xym8c5/code_referral/");
  assert.equal(rows[0]?.title, "Code referral");
  assert.equal(rows[0]?.createdUtc, 1794926672);
});

test("parses a vision response and drops invented codes", () => {
  const vision = parseVision('```json\n{"brand":"Freecash","codeType":"bonus","hints":"Social icons under the field"}\n```');
  assert.equal(vision.brand, "Freecash");
  assert.equal(vision.codeType, "bonus");
  const kept = acceptVerbatimCodes(
    { codes: [{ code: "X26", type: "signup", reward: "$10", url: "https://freecash.com/help", quote: "Sign-up code X26" }, { code: "NOPE9", type: "bonus", reward: "", url: "https://freecash.com/help", quote: "code NOPE9" }] },
    [{ url: "https://freecash.com/help", text: "The sign-up code X26 is on this page.", title: "Help", sourceId: "official", official: true, seenAt: null }],
    "Freecash",
  );
  assert.deepEqual(kept.map((item) => item.code), ["X26"]);
});

function hit(code: string, url: string, sourceId: RawHit["sourceId"], official: boolean): RawHit {
  return {
    code,
    type: "signup",
    reward: "$10 account credit",
    url,
    title: code,
    sourceId,
    seenAt: "2026-11-09T00:00:00.000Z",
    official,
    workedNotes: 0,
    expiredNotes: 0,
    excerpt: `Sign-up code ${code} for a new account`,
    labeledOfficial: false,
  };
}

function card(partial: Partial<CodeCard> & { official?: boolean }): CodeCard {
  return {
    code: partial.code ?? "X26",
    type: "signup",
    reward: "$10 account credit",
    sources: [
      {
        url: partial.official === false ? "https://couponfollow.com/site/doordash.com" : "https://freecash.com/help",
        title: "source",
        sourceId: partial.official === false ? "coupons" : "official",
        official: partial.official !== false,
      },
    ],
    firstSeen: partial.lastSeen ?? null,
    lastSeen: partial.lastSeen ?? null,
    ageLabel: "Found today",
    sourceCount: partial.sourceCount ?? 1,
    confidence: 0,
    reasons: [],
    scam: null,
    workedVotes: partial.workedVotes ?? 0,
    failedVotes: partial.failedVotes ?? 0,
    workedNotes: 0,
    expiredNotes: 0,
    note: "Sign-up codes only work when creating a new account.",
  };
}
