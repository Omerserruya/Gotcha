/**
 * Action-honesty: a reply may claim work is happening / done / coming only if
 * the turn produced execution evidence.
 *
 * Live incident (2026-07-21): with no product tool in its surface, the model
 * narrated "אני בודקת עכשיו", "הנה 3 אופציות", "שלחתי", "אחזור אליך תוך דקה"
 * across 14 turns while ZERO tools executed. These are the four harmful claim
 * shapes; the detector is deterministic (regex on both Hebrew and English) so
 * it can gate the reply and be measured, rather than trusting the persona
 * prompt to keep the model honest.
 */

export type UnsupportedClaimKind = "in_progress" | "results" | "sent" | "followup";

const CLAIM_PATTERNS: Array<{ kind: UnsupportedClaimKind; re: RegExp }> = [
  // "checking now / searching now"
  { kind: "in_progress", re: /(בודק(ת|ים)?\s*עכשיו|מחפש(ת|ים)?\s*עכשיו|אני\s*(בודק|מחפש)|רגע\s*אני\s*(בודק|מחפש)|checking\s*now|searching\s*now|let me\s*(check|search|look)\s*(now|that up))/i },
  // "here are N options / I found …"  (claims RESULTS exist)
  { kind: "results", re: /(הנה\s*\d*\s*(אופציות|דגמים|תוצאות|מוצרים)|מצאתי\s*(לך|עבורך)?\s*\d|here\s*are\s*\d*\s*(options|products|results)|i\s*found\s*(you|\d))/i },
  // "I sent / already sent"
  { kind: "sent", re: /(שלחתי|שלחנו|כבר\s*שלחתי|נשלח(ה|ו)?\s*(אליך|עכשיו)|i\s*(have\s*)?sent|i['’]ve\s*sent|already\s*sent)/i },
  // "I'll get back to you / returning in a minute"  (promises later autonomous work)
  { kind: "followup", re: /(אחזור\s*אליך|מחזיר(ה)?\s*(לך)?\s*תוך|נחזור\s*אליך|חוזרת\s*אליך|i(['’]ll| will)?\s*(get|come)\s*back\s*to\s*you|i(['’]ll| will)?\s*return\s*in|i(['’]ll| will)?\s*send\s*(you\s*)?(shortly|in a))/i },
];

export interface ActionClaim {
  kind: UnsupportedClaimKind;
  match: string;
}

/** All action-claim shapes present in the text (empty = none). */
export function detectActionClaims(text: string | null | undefined): ActionClaim[] {
  if (!text) return [];
  const out: ActionClaim[] = [];
  for (const { kind, re } of CLAIM_PATTERNS) {
    const m = re.exec(text);
    if (m) out.push({ kind, match: m[0] });
  }
  return out;
}

/**
 * Did this turn actually DO something a claim could rest on? Any tool that
 * executed for real (not a gate/skip/denied/awaiting-approval side effect) is
 * evidence. `followup` claims additionally require a real async job, which the
 * bot loop does not create - so they are NEVER supported inline.
 */
export function turnHasExecutionEvidence(
  toolCallLog: Array<{ tool?: string; decision?: string; sideEffect?: string }> | undefined,
): boolean {
  if (!toolCallLog?.length) return false;
  return toolCallLog.some(
    (t) =>
      (t.decision === "executed" || t.decision === "executed_on_retry") &&
      !!t.tool &&
      !t.tool.startsWith("__") && // internal markers (__redundant_info__ etc.)
      t.sideEffect !== "awaiting_approval" &&
      t.sideEffect !== "denied",
  );
}

export interface HonestyVerdict {
  ok: boolean;
  /** Claims that have no execution evidence to support them. */
  unsupported: ActionClaim[];
}

/**
 * A reply is action-honest when every claim it makes is backed by evidence.
 * `in_progress` / `results` / `sent` need a tool that executed this turn.
 * `followup` (promising later autonomous work) is unsupported unless a real
 * continuation job exists - the bot loop has none, so it is always flagged.
 */
export function validateActionHonesty(
  replyText: string | null | undefined,
  toolCallLog: Array<{ tool?: string; decision?: string; sideEffect?: string }> | undefined,
  opts?: { hasBackgroundJob?: boolean },
): HonestyVerdict {
  const claims = detectActionClaims(replyText);
  if (!claims.length) return { ok: true, unsupported: [] };
  const evidence = turnHasExecutionEvidence(toolCallLog);
  const unsupported = claims.filter((c) => {
    if (c.kind === "followup") return !opts?.hasBackgroundJob;
    return !evidence;
  });
  return { ok: unsupported.length === 0, unsupported };
}
