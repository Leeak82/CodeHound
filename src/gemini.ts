import { acceptVerbatimCodes } from "./extract.js";
import type { CodeType, RawHit, SourceId, VisionResult } from "./types.js";

const DEFAULT_MODEL = "gemini-2.5-flash";

export class GeminiConfigError extends Error {
  status = 503;
  code = "NO_GEMINI";
}

export function geminiModel(): string {
  return process.env.GEMINI_MODEL || DEFAULT_MODEL;
}

export function parseVision(text: string): VisionResult {
  const parsed = unwrap(text) as { brand?: unknown; codeType?: unknown; hints?: unknown } | null;
  const brand = typeof parsed?.brand === "string" ? parsed.brand.replace(/\s+/g, " ").trim().slice(0, 60) : "";
  const codeType = isType(parsed?.codeType) ? parsed.codeType : null;
  const hints = typeof parsed?.hints === "string" ? parsed.hints.replace(/\s+/g, " ").trim().slice(0, 180) : "";
  return { brand, codeType, hints };
}

export async function analyzeScreenshot(imageBase64: string, mimeType: string, signal?: AbortSignal): Promise<VisionResult> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new GeminiConfigError("Screenshot reading needs GEMINI_API_KEY on the server.");
  const text = await generate(
    {
      contents: [
        {
          role: "user",
          parts: [
            {
              text: "Read this screenshot of an app, game, or store redeem, checkout, or sign-up screen. Return JSON only: {\"brand\":\"\",\"codeType\":\"signup|bonus|coupon|referral|lottery|promo|unknown\",\"hints\":\"\"}. brand is the app or store name. codeType is the kind of code the field is asking for. hints is a short note about where the screen says codes come from, such as social icons. Do not return a promo code. Do not include personal data or location.",
            },
            { inlineData: { mimeType, data: imageBase64 } },
          ],
        },
      ],
      generationConfig: { temperature: 0.1 },
    },
    key,
    signal,
  );
  return parseVision(text);
}

export async function discoverUrls(brand: string, signal: AbortSignal): Promise<string[]> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return [];
  const text = await generate(
    {
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Find public web pages that currently list promo, bonus, sign-up, referral, lottery, or coupon codes for "${brand}". Return JSON only: {"urls":["https://..."]}. Only include http(s) URLs from public pages. Do not invent URLs or codes. Do not include login-only pages or private groups.`,
            },
          ],
        },
      ],
      tools: [{ googleSearch: {} }],
    },
    key,
    signal,
  );
  const parsed = unwrap(text) as { urls?: unknown } | null;
  const urls = Array.isArray(parsed?.urls) ? parsed.urls.filter((url): url is string => typeof url === "string" && url.startsWith("http")) : [];
  return urls.slice(0, 4);
}

export async function extractVerbatim(
  brand: string,
  passages: { url: string; text: string; title?: string; sourceId: SourceId; official: boolean; seenAt: string | null }[],
  signal: AbortSignal,
): Promise<RawHit[]> {
  const key = process.env.GEMINI_API_KEY;
  if (!key || !passages.length) return [];
  const packed = passages
    .slice(0, 4)
    .map((p) => `URL: ${p.url}\n${p.text.slice(0, 3500)}`)
    .join("\n\n---\n\n");
  const text = await generate(
    {
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Extract promo codes that are explicitly written in the source text for ${brand}. Return JSON only: {"codes":[{"code":"","type":"signup|bonus|coupon|referral|lottery|promo","reward":"","url":"","quote":""}]}. The code and the quote must appear verbatim in the source. Do not guess, complete, or generate codes. Skip masked codes that end in an ellipsis.\n\n${packed}`,
            },
          ],
        },
      ],
      generationConfig: { temperature: 0 },
    },
    key,
    signal,
  );
  return acceptVerbatimCodes(text, passages, brand);
}

async function generate(body: unknown, key: string, signal?: AbortSignal): Promise<string> {
  const models = [geminiModel(), "gemini-2.0-flash"].filter((model, index, list) => list.indexOf(model) === index);
  let last = "Gemini request failed";
  for (const model of models) {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.status === 404) {
      last = "model not found";
      continue;
    }
    if (!response.ok) throw new Error("Gemini request failed");
    const data = (await response.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("\n") ?? "";
    if (text) return text;
    last = "empty response";
  }
  throw new Error(last);
}

function unwrap(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const startObj = body.indexOf("{");
  const startArr = body.indexOf("[");
  const start = startObj >= 0 && (startArr < 0 || startObj < startArr) ? startObj : startArr;
  if (start < 0) return null;
  const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

function isType(value: unknown): value is CodeType {
  return value === "signup" || value === "bonus" || value === "coupon" || value === "referral" || value === "lottery" || value === "promo";
}
