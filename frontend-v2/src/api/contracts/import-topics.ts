import { z } from 'zod';

import { ANSWER_MAX_CHARS } from './knowledge-candidates';

/**
 * 13f by topic (Omer, 2026-11-18): an import's suggestions as the topics a
 * person approves in one action each.
 *
 * `GET /api/historical-imports/:id/topics` → `{ topics, progress, … }`.
 *
 * ★ LENIENT PER ELEMENT. One topic, or one item, that does not parse is
 *   dropped and counted (`dropped`), never the whole response: a strict
 *   array would hide every topic behind one odd row, and the screen would
 *   fall back to the flat list for a reason nobody can see.
 *
 * ★ `topicId` is stable within a run and changes after a rerun - an approve
 *   against an old id answers 404 TOPIC_NOT_FOUND, and the screen re-reads.
 */

export const TOPIC_STATUSES = ['pending', 'approved', 'auto', 'rejected'] as const;
export type TopicStatus = (typeof TOPIC_STATUSES)[number];

const ITEM_STATUSES = ['pending', 'approved', 'rejected', 'superseded'] as const;
export type TopicItemStatus = (typeof ITEM_STATUSES)[number];

/** A value the server chose: a price, a period. Shown as it comes. */
const shownValue = z.union([z.string(), z.number()]).transform((v) => String(v).trim());

const quoteSchema = z.object({
  question: z.string().catch(''),
  answer: z.string().catch(''),
  occurredAt: z.string().nullish().catch(null),
});

/** Keeps the elements that parse; never fails on one that does not. */
function lenientArray<T extends z.ZodType>(element: T) {
  return z
    .array(z.unknown())
    .nullish()
    .transform((rows) => {
      const kept: z.infer<T>[] = [];
      let dropped = 0;
      for (const row of rows ?? []) {
        const parsed = element.safeParse(row);
        if (parsed.success) kept.push(parsed.data as z.infer<T>);
        else dropped += 1;
      }
      return { kept, dropped };
    });
}

export const topicItemSchema = z.object({
  candidateId: z.string().min(1),
  /*
   * ★ The candidate's own status, as the database writes it (PENDING, APPROVED,
   *   REJECTED, SUPERSEDED - routes/historical-import.ts `c.status`). An
   *   unknown one is never offered for a decision: it reads as superseded.
   */
  status: z
    .string()
    .transform((v) => v.toLowerCase())
    .pipe(z.enum(ITEM_STATUSES))
    .catch('superseded'),
  question: z.string(),
  answer: z.string(),
  quotes: lenientArray(quoteSchema).transform((q) =>
    q.kept.filter((quote) => quote.question.trim() || quote.answer.trim()),
  ),
  /** A policy fact's chosen value, and on what basis; `null` for any other answer. */
  chosen: z
    .object({
      value: shownValue,
      basis: z.enum(['latest', 'policy']),
      at: z.string().nullish().catch(null),
    })
    .nullish()
    .catch(null)
    .transform((v) => v ?? null),
  previous: z
    .object({ value: shownValue, until: z.string().nullish().catch(null) })
    .nullish()
    .catch(null)
    .transform((v) => v ?? null),
  /** The answers disagree and nothing decides between them: a person must ("מה נכון?"). */
  unresolved: z
    .boolean()
    .nullish()
    .catch(false)
    .transform((v) => v === true),
  variants: lenientArray(
    z.object({ answer: z.string(), lastSeenAt: z.string().nullish().catch(null) }),
  ).transform((v) => v.kept.filter((variant) => variant.answer.trim() !== '')),
});
export type TopicItem = z.infer<typeof topicItemSchema>;

const count = z
  .number()
  .nullish()
  .catch(null)
  .transform((v) => v ?? 0);

export const topicSchema = z.object({
  topicId: z.string().min(1),
  label: z.string(),
  /** An unknown status is a topic this screen cannot place: dropped, not guessed. */
  status: z.enum(TOPIC_STATUSES),
  occurrences: count,
  customers: count,
  lastSeenAt: z.string().nullish().catch(null),
  conflict: z
    .boolean()
    .nullish()
    .catch(false)
    .transform((v) => v === true),
  docConflict: z
    .boolean()
    .nullish()
    .catch(false)
    .transform((v) => v === true),
  items: lenientArray(topicItemSchema),
});
export type ImportTopic = Omit<z.infer<typeof topicSchema>, 'items'> & {
  readonly items: readonly TopicItem[];
};

