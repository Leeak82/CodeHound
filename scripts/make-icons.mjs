import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

function png(size, paint) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = paint(x, y, size);
      const i = row + 1 + x * 4;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
      raw[i + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc(body), 8 + data.length);
  return out;
}

function crc(buf) {
  let c = 0xffffffff;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function paint(x, y, size) {
  const px = x / size;
  const py = y / size;
  const dx = Math.max(0.08 - px, 0, px - 0.92);
  const dy = Math.max(0.08 - py, 0, py - 0.92);
  if (dx * dx + dy * dy > 0.08 * 0.08) return [0, 0, 0, 0];
  let r = 7;
  let g = 17;
  let b = 12;
  const glow = Math.hypot(px - 0.42, py - 0.58);
  if (glow < 0.46) {
    const t = 1 - glow / 0.46;
    r += Math.round(10 * t);
    g += Math.round(28 * t);
  }
  if (inEar(px, py, 0.30, 0.34) || inEar(px, py, 0.48, 0.32)) {
    r = 61;
    g = 255;
    b = 138;
  }
  if (Math.hypot(px - 0.4, py - 0.52) < 0.16) {
    r = 18;
    g = 48;
    b = 36;
  }
  if (Math.hypot(px - 0.34, py - 0.5) < 0.018 || Math.hypot(px - 0.46, py - 0.5) < 0.018) {
    r = 7;
    g = 17;
    b = 12;
  }
  if (Math.hypot(px - 0.4, py - 0.57) < 0.035 && py > 0.55) {
    r = 7;
    g = 17;
    b = 12;
  }
  const ring = Math.hypot(px - 0.62, py - 0.66);
  if (ring > 0.075 && ring < 0.11) {
    r = 217;
    g = 255;
    b = 232;
  }
  if (px > 0.68 && px < 0.78 && py > 0.72 && py < 0.84 && Math.abs(py - 0.72 - (px - 0.68) * 1.15) < 0.018) {
    r = 217;
    g = 255;
    b = 232;
  }
  return [r, g, b, 255];
}

function inEar(px, py, cx, cy) {
  const dx = (px - cx) / 0.07;
  const dy = (py - cy) / 0.1;
  return dx * dx + dy * dy < 1 && py < cy + 0.02;
}

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../public/icons");
mkdirSync(root, { recursive: true });
writeFileSync(path.join(root, "icon-512.png"), png(512, paint));
writeFileSync(path.join(root, "icon-192.png"), png(192, paint));
console.log("wrote icons");
