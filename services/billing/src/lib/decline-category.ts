/**
 * What to tell a customer whose card was refused.
 *
 * A provider decline string is written for us, not for them: it can carry
 * account detail, and it reads like an error log to someone who just wanted to
 * pay. So it is reduced to a small set of categories that answer the only
 * question they have - should I try this card again, or a different one.
 *
 * One implementation, used by both the status read and the advance response.
 * Two would drift, and then the same decline would be described differently
 * depending on which request happened to surface it.
 */
export type DeclineCategory =
  | "CARD_EXPIRED"
  | "INSUFFICIENT_FUNDS"
  | "CARD_UNUSABLE"
  | "DECLINED";

/**
 * Map a provider failure code to a category.
 *
 * Deliberately falls back to DECLINED rather than passing anything through.
 * An unrecognised code is still a refusal, and showing its raw text would leak
 * exactly what this function exists to avoid.
 */
export function declineCategory(failureCode?: string | null): DeclineCategory {
  const code = (failureCode ?? "").toLowerCase();
  if (/expired/.test(code)) return "CARD_EXPIRED";
  if (/insufficient|funds|limit/.test(code)) return "INSUFFICIENT_FUNDS";
  if (/invalid|token|unusable/.test(code)) return "CARD_UNUSABLE";
  return "DECLINED";
}