export const topicsResponseSchema = z.object({
  topics: lenientArray(topicSchema),
  progress: z
    .object({ total: z.number(), done: z.number() })
    .nullish()
    .catch(null)
    .transform((v) => v ?? null),
});

export interface ImportTopics {
  readonly topics: readonly ImportTopic[];
  /** The server's count (Supervisior: use it); `null` when it did not send one. */
  readonly progress: { readonly total: number; readonly done: number } | null;
  /** Topics and items that did not parse - logged, never shown as missing work. */
  readonly dropped: number;
}

export function importTopicsOf(raw: z.infer<typeof topicsResponseSchema>): ImportTopics {
  let dropped = raw.topics.dropped;
  const topics = raw.topics.kept.flatMap((topic): ImportTopic[] => {
    dropped += topic.items.dropped;
    // A topic with no item left has nothing to approve or to show.
    return topic.items.kept.length > 0 ? [{ ...topic, items: topic.items.kept }] : [];
  });
  return { topics, progress: raw.progress, dropped };
}

/** The pending topics, the most-asked first (Omer); the order the server gave breaks ties. */
export function pendingByOccurrences(topics: readonly ImportTopic[]): ImportTopic[] {
  return topics
    .map((topic, index) => ({ topic, index }))
    .filter(({ topic }) => topic.status === 'pending')
    .sort((a, b) => b.topic.occurrences - a.topic.occurrences || a.index - b.index)
    .map(({ topic }) => topic);
}

/** Shown before "הצג עוד" (Omer). */
export const TOPICS_FIRST_PAGE = 30;

/**
 * The answers to choose between, in order: the suggested answer, then each
 * variant - one entry per distinct text (trimmed), so the same words are
 * never two radios. "אחר" is not in the list; the screen adds it last.
 */
export function answerOptions(item: TopicItem): string[] {
  const seen = new Set<string>();
  const options: string[] = [];
  for (const text of [item.answer, ...item.variants.map((v) => v.answer)]) {
    const key = text.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    options.push(key);
  }
  return options;
}

/** One item's choice: one of `answerOptions` by index, or "אחר" with its text. */
export type ItemChoice =
  | { readonly kind: 'option'; readonly index: number }
  | { readonly kind: 'other'; readonly text: string };

/**
 * Where an item starts: an answer nobody disputes on the suggestion; an
 * unresolved one on nothing, since choosing is the point.
 */
export function initialChoice(item: {
  readonly unresolved: boolean;
  readonly options: readonly string[];
}): ItemChoice | null {
  return item.unresolved || item.options.length === 0 ? null : { kind: 'option', index: 0 };
}

/** Does this choice still need the reviewer? (Nothing chosen, or "אחר" left empty.) */
export function choiceMissing(choice: ItemChoice | null): boolean {
  if (choice === null) return true;
  return choice.kind === 'other' && choice.text.trim() === '';
}

export function choiceTooLong(choice: ItemChoice | null): boolean {
  return choice?.kind === 'other' && choice.text.trim().length > ANSWER_MAX_CHARS;
}

/**
 * What an approve sends for one item, or `null` for nothing.
 *
 * The suggested answer of an undisputed item sends nothing, so the server
 * records a plain approval rather than an edit (e41a57e4). A variant or
 * "אחר" sends its text - and "אחר" typed back to the suggestion is plain
 * too. An UNRESOLVED item always sends its answer, whichever it is: the
 * route refuses one without (400 UNRESOLVED_ITEM).
 */
export function itemAnswer(
  item: {
    readonly candidateId: string;
    readonly unresolved: boolean;
    /** `answerOptions(item)`: the suggestion first. */
    readonly options: readonly string[];
  },
  choice: ItemChoice | null,
): { candidateId: string; answer: string } | null {
  if (choice === null || choiceMissing(choice)) return null;
  const text = choice.kind === 'other' ? choice.text.trim() : (item.options[choice.index] ?? '');
  if (!text) return null;
  if (!item.unresolved && text === item.options[0]) return null;
  return { candidateId: item.candidateId, answer: text };
}
