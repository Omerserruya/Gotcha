import { z } from 'zod';

/**
 * What GOTCHA knows — screen 08.
 *
 * Shapes read from `services/ai/src/routes/knowledge.ts` and
 * `services/ai/src/routes/unanswered-questions.ts`.
 *
 * ── THE SCREEN CAN SAY WHEN. IT CANNOT SAY WHETHER THAT IS GOOD. ──
 * The design labels each source *"Fresh"* and counts *"Out of date · 4"*.
 * `updatedAt` is real and drives *"last refreshed"*, but **there is no
 * staleness policy anywhere in the platform** — no threshold, no field, no
 * job. So the screen states the date and lets the reader judge it.
 *
 * *"Last refreshed 29 July"* is a fact. *"Fresh"* is a verdict that needs a
 * rule nobody wrote, and it would be wrong in exactly the case that matters:
 * a source last touched two months ago, which is this tenant's actual state.
 *
 * ── WHAT ELSE IS NOT MODELLED ──
 * **No topic strength**, so *"Answers confidently · 34 topics"* and *"Thin —
 * guesses sometimes · 6"* have no source at all.
 *
 * **Conflicts are `IntelligenceReview`** — the design's *"Contradicts
 * itself"* with two values and a resolve action. The mechanism is real; this
 * tenant has zero.
 *
 * **Unanswered questions are real** and carry `timesAsked` and
 * `distinctAskers`, which is better than the design's *"asked 23 times"*: the
 * same person asking twenty times and twenty people asking once are different
 * problems.
 */

export const knowledgeDocumentSchema = z.object({
  id: z.string().min(1),
  title: z.string().default(''),
  /** `pending` | `ready` | others. A document still processing answers nothing. */
  status: z.string().default('pending'),
  chunkCount: z.number().default(0),
  sourceType: z.string().default('text'),
  sourceUrl: z.string().nullable().default(null),
  updatedAt: z.string().nullable().default(null),
});

export const knowledgeSourceSchema = z.object({
  id: z.string().min(1),
  name: z.string().default(''),
  description: z.string().nullable().default(null),
  isActive: z.boolean().default(true),
  /** `all` | `agent` | `department` — who this source is available to. */
  scope: z.string().default('all'),
  documents: z.array(knowledgeDocumentSchema).default([]),
});

export type KnowledgeSource = z.infer<typeof knowledgeSourceSchema>;
export const knowledgeListSchema = z.array(knowledgeSourceSchema);

/**
 * When this source was last refreshed, or `null` if it holds nothing.
 *
 * The newest document's `updatedAt` — the route's own comment says that field
 * *"drives last refreshed"*.
 */
export function lastRefreshed(source: KnowledgeSource): string | null {
  const stamps = source.documents
    .map((d) => d.updatedAt)
    .filter((d): d is string => d !== null)
    .sort();
  return stamps.length > 0 ? stamps[stamps.length - 1]! : null;
}

/** Documents that are not yet answering anything. */
export function notReadyCount(source: KnowledgeSource): number {
  return source.documents.filter((d) => d.status !== 'ready').length;
}

/**
 * Two sources can share a name, and on this tenant two do.
 *
 * Both are called "Company Knowledge" and a list that prints the name twice
 * tells the reader nothing about which is which. So a name shared with
 * another source is shown with what actually distinguishes them — how much is
 * in each — rather than being silently ambiguous.
 */
export function hasAmbiguousName(
  source: KnowledgeSource,
  all: readonly KnowledgeSource[],
): boolean {
  return all.filter((s) => s.name.trim() === source.name.trim()).length > 1;
}

/**
 * A question GOTCHA could not answer.
 *
 * `timesAsked` and `distinctAskers` are separate on purpose, and the pair is
 * more useful than the design's single *"asked 23 times"*: one person asking
 * twenty times is a stuck customer, and twenty people asking once is a
 * missing page.
 */
export const unansweredQuestionSchema = z.object({
  id: z.string().min(1),
  question: z.string().default(''),
  timesAsked: z.number().default(0),
  distinctAskers: z.number().default(0),
  /** Why it went unanswered — a bounded vocabulary the route validates. */
  reason: z.string().nullable().default(null),
  lastAskedAt: z.string().nullable().default(null),
  resolvedAt: z.string().nullable().default(null),
});

export type UnansweredQuestion = z.infer<typeof unansweredQuestionSchema>;

export const unansweredListSchema = z.object({
  data: z.array(unansweredQuestionSchema).default([]),
  nextCursor: z.string().nullable().default(null),
});

/** Still open — nobody has added an answer. */
export function isOpen(question: UnansweredQuestion): boolean {
  return question.resolvedAt === null;
}
