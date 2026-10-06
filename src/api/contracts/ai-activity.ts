import { z } from 'zod';

import { ACTIVITY_STATUSES } from '@/lib/ai-activity-status';

/**
 * The AI's steps in one conversation - Backend ed0f1c9c.
 *
 * `GET /api/ai-assist/:conversationId/ai-activity?limit=` reads the
 * orchestrator's own rows (one per tool call) and projects them without the
 * arguments or the result: `{ data: [{ id, tool, labelKey, status,
 * proposedAt, startedAt, completedAt, durationMs, error }] }`, newest first.
 * Live: `ai.activity.updated` on `conv:{id}`, one per step change.
 */

export { ACTIVITY_STATUSES, type ActivityStatus } from '@/lib/ai-activity-status';

/**
 * Every `labelKey` `labelKeyFor` can return (ai-activity.service.ts). A key
 * not in this list is drawn as `working` - the service's own fallback.
 */
export const ACTIVITY_LABELS = [
  'looking_up_order',
  'checking_products',
  'processing_refund',
  'cancelling_order',
  'handling_return',
  'checking_delivery',
  'updating_order',
  'creating_discount',
  'sending_order_email',
  'adding_note',
  'checking_calendar',
  'booking_meeting',
  'identifying_customer',
  'saving_customer',
  'tagging_customer',
  'scheduling_followup',
  'handing_to_team',
  'working',
] as const;
export type ActivityLabel = (typeof ACTIVITY_LABELS)[number];

export const labelOf = (key: string): ActivityLabel =>
  (ACTIVITY_LABELS as readonly string[]).includes(key) ? (key as ActivityLabel) : 'working';

export const activityStepSchema = z.object({
  id: z.string().min(1),
  tool: z.string().catch(''),
  labelKey: z.string().catch('working'),
  /*
   * ★ ONE UNKNOWN STATUS IS ONE STEP DRAWN QUIETLY, NOT A REJECTED LIST.
   *   `null` here is "a status this screen does not know".
   */
  status: z.enum(ACTIVITY_STATUSES).nullable().catch(null),
  proposedAt: z.string().nullable().catch(null).default(null),
  startedAt: z.string().nullable().catch(null).default(null),
  completedAt: z.string().nullable().catch(null).default(null),
  durationMs: z.number().nonnegative().nullable().catch(null).default(null),
  error: z.string().nullable().catch(null).default(null),
});
export type ActivityStep = z.infer<typeof activityStepSchema>;

/* Strict on the envelope: a service older than ed0f1c9c answers 404/HTML, which is "unread". */
export const activityResponseSchema = z.object({ data: z.array(activityStepSchema) });
