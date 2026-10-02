/**
 * ★★ NO FIGURE OF NOTHING — one rule for every Analytics tab.
 *
 * A figure derived from conversations (a share of them, the hours they
 * saved, how many people answered first) is a finding only when there were
 * conversations. With none in the window it is "—" — never "0%", "0h" or "0
 * conversations" posing as a result. Raw event counts (actions run, approvals
 * asked) stay: zero of those is a fact, not a share of nothing.
 */
export function hadConversations(
  overview: { readonly totalConversations: number } | null,
): boolean {
  return overview !== null && overview.totalConversations > 0;
}

/** Hours saved, or null when there were none to save — 06's own rule for 0. */
export function hoursSaved(timeSaved: { readonly secondsSaved: number } | null): number | null {
  if (!timeSaved || timeSaved.secondsSaved <= 0) return null;
  return Math.round(timeSaved.secondsSaved / 3600);
}
