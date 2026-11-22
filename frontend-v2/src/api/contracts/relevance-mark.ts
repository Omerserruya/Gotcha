/**
 * What a hand mark did to its sender (Backend's sender rule, live on prod at
 * 14965bf4): a conversation marked personal by hand makes the same sender's
 * NEW conversations on the same channel come in as personal (not on email);
 * "this is a business enquiry" on one the rule labelled lifts it for that
 * sender's new conversations. Labels already stored are not recomputed.
 *
 * ⚠ ASSUMED FIELD, DARK UNTIL BACKEND SENDS IT (Supervisior, 2026-11-19,
 *   their "commit 4"): the mark's response says whether the rule applied.
 *   The client never infers it from the channel. Everything that knows the
 *   field's name and values is here, so the real one is an edit in this
 *   file only. Absent or unknown: `null`, and no line is drawn - the safe
 *   side, since a line claims something about the person's future inbox.
 */
export type SenderRule = 'applied' | 'lifted';

/** The response field, as assumed. */
const FIELD = 'senderRule';

export function senderRuleOf(raw: unknown): SenderRule | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = (raw as Record<string, unknown>)[FIELD];
  return value === 'applied' || value === 'lifted' ? value : null;
}
