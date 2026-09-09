import { z } from 'zod';

/**
 * Setup state, for Home's day-one face.
 *
 * Shapes confirmed against the backend on 2026-09-09.
 *
 * The four states are not interchangeable:
 *
 *   `done`    — finished, with a timestamp
 *   `next`    — the single step to do now. Exactly one is ever next
 *   `waiting` — available, but not the thing to do yet
 *   `blocked` — cannot start until the steps in `blockedBy` finish
 *
 * `next` is the SERVER's decision. Two surfaces computing "what should I do
 * now" from the same booleans will disagree the moment either changes, and the
 * one thing this block promises is that exactly one step is next.
 *
 * There is no copy in this response, deliberately: titles and descriptions are
 * translated text and live in the frontend, keyed on `id`. Prose from the
 * server is prose that cannot be rendered in Hebrew.
 */
export const SETUP_STEP_STATES = ['done', 'next', 'waiting', 'blocked'] as const;
export type SetupStepState = (typeof SETUP_STEP_STATES)[number];

export const setupStepSchema = z.looseObject({
  id: z.string().min(1),
  /** Unrecognised grades read as `waiting`: shown, but not urged. */
  state: z.enum(SETUP_STEP_STATES).catch('waiting'),
  completedAt: z.string().nullable().optional(),
  /** Step ids still in the way. Non-empty only when `blocked`. */
  blockedBy: z.array(z.string()).default([]),
  estimateMinutes: z.number().default(0),
});

export const setupStatusSchema = z.looseObject({
  steps: z.array(setupStepSchema).default([]),
  /** True once the workspace can reach real customers. */
  isLive: z.boolean().default(false),
  goLive: z
    .looseObject({
      eligible: z.boolean().default(false),
      /** Which steps hold it back. Not every step gates going live. */
      blockedBy: z.array(z.string()).default([]),
    })
    .optional(),
  /** Null when the workspace is not on a trial at all. */
  trial: z
    .looseObject({
      daysRemaining: z.number().nullable().optional(),
      conversationsUsed: z.number().default(0),
    })
    .nullable()
    .optional(),
});

export type SetupStep = z.infer<typeof setupStepSchema>;
export type SetupStatus = z.infer<typeof setupStatusSchema>;

/**
 * `GET /api/knowledge/ingest/latest` — what came back from pointing GOTCHA at
 * a website.
 *
 * The whole response is `null` when no scan has ever run: "we read nothing" and
 * "we have not looked" are different things and the first step says so.
 *
 * `pendingTopics` is a SAMPLE. The line names three; the true total is
 * `answersNeedingConfirmation`, and the two must not be confused.
 */
export const knowledgeIngestSchema = z
  .looseObject({
    pagesRead: z.number().default(0),
    answersDrafted: z.number().default(0),
    answersNeedingConfirmation: z.number().default(0),
    pendingTopics: z
      .array(
        z.looseObject({
          id: z.string(),
          topic: z.string(),
          category: z.string().nullable().optional(),
        }),
      )
      .default([]),
    /** Null while the scan is still running. */
    finishedAt: z.string().nullable().optional(),
  })
  .nullable();

export type KnowledgeIngest = z.infer<typeof knowledgeIngestSchema>;
