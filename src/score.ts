import { isCouponSource, isOfficialUrl } from "./extract.js";
import { scamReasons } from "./scam.js";
import type { CodeCard, CodeType, RawHit } from "./types.js";

const NOTES: Record<CodeType, string> = {
  signup: "Sign-up codes only work when creating a new account.",
  bonus: "Bonus codes go in Rewards → Bonus Codes.",
  coupon: "Checkout coupons go in the promo field at payment.",
  referral: "Referral codes are entered when you create an account. They credit the person who shared the code.",
  lottery: "Lottery codes are for a drawing or ticket drop, not a cash balance.",
  promo: "Promo codes usually go in a code field in the app or at checkout.",
};

export function placementNote(type: CodeType, blob: string): string {
  if (type === "bonus" && /rewards\s*(?:→|>|\/)\s*bonuses?\s*(?:→|>|\/)\s*bonus codes/i.test(blob)) {
    return "Bonus codes go in Rewards → Bonuses → Bonus Codes.";
  }
  if (type === "signup" && /during registration|when you (?:first )?create|at sign-?up/i.test(blob)) {
    return NOTES.signup;
  }
  return NOTES[type];
}

export function ageLabel(iso: string | null, now = Date.now()): string {
  if (!iso) return "Date not listed";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "Date not listed";
  const days = Math.floor((now - then) / 86_400_000);
  if (days <= 0) return "Found today";
  if (days === 1) return "Found 1 day ago";
  return `Found ${days} days ago`;
}

export function siteKey(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    const parts = host.split(".");
    if (parts.length <= 2) return host;
    return parts.slice(-2).join(".");
  } catch {
    return url;
  }
}

export interface VoteCounts {
  worked: number;
  failed: number;
}

export function mergeHits(hits: RawHit[], votesFor: (code: string) => VoteCounts, brand = "", now = Date.now()): CodeCard[] {
  const byCode = new Map<string, RawHit[]>();
  for (const hit of hits) {
    const key = hit.code.toUpperCase();
    const list = byCode.get(key) ?? [];
    list.push({ ...hit, code: key });
    byCode.set(key, list);
  }

  const cards: CodeCard[] = [];
  for (const [code, group] of byCode) {
    const urls = new Map<string, RawHit>();
    for (const hit of group) {
      const prev = urls.get(hit.url);
      if (!prev) urls.set(hit.url, hit);
      else {
        urls.set(hit.url, {
          ...prev,
          official: prev.official || hit.official,
          labeledOfficial: prev.labeledOfficial || hit.labeledOfficial,
          workedNotes: Math.max(prev.workedNotes, hit.workedNotes),
          expiredNotes: Math.max(prev.expiredNotes, hit.expiredNotes),
          reward: prev.reward.length >= hit.reward.length ? prev.reward : hit.reward,
          excerpt: prev.excerpt.length >= hit.excerpt.length ? prev.excerpt : hit.excerpt,
          type: preferType(prev, hit),
          seenAt: later(prev.seenAt, hit.seenAt),
        });
      }
    }
    const unique = [...urls.values()].map((hit) => ({
      ...hit,
      official: brand ? isOfficialUrl(hit.url, brand) : hit.official,
    }));
    const type = unique.reduce((t, h) => preferType({ ...h, type: t }, h), unique[0].type);
    const reward = unique.map((h) => h.reward).sort((a, b) => b.length - a.length)[0] ?? "";
    const dates = group.map((h) => h.seenAt).filter((d): d is string => Boolean(d)).sort();
    const firstSeen = dates[0] ?? null;
    const lastSeen = dates[dates.length - 1] ?? null;
    const domains = new Set(unique.map((h) => siteKey(h.url)));
    const workedNotes = unique.reduce((n, h) => n + h.workedNotes, 0);
    const expiredNotes = unique.reduce((n, h) => n + h.expiredNotes, 0);
    const votes = votesFor(code);
    if (code.length < 5 && unique.every((hit) => isCouponSource(hit.sourceId, hit.url))) continue;
    const official = unique.some((h) => h.official);
    const labeledOfficial = unique.some((h) => h.labeledOfficial);
    const excerpt = unique.map((h) => h.excerpt).join(" \n ").slice(0, 700);
    const scam = scamReasons(excerpt);
    const blob = unique.map((h) => `${h.excerpt} ${h.reward}`).join(" ");
    const card: CodeCard = {
      code,
      type,
      reward,
      sources: unique.slice(0, 6).map((h) => ({
        url: h.url,
        title: h.title || domainLabel(h.url),
        sourceId: h.sourceId,
        official: h.official,
      })),
      firstSeen,
      lastSeen,
      ageLabel: ageLabel(lastSeen, now),
      sourceCount: domains.size,
      confidence: 0,
      reasons: [],
      scam: scam.length ? { reasons: scam } : null,
      workedVotes: votes.worked,
      failedVotes: votes.failed,
      workedNotes,
      expiredNotes,
      note: placementNote(type, blob),
    };
    const explained = explainScore(card, official, labeledOfficial, now);
    card.confidence = explained.score;
    card.reasons = explained.reasons;
    cards.push(card);
  }

  cards.sort((a, b) => {
    const af = a.scam ? 1 : 0;
    const bf = b.scam ? 1 : 0;
    if (af !== bf) return af - bf;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    if (b.sourceCount !== a.sourceCount) return b.sourceCount - a.sourceCount;
    return a.code.localeCompare(b.code);
  });
  return cards;
}

