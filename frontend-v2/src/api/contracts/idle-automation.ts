import { z } from 'zod';

/**
 * Follow-up and auto-close (S3, Omer 2026-10-13) - `GET/PUT
 * /api/agents/settings/idle-automation` (auth agents.ts), Owner only, the
 * GET included. Durable since Backend's B8 (2026-10-12).
 *
 * What the platform does with it (incoming-worker idle-conversation.worker.ts):
 * - only conversations OPEN or WAITING, ASSIGNED TO A PERSON, whose last
 *   message is ours (not a system row) - the customer has not answered us;
 * - the reminder after `reminderDelayMinutes` from our last message, once per
 *   silence; an empty message sends nothing;
 * - the close after `autoCloseDelayMinutes` from our last message - and a
 *   sent reminder IS our last message, so after one the close counts from it;
 * - on WhatsApp past the customer's 24h window the reminder is skipped and
 *   logged, and the close still happens, without its message.
 *
 * A value the route would not have written reads as absent, per field.
 */
const delay = z.number().min(1).max(10080).nullable().default(null).catch(null);
const message = z.string().max(1000).nullable().default(null).catch(null);

export const idleAutomationSchema = z.object({
  reminderEnabled: z.boolean().catch(false),
  reminderDelayMinutes: delay,
  reminderMessage: message,
  autoCloseEnabled: z.boolean().catch(false),
  autoCloseDelayMinutes: delay,
  autoCloseMessage: message,
});
export type IdleAutomation = z.infer<typeof idleAutomationSchema>;

/** The PUT's limit, in minutes: seven days. */
export const IDLE_DELAY_MAX_MINUTES = 10080;
