import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { hunt } from "../hunt.js";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "codehound-live-"));
delete process.env.GEMINI_API_KEY;

test("Freecash hunt returns the public sign-up codes", async () => {
  const result = await hunt("Freecash");
  const codes = result.codes.map((card) => card.code);
  console.log("FREECASh", codes.join(", "));
  console.log(result.sources.map((source) => `${source.id}:${source.status}:${source.detail}`).join(" | "));
  for (const code of ["X26", "IG26", "TT26", "YT26"]) {
    assert.ok(codes.includes(code), `missing ${code}; got ${codes.join(", ")}`);
  }
  const x26 = result.codes.find((card) => card.code === "X26");
  assert.ok(x26);
  assert.equal(x26.type, "signup");
  assert.equal(x26.scam, null);
  assert.ok(x26.confidence >= 60);
  assert.ok(x26.sources.some((source) => source.url.includes("freecash.com")));
  assert.match(x26.note, /new account/i);
  assert.equal(codes.some((code) => /FREECASH|MONTH|SHOW|TORQUE/.test(code)), false);
  assert.ok(result.sources.some((source) => source.id === "official" && source.status === "found"));
});

test("DoorDash hunt returns full public codes", async () => {
  const result = await hunt("DoorDash");
  const visible = result.codes.filter((card) => !card.scam);
  console.log("DOORDASH", result.codes.map((card) => `${card.code}${card.scam ? "*" : ""}:${card.type}:${card.reward}`).join(" | "));
  console.log(result.sources.map((source) => `${source.id}:${source.status}:${source.detail}`).join(" | "));
  assert.equal(result.sources.length, 7);
  assert.ok(result.sources.every((source) => ["found", "nothing", "failed"].includes(source.status)));
  assert.ok(visible.length >= 1, "expected at least one public DoorDash code");
  for (const card of visible) {
    assert.ok(card.sources.length >= 1);
    assert.match(card.sources[0].url, /^https?:\/\//);
    assert.match(card.code, /^[A-Z0-9-]{3,12}$/);
    assert.equal(/OFF|SHOW|CODE|MONTH|HOUR|COPY/.test(card.code), false);
  }
  assert.ok(visible.some((card) => card.code.length <= 5));
});
