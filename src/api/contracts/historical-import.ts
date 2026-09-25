import { z } from 'zod';

/**
 * Importing and learning from a number's history — screen 13e.
 *
 * `GET /api/historical-imports/:id`, polled.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE DESIGN HAS FIVE STEPS AND THE PLATFORM REPORTS THREE
 * ════════════════════════════════════════════════════════════════════════════
 *   design    connected → history imported → learning language and tone →
 *             finding questions and answers → remembering customers
 *   platform  transferring | analyzing | ready   (+ failed, unavailable)
 *
 * `analyzing` covers the design's last three. A five-segment bar would show
 * three that never light independently — they flip together, and simultaneity
 * reads as *"those took no time"* rather than *"we cannot see inside this"*.
 * The merchant cannot tell the difference and will draw the flattering
 * conclusion, which is the wrong one.
 *
 * So: three states, and the design's five names kept as PROSE describing what
 * happens during the one that covers them. Same words, honest structure,
 * nothing implied about order or granularity.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * AND THE "EARLY FINDINGS" ARE COUNTS, NOT FINDINGS
 * ════════════════════════════════════════════════════════════════════════════
 * `topTopics` is written by the analytics stage — **eight of nine**. By the
 * time there are topics, the work is done: they cannot fill the wait, they
 * end it, and presenting them as early findings would claim a progressive
 * discovery that never happened.
 *
 * What genuinely moves is counts, and the schema calls them *"counts of rows
 * the pipeline actually finished"* — which is the licence to say **read**
 * rather than "processed".
 */

export const IMPORT_STAGES = [
  'transferring',
  'analyzing',
  'ready',
  'failed',
  'unavailable',
] as const;
export type ImportStage = (typeof IMPORT_STAGES)[number];

export const importStatusSchema = z.object({
  id: z.string(),
  stage: z.enum(IMPORT_STAGES),
  percent: z.number().default(0),
  analysisPercent: z.number().default(0),
  /** Counts of rows the pipeline actually finished. */
  customersAnalyzed: z.number().default(0),
  customersTotal: z.number().default(0),
  conversationsExtracted: z.number().default(0),
  conversationsEligible: z.number().default(0),
  knowledgeCandidateCount: z.number().default(0),
  /** Which stage broke. Present only on a failure, and not always then. */
  failedStage: z.string().nullable().default(null),
  failureReason: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
  topTopics: z.array(z.unknown()).default([]),
});

export type ImportStatus = z.infer<typeof importStatusSchema>;

/** Is anything still happening? Decides whether the screen keeps polling. */
export function isRunning(status: ImportStatus): boolean {
  return status.stage === 'transferring' || status.stage === 'analyzing';
}

/**
 * Work finished so far, as counts rather than as discoveries.
 *
 * Null for a figure whose denominator is still zero: "0 of 0 read" is not
 * progress, it is a pipeline that has not started counting, and rendering it
 * as a ratio invites a reader to conclude nothing is happening.
 */
export interface WorkDone {
  readonly conversationsRead: number;
  readonly conversationsTotal: number | null;
  readonly customersRead: number;
  readonly customersTotal: number | null;
  readonly answersFound: number;
}

export function workDone(status: ImportStatus): WorkDone {
  return {
    conversationsRead: status.conversationsExtracted,
    conversationsTotal: status.conversationsEligible > 0 ? status.conversationsEligible : null,
    customersRead: status.customersAnalyzed,
    customersTotal: status.customersTotal > 0 ? status.customersTotal : null,
    answersFound: status.knowledgeCandidateCount,
  };
}

/** Has anything at all been counted yet? */
export function hasMeasuredAnything(status: ImportStatus): boolean {
  const done = workDone(status);
  return done.conversationsRead > 0 || done.customersRead > 0 || done.answersFound > 0;
}

/**
 * `GET /api/historical-imports` → `{ imports }`, newest first, capped at 20.
 *
 * `imports` is the only key, but it is still a sibling rather than the
 * payload, so a reader must not let the envelope be unwrapped.
 */
export const importListSchema = z.object({
  imports: z.array(importStatusSchema),
});