function preferType(a: { type: CodeType; official: boolean }, b: { type: CodeType; official: boolean }): CodeType {
  const rank = (t: CodeType) => (t === "promo" ? 0 : 1);
  if (rank(b.type) !== rank(a.type)) return rank(b.type) > rank(a.type) ? b.type : a.type;
  if (a.official !== b.official) return a.official ? a.type : b.type;
  return a.type;
}

function later(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

export function scoreCard(card: CodeCard, official: boolean, labeledOfficial: boolean, now = Date.now()): number {
  return explainScore(card, official, labeledOfficial, now).score;
}

export function explainScore(card: CodeCard, official: boolean, labeledOfficial: boolean, now = Date.now()): { score: number; reasons: string[] } {
  let score = 22;
  const reasons = ["base +22"];
  if (official) {
    score += 36;
    reasons.push("official +36");
  } else if (labeledOfficial) {
    score += 8;
    reasons.push("labeled official +8");
  }
  const sourceBonus = Math.min(24, Math.max(0, card.sourceCount - 1) * 8);
  if (sourceBonus) {
    score += sourceBonus;
    reasons.push(`${card.sourceCount} src +${sourceBonus}`);
  }
  const fresh = recencyPoints(card.lastSeen, official, now);
  score += fresh;
  reasons.push(freshLabel(card.lastSeen, official, now, fresh));
  const worked = Math.min(12, card.workedNotes * 4);
  if (worked) {
    score += worked;
    reasons.push(`${card.workedNotes} worked notes +${worked}`);
  }
  const expired = Math.min(30, card.expiredNotes * 10);
  if (expired) {
    score -= expired;
    reasons.push(`${card.expiredNotes} expired notes -${expired}`);
  }
  const up = Math.min(15, card.workedVotes * 5);
  if (up) {
    score += up;
    reasons.push(`${card.workedVotes} worked +${up}`);
  }
  const down = Math.min(36, card.failedVotes * 8);
  if (down) {
    score -= down;
    reasons.push(`${card.failedVotes} failed -${down}`);
  }
  if (card.scam) score = Math.min(score, 18);
  return { score: Math.max(3, Math.min(99, Math.round(score))), reasons };
}

function freshLabel(iso: string | null, official: boolean, now: number, points: number): string {
  if (!iso) return official ? `undated official +${points}` : `date unknown +${points}`;
  const days = Math.max(0, Math.round((now - Date.parse(iso)) / 86_400_000));
  return `${days}d fresh +${points}`;
}

function recencyPoints(iso: string | null, official: boolean, now: number): number {
  if (!iso) return official ? 8 : 3;
  const days = (now - Date.parse(iso)) / 86_400_000;
  if (Number.isNaN(days)) return official ? 8 : 3;
  if (days <= 14) return 22;
  if (days <= 45) return 16;
  if (days <= 120) return 8;
  return 2;
}

function domainLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
