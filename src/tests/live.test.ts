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
  assert.equal(result.sources.find((source) => source.id === "reddit")?.status, "found");
  assert.ok(result.fetches.some((item) => item.url.includes("where-freecash-codes") && item.via === "direct" && !item.blocked));
  assert.ok(result.fetches.some((item) => item.url.includes("arctic-shift") && !item.blocked));
  assert.equal(result.fetches.some((item) => item.via === "jina"), false);
});

test("DoorDash hunt returns full public codes", async () => {
  const result = await hunt("DoorDash");
  const visible = result.codes.filter((card) => !card.scam);
  console.log("DOORDASH", result.codes.map((card) => `${card.code}${card.scam ? "*" : ""}:${card.type}:${card.reward}`).join(" | "));
  console.log(result.sources.map((source) => `${source.id}:${source.status}:${source.detail}`).join(" | "));
  assert.equal(result.sources.length, 7);
  assert.ok(result.sources.every((source) => ["found", "nothing", "failed", "blocked"].includes(source.status)));
  assert.ok(visible.length >= 1, "expected at least one public DoorDash code");
  for (const card of visible) {
    assert.ok(card.sources.length >= 1);
    assert.match(card.sources[0].url, /^https?:\/\//);
    assert.match(card.code, /^[A-Z0-9-]{3,12}$/);
    assert.equal(/OFF|SHOW|CODE|MONTH|HOUR|COPY/.test(card.code), false);
  }
  assert.ok(visible.some((card) => card.code.length <= 5));
});
