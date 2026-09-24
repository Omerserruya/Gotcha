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
   * ★ The answer is real and cannot be stated as fact.
   *
   * *"'We usually do viewings Thursday and Friday' is true — but an agent
   * that states it as fact will promise a slot nobody checked."*
   *
   * A candidate can be correct AND unsafe to assert, and nothing else on this
   * screen carries that distinction. It has to be visible BEFORE approval.
   */
  requiresLiveLookup: z.boolean().default(false),
  /** Platform-authored, per candidate. Rendered verbatim, never paraphrased. */
  curationVerdict: z.enum(CURATION_VERDICTS).nullable().default(null),
  curationNote: z.string().nullable().default(null),
  /** How much evidence stands behind it. The reviewer's real decision input. */
  occurrenceCount: z.number().default(0),
  customerCount: z.number().default(0),
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

export const candidateListSchema = z.object({
  candidates: z.array(candidateSchema).default([]),
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
export function bulkWouldTake(candidates: readonly Candidate[], minConfidence: number): number {
  return candidates.filter((c) => approvableAsIs(c) && c.confidence >= minConfidence).length;
}

/** Is there evidence worth showing beside a suggestion? */
export function hasEvidence(candidate: Candidate): boolean {
  return candidate.occurrenceCount > 0 || candidate.customerCount > 0;
}
