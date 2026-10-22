/**
 * A conversation's situation in one line, from its AI summary.
 *
 * Lives in lib (not in a router) because two routes need it - the contact
 * list's insights and a person's conversation history - and importing one
 * router module from another drags in its middleware at load time.
 */
const SITUATION_MAX = 140;

/** Summarizer placeholders that are not a situation at all. */
const NOT_A_SUMMARY = /^(failed to generate summary|no messages to summari[sz]e)\.?$/i;

/**
 * The customer's situation in one line, from the AI summary. Summaries are
 * structured ("• **Why they reached out**: asked for a refund on #1016 ...
 * • **What they asked**: ..."), so this takes the first non-empty line,
 * drops the bullet, the markdown and the "label:" in front of it, then the
 * first sentence. A summarizer placeholder is null, not a situation.
 */
export function situationOf(summary: string | null | undefined): string | null {
  const line = String(summary ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  // Wide dashes are a written-by-AI tell (Omer, 2026-10-06): shown as "-".
  let s = line
    .replace(/[\u2013\u2014\u2015]/g, "-")
    .replace(/^[•*-]+\s*/, "")
    .replace(/\*\*|__|`/g, "")
    .trim();
  const colon = s.indexOf(":");
  if (colon > 0 && colon <= 40 && s.length > colon + 1) s = s.slice(colon + 1).trim();
  s = s.replace(/\s+/g, " ").trim();
  // No letter or digit at all ("-", "…", or a lone wide dash) is a placeholder the summarizer
  // left, not a summary. "**Summary:** -" used to come out as "-".
  if (!s || NOT_A_SUMMARY.test(s) || !/[\p{L}\p{N}]/u.test(s)) return null;
  const first = s.split(/(?<=[.!?])\s/)[0] ?? s;
  return first.length > SITUATION_MAX ? `${first.slice(0, SITUATION_MAX - 1).trimEnd()}…` : first;
}
