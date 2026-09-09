import { z } from 'zod';

/**
 * Setup state, for Home's day-one face.
 *
 * The design names four states per step and they are not interchangeable:
 *
 *   `done`    — finished, with a timestamp
 *   `next`    — the single step to do now. Exactly one step is ever next
 *   `waiting` — available, but not the thing to do yet
 *   `blocked` — cannot start until something else finishes
 *
 * Shapes are unconfirmed: `/api/onboarding/status` and its siblings declare no
 * response schema, like everything else on this platform. They are written
 * tolerantly and marked, and `npm run api:probe` will tighten them the moment
 * there is a token to probe with.
 */
export const SETUP_STEP_STATES = ['done', 'next', 'waiting', 'blocked'] as const;
export type SetupStepState = (typeof SETUP_STEP_STATES)[number];

export const setupStepSchema = z.looseObject({
  id: z.string().min(1),
  title: z.string().optional(),
  /** One line saying what is still not possible until this is done. */
  description: z.string().optional(),
  state: z.enum(SETUP_STEP_STATES).catch('waiting'),
  /** Label for the step's own action, e.g. "Connect Shopify". */
  actionLabel: z.string().optional(),
  /** Where the action goes. Validated with `safeInternalPath` before use. */
  actionHref: z.string().nullable().optional(),
  /** Rough effort, shown beside the action on the next step only. */
  estimateMinutes: z.number().nullable().optional(),
  completedAt: z.string().nullable().optional(),
});

export const setupStatusSchema = z.looseObject({
  steps: z.array(setupStepSchema).default([]),
  /** True once the workspace can reach customers. */
  isLive: z.boolean().default(false),
  /** Days remaining on the trial, when there is one. */
  trialDaysLeft: z.number().nullable().optional(),
});

export type SetupStep = z.infer<typeof setupStepSchema>;
export type SetupStatus = z.infer<typeof setupStatusSchema>;
