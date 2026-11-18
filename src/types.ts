export const CODE_TYPES = ["signup", "bonus", "coupon", "referral", "lottery", "promo"] as const;
export type CodeType = (typeof CODE_TYPES)[number];

export const SOURCE_IDS = ["official", "social", "reddit", "coupons", "web", "youtube", "gemini"] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

export type SourceStatus = "searching" | "found" | "nothing" | "failed";

export interface SourceState {
  id: SourceId;
  label: string;
  status: SourceStatus;
  detail: string;
  count: number;
}

export interface RawHit {
  code: string;
  type: CodeType;
  reward: string;
  url: string;
  title: string;
  sourceId: SourceId;
  seenAt: string | null;
  official: boolean;
  workedNotes: number;
  expiredNotes: number;
  excerpt: string;
  labeledOfficial: boolean;
}

export interface CodeSource {
  url: string;
  title: string;
  sourceId: SourceId;
  official: boolean;
}

export interface CodeCard {
  code: string;
  type: CodeType;
  reward: string;
  sources: CodeSource[];
  firstSeen: string | null;
  lastSeen: string | null;
  ageLabel: string;
  sourceCount: number;
  confidence: number;
  scam: { reasons: string[] } | null;
  workedVotes: number;
  failedVotes: number;
  workedNotes: number;
  expiredNotes: number;
  note: string;
}

export interface HuntResult {
  brand: string;
  hint: string;
  codes: CodeCard[];
  sources: SourceState[];
  cached: boolean;
  cachedAt: string | null;
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface VisionResult {
  brand: string;
  codeType: CodeType | null;
  hints: string;
}
