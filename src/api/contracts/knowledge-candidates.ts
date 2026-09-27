import { z } from 'zod';

/**
 * The report at the end of an import — screen 13f.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * "NOTHING IS USED UNTIL APPROVED" IS TRUE BY CONSTRUCTION
 * ════════════════════════════════════════════════════════════════════════════
 * `POST /candidates/:id/approve` **creates a knowledge document** and stores
 * its id on the candidate. Nothing in the AI path reads `KnowledgeCandidate`
 * at all — verified repo-wide: every consumer is the import pipeline or a
 * review route, and `knowledge-ingest.ts` only counts and lists PENDING ones.
 *
 * So the agent reads documents, and a document does not exist until somebody
 * approves. The screen's central claim is enforced by the shape of the data
 * rather than by anyone's discipline, which is the strongest form it can
 * take — and it is worth saying on the screen, because a reviewer who does
 * not believe it will rush.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * AND THE PREMISE IS THE SCHEMA'S OWN
 * ════════════════════════════════════════════════════════════════════════════
 * > *The central rule of this table: historical answers are EVIDENCE, NOT
 * > TRUTH. Human agents make mistakes, grant one-off exceptions, quote
 * > superseded…*
 */

/** Four, not the design's three. `SUPERSEDED` is not a rejection. */
export const CANDIDATE_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'SUPERSEDED'] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

/** What the curation pass did. Items it dropped or merged are deleted. */
export const CURATION_VERDICTS = ['kept', 'rewritten', 'live_data'] as const;

/**
 * One observed answer to a question the business answered more than one way.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ READ FROM THE TWO WRITERS, WHICH DISAGREE WITH EACH OTHER
 * ════════════════════════════════════════════════════════════════════════════
 *   knowledge-extraction.stage.ts:746   { key, answer, occurrenceCount,
 *                                         customerCount }
 *   knowledge-dedupe.stage.ts:254       { key, answer, occurrenceCount }
 *
 * The dedupe stage runs after extraction and merges clusters, and its
 * `mergeVariants` reads back only three of the four — so **`customerCount`
 * survives extraction and is dropped by the first merge that touches the
 * candidate.** Present sometimes, absent sometimes, and never a zero we
 * should print as one.
 *
 * So it is `nullish` and the screen shows it only where it exists. The
 * column's own comment promises a fourth field, `exampleEvidenceIds[]`,
 * which **no code writes at all** — see `examples` on the candidate.
 */
export const variantSchema = z.object({
  /** Normalised form of the answer; the join key for `examples`. */
  key: z.string(),
  answer: z.string(),
  occurrenceCount: z.number().default(0),
  /** Dropped by the dedupe merge. Absent is absent, never zero. */
  customerCount: z.number().nullish().default(null),
});
export type Variant = z.infer<typeof variantSchema>;

/** One real exchange, kept as evidence for the answer it demonstrates. */
export const evidenceExampleSchema = z.object({
  question: z.string().default(''),
  answer: z.string().default(''),
  occurredAt: z.string().nullable().default(null),
  /** Which `variantSchema.key` this exchange is an instance of. */
  variantKey: z.string().nullable().default(null),
});
export type EvidenceExample = z.infer<typeof evidenceExampleSchema>;

