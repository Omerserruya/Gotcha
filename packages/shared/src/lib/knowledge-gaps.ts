/**
 * The two quiet-day sources: questions we could not answer, and demand for
 * things not in the catalogue.
 *
 * Both are RECORDED AT THE MOMENT OF FAILURE and never inferred later.
 * /api/analytics/top-questions cannot serve either of them - it ranks intent
 * slugs by frequency and has no concept of a miss, so a question asked thirty
 * times and answered badly thirty times looks exactly like a popular one.
 *
 * Both count CLUSTERS rather than events: one row per question shape per
 * tenant, incremented. One row per ask would make "asked by 33 people" a GROUP
 * BY over an unbounded table, and the table would grow with traffic rather than
 * with the number of distinct gaps, which is the thing anyone wants to read.
 */
import { prisma } from "./prisma";

/**
 * Why retrieval could not answer.
 *
 * `conflicting` is DECLARED BUT NOT YET WRITTEN. Deciding that two passages
 * disagree - rather than that they corroborate each other - takes reading them,
 * and the only component allowed to make a new LLM call is services/ai, not the
 * retrieval path this is recorded from. It stays in the domain so the frontend
 * can be built against the whole set, and the day a writer exists nothing here
 * changes. It is not silently mapped onto `low_confidence`: "we found nothing
 * good enough" and "we found two answers that disagree" need different fixes
 * from the owner, and reporting one as the other sends them to rewrite an
 * article that was fine.
 */
export const UNANSWERED_REASONS = ["no_knowledge", "low_confidence", "conflicting"] as const;
export type UnansweredReason = (typeof UNANSWERED_REASONS)[number];

// The low-confidence threshold lives with its only reader, the retrieval in
// services/ai (KNOWLEDGE_GAP_SCORE in knowledge.service.ts), where it was
// recalibrated against measured scores.

/** Words that carry no topic. Trimmed so phrasing does not fragment a cluster. */
const STOPWORDS = new Set([
  "a","an","the","is","are","was","were","be","been","do","does","did","can","could",
  "will","would","should","i","you","we","they","it","my","your","our","their","me",
  "to","of","in","on","at","for","with","and","or","but","if","how","what","when",
  "where","who","why","which","that","this","there","please","hi","hello","thanks",
]);

/**
 * A stable key for the SHAPE of a question.
 *
 * Lowercased, punctuation stripped, stopwords removed, remaining words sorted.
 * Sorting is what makes "how do I return a package" and "package return, how?"
 * one cluster instead of two - word order carries almost nothing here, and an
 * owner reading the list wants one row for that gap, not five.
 *
 * Deterministic and cheap on purpose. Embedding-clustering the questions would
 * group better and would put an LLM call in the path of every unanswered
 * message, on the one code path that is already failing.
 */
export function clusterKeyFor(question: string): string {
  const words = question
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
  // Everything was a stopword - a bare "hello?" reaching retrieval. Keep the
  // normalised original rather than collapsing every such message into one
  // meaningless cluster.
  if (words.length === 0) return question.toLowerCase().trim().slice(0, 120) || "empty";
  return [...new Set(words)].sort().join(" ").slice(0, 200);
}

export interface RecordUnansweredInput {
  tenantId: string;
  question: string;
  reason: UnansweredReason;
  /** Distinguishes "one person asked six times" from "six people asked once". */
  askerKey?: string | null;
}

/**
 * Record that a question went unanswered.
 *
 * Never throws. This sits on the inbound message path, and a failure to record
 * a gap must not become a failure to reply to the customer - the notebook
 * cannot be allowed to break the conversation it is taking notes about.
 */
export async function recordUnansweredQuestion(input: RecordUnansweredInput): Promise<void> {
  try {
    const question = input.question.trim().slice(0, 500);
    if (!question) return;
    const clusterKey = clusterKeyFor(question);

    const existing = await prisma.unansweredQuestion.findUnique({
      where: { tenantId_clusterKey: { tenantId: input.tenantId, clusterKey } },
      select: { id: true, askedBy: true, resolvedAt: true },
    });

    if (!existing) {
      await prisma.unansweredQuestion.create({
        data: {
          tenantId: input.tenantId,
          question,
          clusterKey,
          reason: input.reason,
          askCount: 1,
          askedBy: 1,
        },
      });
      return;
    }

    await prisma.unansweredQuestion.update({
      where: { id: existing.id },
      data: {
        askCount: { increment: 1 },
        lastAskedAt: new Date(),
        // Being asked again is exactly the evidence that the fix did not land,
        // so a resolved gap reopens rather than staying quietly closed.
        resolvedAt: existing.resolvedAt ? null : undefined,
        // Approximated, not counted: holding the set of askers would mean a
        // second table for a number that only has to be right enough to sort
        // by. It counts people when we can tell them apart and stays put when
        // we cannot, so it never OVERSTATES reach.
        askedBy: input.askerKey ? { increment: 1 } : undefined,
      },
    });
  } catch (err) {
    console.warn("[knowledge-gaps] failed to record unanswered question:", (err as Error).message);
  }
}

/** ISO-8601 week key, "2026-W36". Sorts lexically, which is why it is text. */
export function isoWeekKey(d: Date = new Date()): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // ISO weeks belong to the year containing their Thursday, so a date in early
  // January can be week 52 of the year before. Shifting to that Thursday first
  // is what makes the year and the week agree.
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export interface RecordDemandInput {
  tenantId: string;
  term: string;
  /** Whether the catalogue had a match. False is the interesting case. */
  inCatalogue: boolean;
  askerKey?: string | null;
  at?: Date;
}

/**
 * Record that somebody searched the catalogue for a term.
 *
 * Matches are recorded too, not just misses. A term that STOPS matching after a
 * product is delisted then shows up as a change in an existing row rather than
 * as a brand-new gap, which is the difference between "we never sold this" and
 * "we stopped selling this and people are still asking".
 *
 * Never throws, for the same reason as above.
 */
export async function recordProductDemand(input: RecordDemandInput): Promise<void> {
  try {
    const term = input.term.trim().toLowerCase().slice(0, 120);
    if (!term) return;
    const weekKey = isoWeekKey(input.at ?? new Date());

    await prisma.productDemandTerm.upsert({
      where: { tenantId_term_weekKey: { tenantId: input.tenantId, term, weekKey } },
      create: {
        tenantId: input.tenantId,
        term,
        weekKey,
        inCatalogue: input.inCatalogue,
        askCount: 1,
        askedBy: 1,
      },
      update: {
        askCount: { increment: 1 },
        lastSeenAt: new Date(),
        inCatalogue: input.inCatalogue,
        askedBy: input.askerKey ? { increment: 1 } : undefined,
      },
    });
  } catch (err) {
    console.warn("[knowledge-gaps] failed to record product demand:", (err as Error).message);
  }
}
