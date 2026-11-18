import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { hunt } from "../hunt.js";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "codehound-live-"));
delete process.env.GEMINI_API_KEY;
delete process.env.JINA_API_KEY;
delete process.env.CODEHOUND_FORCE_READER;

test("Freecash hunt returns the public sign-up codes from the official help page", async () => {
  const result = await hunt("Freecash", { fresh: true });
  const codes = result.codes.map((card) => card.code);
  console.log("FREECASH", codes.join(", "));
  console.log(result.sources.map((source) => `${source.id}:${source.status}:${source.detail}`).join(" | "));
  for (const code of ["X26", "IG26", "TT26", "YT26"]) {
    assert.ok(codes.includes(code), `missing ${code}; got ${codes.join(", ")}`);
  }
  assert.equal(codes.includes("100D"), false);
  const x26 = result.codes.find((card) => card.code === "X26");
  assert.ok(x26);
  assert.equal(x26.type, "signup");
  assert.equal(x26.scam, null);
  assert.ok(x26.confidence >= 60);
  assert.ok(x26.reasons.some((reason) => reason.startsWith("official")));
  assert.ok(x26.sources.some((source) => source.url.includes("freecash.com") && source.official));
  assert.equal(x26.sources.some((source) => source.url.startsWith("official:")), false);
  assert.match(x26.note, /new account/i);
  assert.equal(codes.some((code) => /FREECASH|MONTH|SHOW|TORQUE/.test(code)), false);
  assert.ok(result.sources.some((source) => source.id === "official" && source.status === "found"));
  const reddit = result.sources.find((source) => source.id === "reddit");
  assert.ok(reddit);
  assert.ok(reddit.items.length > 0);
  assert.ok(reddit.items.every((item) => item.url.startsWith("https://www.reddit.com/") && typeof item.codes === "number"));
  if (reddit.count > 0) assert.equal(reddit.status, "found");
  else assert.equal(reddit.detail, `checked ${reddit.items.length} posts, no codes`);
  assert.ok(result.fetches.some((item) => item.url.includes("where-freecash-codes") && item.via === "direct" && !item.blocked));
  assert.ok(result.fetches.some((item) => item.url.includes("arctic-shift") && !item.blocked));
  assert.equal(result.fetches.some((item) => item.via === "jina"), false);
});

test("DoorDash hunt does not return coupon-site teaser codes", async () => {
  const result = await hunt("DoorDash");
  const visible = result.codes.filter((card) => !card.scam);
  console.log("DOORDASH", result.codes.map((card) => `${card.code}${card.scam ? "*" : ""}:${card.type}:${card.reward}`).join(" | "));
  console.log(result.sources.map((source) => `${source.id}:${source.status}:${source.detail}`).join(" | "));
  assert.equal(result.sources.length, 7);
  assert.ok(result.sources.every((source) => ["found", "nothing", "failed", "blocked"].includes(source.status)));
  const teasers = new Set(["3MC", "7EC", "BZ6", "JU9", "Q26", "S30", "SI3", "T40"]);
  for (const card of result.codes) {
    const couponOnly = card.sources.length > 0 && card.sources.every((source) => source.sourceId === "coupons" || /couponfollow|retailmenot|simplycodes|dealdrop|slickdeals|dealspotr|knoji|groupon|offers\.com|hotdeals|coupons\.com|savings\.com|retailcoupons/i.test(source.url));
    assert.equal(card.code.length < 5 && couponOnly, false, card.code);
    if (teasers.has(card.code)) assert.equal(couponOnly, false, card.code);
    assert.match(card.code, /^[A-Z0-9-]{3,16}$/);
  }
  for (const card of visible) {
    assert.ok(card.sources.length >= 1);
    assert.match(card.sources[0].url, /^https?:\/\//);
    assert.equal(/OFF|SHOW|CODE|MONTH|HOUR|COPY/.test(card.code), false);
  }
});