export const candidateSchema = z.object({
  id: z.string(),
  topic: z.string().nullable().default(null),
  question: z.string(),
  answer: z.string(),
  status: z.enum(CANDIDATE_STATUSES),
  /**
   * More than one observed answer. Cannot be approved as it stands — the API
   * refuses *"rather than silently enshrining whichever variant happened to
   * be most common"*.
   */
  conflict: z.boolean().default(false),
  confidence: z.number().default(0),
  /**
   * ★★ THE SERVER'S OWN VERDICT ON WHETHER "APPROVE ALL" WOULD TAKE THIS.
   *
   * `!c.conflict && c.confidence >= BULK_APPROVE_MIN_CONFIDENCE`, computed by
   * the route, which says why it is sent: *"Stated by the API rather than only
   * by the UI, so the bulk endpoint and the button can never disagree about
   * what 'safe' means."*
   *
   * `.optional()` and never defaulted. `false` would be a claim that the
   * server excluded this candidate; `undefined` is "this service did not say",
   * which is the only case where `bulkWouldTake` is entitled to derive it.
   */
  bulkApprovable: z.boolean().optional(),
  /**
   * ★ The answer is real and cannot be stated as fact.
   *
   * *"'We usually do viewings Thursday and Friday' is true — but an agent
   * that states it as fact will promise a slot nobody checked."*
   *
   * A candidate can be correct AND unsafe to assert, and nothing else on this
   * screen carries that distinction. It has to be visible BEFORE approval.
   */
  requiresLiveLookup: z.boolean().default(false),
  /**
   * Platform-authored, per candidate. Rendered verbatim, never paraphrased.
   *
   * ════════════════════════════════════════════════════════════════════════
   * ★ `.catch(null)` BECAUSE THIS ONE CAN NEVER BE AUDITED COMPLETE
   * ════════════════════════════════════════════════════════════════════════
   * Every other enum in these contracts has ground truth — a Prisma enum, a
   * TS union, or an `as const` array — and all 53 were checked against it
   * after `roles.2.source` took screen 14 off the page.
   *
   * This one has none. `curation_verdict` is `String?` in the schema, and
   * the only writer picks between "live_data" and "rewritten" inline. There
   * is no declared domain to compare against, so "our enum is complete" is
   * not a statement anybody can make today or keep true tomorrow — the next
   * writer to add a verdict would take down the ENTIRE candidate list, not
   * this field, because one invalid member fails the whole parse.
   *
   * So it degrades instead: an unrecognised verdict becomes null and the
   * screen shows no verdict, which is what it already does when the platform
   * has not authored one. Absence, not a guess.
   *
   * ⚠ This is NOT a pattern to spread. `.catch()` on `riskLevel`, an
   * approval status or a connection state would turn an unknown value into a
   * reassuring one — the calm wrong value, in the places where it costs
   * most. It is right here only because the honest fallback for a missing
   * verdict is nothing at all.
   */
  curationVerdict: z.enum(CURATION_VERDICTS).nullable().catch(null).default(null),
  curationNote: z.string().nullable().default(null),
  /** How much evidence stands behind it. The reviewer's real decision input. */
  occurrenceCount: z.number().default(0),
  customerCount: z.number().default(0),
  /**
   * ════════════════════════════════════════════════════════════════════════
   * ★★ THE TWO ANSWERS THEMSELVES — NAMED AT LAST
   * ════════════════════════════════════════════════════════════════════════
   * `conflict` was named and **this was not**, so `z.object` stripped it and
   * screen 08's conflict panel looked impossible to build. It has been on
   * the wire the whole time: `historical-import.ts:291` sends
   * `variants: c.conflict ? c.variants : null`.
   *
   * **A contract that names a flag and omits the payload the flag guards
   * turns "we have this" into "this does not exist."** Fourth field today
   * that we needed and were already being sent.
   *
   * `null` on every unconflicted row, by that same ternary — so absence here
   * means "not a conflict", not "we could not read it".
   */
  variants: z.array(variantSchema).nullable().default(null),
  /**
   * Up to three representative exchanges, newest first.
   *
   * ★ THIS IS WHERE A PER-VARIANT DATE COMES FROM. `variants` carries no
   * timestamp, and the schema's comment above the column promises an
   * `exampleEvidenceIds[]` that **nothing in the platform writes** — the
   * string appears in that comment and nowhere else. What does exist is
   * `variantKey` on each example, which joins an exchange to the answer it
   * is an instance of. See `lastHeardFor`.
   */
  examples: z.array(evidenceExampleSchema).default([]),
  firstSeenAt: z.string().nullable().default(null),
  lastSeenAt: z.string().nullable().default(null),
  /**
   * An existing document this duplicates. Its ORIGIN is not recorded — so it
   * is "what is already in your knowledge base", never "your website".
   * Calling it the website would assert a provenance the schema does not
   * carry, which is the industry-from-a-login-page error again.
   */
  duplicateOfDocumentId: z.string().nullable().default(null),
});

export type Candidate = z.infer<typeof candidateSchema>;

/**
 * The candidates response, whole.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THIS NAMED ONLY `candidates` AND STRIPPED THE REST
 * ════════════════════════════════════════════════════════════════════════════
 * The route also sends `counts` and `bulkApproveMinConfidence`, and each
 * candidate carries `bulkApprovable`. All three were discarded by `z.object`,
 * and the third one matters most: the route's comment says it is
 *
 *   > "Stated by the API rather than only by the UI, so the bulk endpoint and
 *   >  the button can never disagree about what 'safe' means."
 *
 * **The UI stripped it and recomputed it.** The field added specifically to
 * stop the two from disagreeing was thrown away, and `bulkWouldTake` derived
 * its own answer from a threshold it could not see either — so 13f would have
 * had to hardcode a confidence floor to render a count of what the server
 * would take.
 */
export const candidateListSchema = z.object({
  candidates: z.array(candidateSchema).default([]),
  /**
   * `{ PENDING: 12, APPROVED: 3, … }` — by status, from the route's own
   * `groupBy`. `.default({})` because a service that stops sending it is
   * reporting nothing rather than reporting zero of each.
   */
  counts: z.record(z.string(), z.number()).default({}),
  /**
   * The server's confidence floor for a bulk approve.
   *
   * `.optional()`, never defaulted: a number invented here is a claim about
   * what the server would take, and the whole point of the field is that the
   * client should not be guessing it.
   */
  bulkApproveMinConfidence: z.number().optional(),
});

