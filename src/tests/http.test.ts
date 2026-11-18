import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../server.js";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "codehound-http-"));
delete process.env.GEMINI_API_KEY;

test("health, validation, screenshot, and votes", async () => {
  const app = createApp();
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const base = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  const missing = await fetch(`${base}/api/search?q=`);
  assert.equal(missing.status, 400);
  const debug = await fetch(`${base}/api/debug/sources?q=`);
  assert.equal(debug.status, 400);

  const shot = await fetch(`${base}/api/screenshot`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mimeType: "image/png", image: "a".repeat(40) }),
  });
  assert.equal(shot.status, 503);
  const shotBody = (await shot.json()) as { code?: string };
  assert.equal(shotBody.code, "NO_GEMINI");

  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /CodeHound/);
  assert.match(html, /buymeacoffee\.com\/anthonyleebuilds/);

  const vote = await fetch(`${base}/api/votes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ brand: "Freecash", code: "X26", vote: "worked" }),
  });
  assert.equal(vote.status, 200);
  const voted = (await vote.json()) as { worked: number };
  assert.equal(voted.worked, 1);

  const manifest = await fetch(`${base}/manifest.webmanifest`);
  assert.equal(manifest.status, 200);
  await close(server);
});

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
