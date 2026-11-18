import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { explainScore } from "./score.js";
import type { HuntResult } from "./types.js";

interface VoteRow {
  worked: number;
  failed: number;
}

interface SearchRow {
  label: string;
  slug: string;
  count: number;
  at: string;
}

interface CacheRow {
  at: number;
  expiresAt?: number;
  result: HuntResult;
}

interface Database {
  votes: Record<string, VoteRow>;
  searches: Record<string, SearchRow>;
  cache: Record<string, CacheRow>;
}

let memory: Database | null = null;
let chain: Promise<void> = Promise.resolve();
let supabaseNote = false;

function empty(): Database {
  return { votes: {}, searches: {}, cache: {} };
}

function dir(): string {
  return process.env.DATA_DIR || path.join(process.cwd(), "data");
}

function file(): string {
  return path.join(dir(), "store.json");
}

function load(): Database {
  if (memory) return memory;
  try {
    if (existsSync(file())) memory = JSON.parse(readFileSync(file(), "utf8")) as Database;
  } catch {
    memory = null;
  }
  memory ??= empty();
  memory.votes ??= {};
  memory.searches ??= {};
  memory.cache ??= {};
  return memory;
}

function save(db: Database): void {
  mkdirSync(dir(), { recursive: true });
  writeFileSync(file(), JSON.stringify(db));
  memory = db;
}

function update<T>(fn: (db: Database) => T): Promise<T> {
  const run = chain.then(() => {
    const db = load();
    const value = fn(db);
    save(db);
    return value;
  });
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function voteKey(brand: string, code: string): string {
  return `${brand.trim().toLowerCase()}|${code.trim().toUpperCase()}`;
}

export async function clearCache(slug: string): Promise<void> {
  await update((db) => {
    delete db.cache[slug];
  });
}

export function getVotes(brand: string, code: string): VoteRow {
  return load().votes[voteKey(brand, code)] ?? { worked: 0, failed: 0 };
}

export async function applyVote(brand: string, code: string, next: "worked" | "failed", previous?: "worked" | "failed" | null): Promise<VoteRow> {
  const row = await update((db) => {
    const key = voteKey(brand, code);
    const current = db.votes[key] ?? { worked: 0, failed: 0 };
    if (previous && previous !== next) {
      if (previous === "worked") current.worked = Math.max(0, current.worked - 1);
      else current.failed = Math.max(0, current.failed - 1);
    }
    if (previous !== next) {
      if (next === "worked") current.worked += 1;
      else current.failed += 1;
    }
    db.votes[key] = current;
    const cached = db.cache[brand.trim().toLowerCase()];
    if (cached) {
      for (const card of cached.result.codes) {
        if (card.code === code.toUpperCase()) {
          card.workedVotes = current.worked;
          card.failedVotes = current.failed;
          const explained = explainScore(card, card.sources.some((source) => source.official), false);
          card.confidence = explained.score;
          card.reasons = explained.reasons;
        }
      }
    }
    return current;
  });
  void pushVote(brand, code, row);
  return row;
}

export async function addVote(brand: string, code: string, vote: "worked" | "failed"): Promise<VoteRow> {
  return applyVote(brand, code, vote, null);
}

export async function rememberSearch(label: string, slug: string): Promise<void> {
  await update((db) => {
    const current = db.searches[slug] ?? { label, slug, count: 0, at: new Date().toISOString() };
    current.count += 1;
    current.at = new Date().toISOString();
    current.label = label;
    db.searches[slug] = current;
  });
}

export function trending(limit = 8): SearchRow[] {
  return Object.values(load().searches)
    .sort((a, b) => b.count - a.count || b.at.localeCompare(a.at))
    .slice(0, limit);
}

export const EMPTY_CACHE_MS = 10 * 60 * 1000;

export function cacheTtlFor(result: HuntResult): number | null {
  const live = result.sources.filter((source) => !(source.id === "gemini" && source.detail === "Not configured"));
  const allDown = live.length > 0 && live.every((source) => source.status === "failed" || source.status === "blocked");
  if (allDown) return null;
  if (result.codes.length === 0) return EMPTY_CACHE_MS;
  return cacheTtlMs();
}

export function getCache(slug: string): HuntResult | null {
  const row = load().cache[slug];
  if (!row) return null;
  const expiresAt = row.expiresAt ?? row.at + cacheTtlMs();
  if (Date.now() > expiresAt) return null;
  return { ...row.result, cached: true, cachedAt: new Date(row.at).toISOString() };
}

export async function setCache(slug: string, result: HuntResult, ttlMs: number): Promise<void> {
  const at = Date.now();
  await update((db) => {
    db.cache[slug] = { at, expiresAt: at + ttlMs, result: { ...result, cached: false } };
  });
  void pushCache(slug, result);
}

export function cacheTtlMs(): number {
  const seconds = Number(process.env.CACHE_TTL_SECONDS ?? 7200);
  const clamped = Number.isFinite(seconds) ? Math.min(10_800, Math.max(3600, seconds)) : 7200;
  return clamped * 1000;
}

function supabaseHeaders(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url, key };
}

async function pushVote(brand: string, code: string, row: VoteRow): Promise<void> {
  const supabase = supabaseHeaders();
  if (!supabase) return;
  await fetch(`${supabase.url}/rest/v1/codehound_votes`, {
    method: "POST",
    headers: {
      apikey: supabase.key,
      authorization: `Bearer ${supabase.key}`,
      "content-type": "application/json",
      prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify([{ brand: brand.toLowerCase(), code: code.toUpperCase(), worked: row.worked, failed: row.failed }]),
  }).catch(() => noteSupabase());
}

async function pushCache(slug: string, result: HuntResult): Promise<void> {
  const supabase = supabaseHeaders();
  if (!supabase) return;
  await fetch(`${supabase.url}/rest/v1/codehound_cache`, {
    method: "POST",
    headers: {
      apikey: supabase.key,
      authorization: `Bearer ${supabase.key}`,
      "content-type": "application/json",
      prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify([{ brand: slug, payload: result, cached_at: new Date().toISOString() }]),
  }).catch(() => noteSupabase());
}

export async function hydrateFromSupabase(): Promise<void> {
  const supabase = supabaseHeaders();
  if (!supabase) return;
  try {
    const response = await fetch(`${supabase.url}/rest/v1/codehound_votes?select=brand,code,worked,failed`, {
      headers: { apikey: supabase.key, authorization: `Bearer ${supabase.key}` },
    });
    if (!response.ok) {
      noteSupabase();
      return;
    }
    const rows = (await response.json()) as { brand: string; code: string; worked: number; failed: number }[];
    await update((db) => {
      for (const row of rows) db.votes[`${row.brand}|${row.code}`] = { worked: row.worked, failed: row.failed };
    });
  } catch {
    noteSupabase();
  }
}

function noteSupabase(): void {
  if (supabaseNote) return;
  supabaseNote = true;
  console.warn("Supabase is configured but the CodeHound tables were not reachable. Using local storage.");
}