/* ── The four groups ─────────────────────────────────────────────────────── */

export type ReviewGroup = 'needs_a_look' | 'ready' | 'rejected' | 'already_covered';

export function groupOf(candidate: Candidate): ReviewGroup {
  if (candidate.status === 'APPROVED') return 'ready';
  if (candidate.status === 'REJECTED') return 'rejected';
  // The schema's own wording: "Surfaced as 'already covered' rather than
  // offered as a second copy of it."
  if (candidate.status === 'SUPERSEDED') return 'already_covered';
  return 'needs_a_look';
}

export function inGroup(
  candidates: readonly Candidate[],
  group: ReviewGroup,
): readonly Candidate[] {
  return candidates.filter((c) => groupOf(c) === group);
}

/**
 * Can this be approved with one press?
 *
 * No when it conflicts: there is no "the" answer to approve — that is what
 * conflicted means — so the owner has to say which one is right, and the API
 * returns `conflict_requires_answer` rather than picking.
 */
export function approvableAsIs(candidate: Candidate): boolean {
  return candidate.status === 'PENDING' && !candidate.conflict;
}

/**
 * What "Approve all" would actually take.
 *
 * The eligible set is computed SERVER-SIDE and the client cannot pass a list:
 * `PENDING`, not conflicted, at or above a confidence floor, capped at 100.
 * So the button cannot approve a conflict however it is pressed — which is a
 * promise worth rendering rather than a footnote, because a merchant who does
 * not know it will approve fifty things one at a time.
 */
export function bulkWouldTake(
  candidates: readonly Candidate[],
  /**
   * The server's floor, or `undefined` when it did not send one.
   *
   * ★★ AND `undefined` IS NOT ZERO. A floor of `0` passes EVERYTHING — every
   * confidence is `>= 0` — so defaulting it would count every unconflicted
   * suggestion as bulk-approvable and overstate what pressing the button does.
   * That is the opposite of the cautious reading, and it was in a first draft
   * of the caller with a comment claiming it meant the cautious one.
   *
   * Not told, and no per-candidate verdict either, means we cannot say: the
   * answer is 0, as a refusal rather than as a count.
   */
  minConfidence: number | undefined,
): number {
  /*
   * ★★ THE SERVER'S OWN ANSWER FIRST, BECAUSE IT ASKED TO BE ASKED.
   *
   * `bulkApprovable` is on every candidate and the route says why it is there:
   * *"so the bulk endpoint and the button can never disagree about what 'safe'
   * means."* Recomputing it from a threshold is the disagreement it exists to
   * prevent — the client's rule would drift the moment the server's floor
   * moved, and the number on the button is a promise about what pressing it
   * will do.
   *
   * The fallback is for a service that predates the field. `undefined` there is
   * "we were not told", so it is the one case where deriving is right — and it
   * is derived from the floor the server SENT, not from a constant mirrored
   * here.
   */
  const stated = candidates.filter((c) => c.bulkApprovable !== undefined);
  if (stated.length === candidates.length) {
    return candidates.filter((c) => c.bulkApprovable === true).length;
  }
  if (minConfidence === undefined) return 0;
  return candidates.filter((c) => approvableAsIs(c) && c.confidence >= minConfidence).length;
}

/** Is there evidence worth showing beside a suggestion? */
export function hasEvidence(candidate: Candidate): boolean {
  return candidate.occurrenceCount > 0 || candidate.customerCount > 0;
}

/* ── The conflict, as screen 08 renders it ───────────────────────────────── */

/**
 * The competing answers, most-often-observed first.
 *
 * Empty for anything that is not a conflict — the route sends `null` there
 * rather than an array, and the two mean the same thing to this screen.
 */
export function variantsOf(candidate: Candidate): readonly Variant[] {
  return candidate.variants ?? [];
}

/**
 * When this answer was last actually said, or `null`.
 *
 * ★ RECONSTRUCTED FROM EVIDENCE, AND IT CAN LEGITIMATELY BE ABSENT.
 * The route returns at most **three** representative examples per candidate,
 * so a third or fourth variant may have none — and `occurredAt` is itself
 * nullable. A variant with no dated example gets no date, and the screen
 * says nothing rather than borrowing the candidate's own `lastSeenAt`, which
 * belongs to whichever answer happened to be most recent.
 */
export function lastHeardFor(
  variant: Variant,
  examples: readonly EvidenceExample[],
): string | null {
  const dated = examples
    .filter((e) => e.variantKey === variant.key && e.occurredAt)
    .map((e) => e.occurredAt!)
    .sort();
  return dated.length > 0 ? dated[dated.length - 1]! : null;
}

