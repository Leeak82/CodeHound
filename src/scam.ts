/** Flag public posts that smell like a scam. This never invents or tests a code. */
export function scamReasons(excerpt: string): string[] {
  const reasons: string[] = [];
  if (unrealisticReward(excerpt)) {
    reasons.push("Promised reward looks unrealistic for a bonus code.");
  }
  if (
    /enter\s+(your\s+)?(password|passphrase|seed phrase|private key)/i.test(excerpt) ||
    /password\s+for\s+your\s+(account|email|bank)/i.test(excerpt) ||
    /(send|give|share)\s+(us\s+)?(your\s+)?(password|seed phrase)/i.test(excerpt)
  ) {
    reasons.push("Asks for a password or secret.");
  }
  if (/code\s+generator|generate[sd]?\s+(?:unlimited\s+)?(?:promo\s+|bonus\s+)?codes|random\s+code\s+generator/i.test(excerpt)) {
    reasons.push("Tied to a code generator.");
  }
  return reasons;
}

function unrealisticReward(text: string): boolean {
  const re = /\$\s*(\d{3,5})(?:\.\d{2})?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const amount = Number(match[1]);
    if (amount < 100 || amount > 5000) continue;
    const window = text.slice(Math.max(0, match.index - 48), match.index + 48);
    if (/%\s*off|\boff your\b|\boff orders?\b|\boff the\b|\boff a\b/i.test(window)) continue;
    if (/\bbonus\b|\bfree\b|\bgift\s*card\b|\bcash\b|\bno deposit\b|\bsign[\s-]?up\b/i.test(window)) return true;
  }
  return false;
}