/**
 * Conflicts only, most-asked first.
 *
 * ⚠ SCOPED TO ONE IMPORT, AND THE SCREEN MUST SAY SO.
 * `knowledge-clustering.stage.ts` queries
 * `where: { importId, tenantId, status: "PENDING" }` — it runs **inside the
 * historical-import pipeline only**. Not continuously over live
 * conversations, and not over a document uploaded next week. A panel that
 * showed these without that sentence would read as "GOTCHA has two
 * contradictions", when what is true is "two contradictions were found in
 * what we imported, and nothing has looked since".
 */
export function conflictsIn(candidates: readonly Candidate[]): readonly Candidate[] {
  return candidates
    .filter((c) => c.conflict && c.status === 'PENDING')
    .slice()
    .sort((a, b) => b.occurrenceCount - a.occurrenceCount);
}

/* ────────────────────────────────────────────────────────────────────────────
 * RESOLVING A CONFLICT — the write, and what the response does and does not say
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ★★ THE BODY KEY IS `answer`. IT IS NOT `editedAnswer`.
 *
 * `editedAnswer` is the name of the *variable* inside the handler, and the
 * column it is finally stored in. The route reads `req.body?.answer`
 * (`historical-import.ts:377`). Posting `editedAnswer` leaves the local
 * `editedAnswer` null, and for a conflicted candidate the very next branch is
 * `if (candidate.conflict && !editedAnswer)` → **400
 * `conflict_requires_answer`**. So the wrong key does not lose the edit
 * quietly; it makes the button refuse every single time, on the one row type
 * the button exists for.
 *
 * Worth saying plainly because the wrong name is the one written on the field
 * at both ends of the route — request handler variable and database column —
 * and the only place the real one appears is the line that reads it.
 */
export const APPROVE_BODY_KEY = 'answer' as const;

/**
 * The route does `.trim().slice(0, 4000)` on the answer and `.slice(0, 500)`
 * on the question.
 *
 * ★ SILENT TRUNCATION, WHICH IS WHY THE CLIENT REFUSES INSTEAD.
 * A 4100-character answer does not fail: it is stored cut off mid-sentence and
 * becomes the answer the AI gives customers. Half a returns policy is worse
 * than no returns policy, because nobody will look at it again — it was
 * approved. So a variant this long is refused here by name, and the person is
 * told to shorten it themselves rather than having it done to them.
 */
export const ANSWER_MAX_CHARS = 4000;

export function answerTooLong(answer: string): boolean {
  return answer.trim().length > ANSWER_MAX_CHARS;
}

/**
 * What the approve route answers on success.
 *
 * `alreadyApproved` arrives on the idempotent replay — a second press returns
 * the document the first one made instead of writing the knowledge twice.
 * It is `.optional()` and never defaulted: on the normal path the route omits
 * it, and defaulting it to `false` would be a claim we made the document.
 */
export const approveResultSchema = z.object({
  ok: z.boolean(),
  /**
   * Present on both paths. Nullable because the idempotent branch returns
   * `candidate.approvedDocumentId`, which is a nullable column — an APPROVED
   * row written before that column existed returns `ok: true` with no id, and
   * then there is nothing to confirm against.
   */
  documentId: z.string().nullish().default(null),
  alreadyApproved: z.boolean().optional(),
});
export type ApproveResult = z.infer<typeof approveResultSchema>;

/**
 * Whether the AI can actually answer with a document — the third state the
 * approve response does not carry.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠ `{ ok: true }` DOES NOT MEAN THE KNOWLEDGE IS IN USE
 * ════════════════════════════════════════════════════════════════════════════
 * The route awaits `processDocument`, and the comment above that await says
 * *"Awaited rather than fired and forgotten, so an approval that reports
 * success is an approval the AI can actually use."* The `try/catch` wrapped
 * around it removes exactly that guarantee: an embedding failure is logged,
 * the document is left at `status: "error"` with no vectors in Qdrant, and the
 * route still answers `{ ok: true }`.
 *
 * **The comment is true about the `await` and false about the outcome.** It is
 * the strongest kind of wrong comment, because it names the property it does
 * not have.
 *
 * Retrieval reads Qdrant and filters on tenant and knowledge base, **not on
 * `status`** — so `status` is not what gates the answer, it is the only record
 * of whether the vectors got written. `ready` is the one value that says they
 * did.
 */
export type DocumentUse = 'in_use' | 'not_retrievable' | 'unknown';

export function documentUseOf(status: string | null | undefined): DocumentUse {
  /*
   * Only `ready` is a positive statement. `processing` is mid-flight,
   * `pending` is the value the row is created with, and anything else is a
   * value this build has not seen — all three are "we do not know yet", never
   * "it is live". `error` is the one case we can promise is not working.
   */
  if (status === 'ready') return 'in_use';
  if (status === 'error') return 'not_retrievable';
  return 'unknown';
}
