import { z } from 'zod';

/**
 * A response target (SLA) - the workspace's, or one department's override.
 * `GET/PUT /api/agents/settings/sla` and `…/sla/department/:id` (auth
 * agents.ts): `{ enabled, slaMinutes 1-1440, warningThreshold 0-100 }`, the
 * last two optional on the PUT.
 *
 * ⚠ OWNER ONLY TODAY, THE GETS INCLUDED (`requireRole("ADMIN")`). An agent's
 *   read is a 403, and the inbox then draws no SLA mark at all - never a
 *   "within target" it could not know.
 *
 * ⚠ NOTHING ENFORCES IT. The platform stores the target; the inbox is the one
 *   place it is read, as a mark on the rows that are late.
 *
 * A value the route would not have written (a minute count out of range, a
 * percentage over 100) reads as absent - per field, never the whole answer.
 */
export const slaSettingsSchema = z.object({
  enabled: z.boolean().catch(false),
  slaMinutes: z.number().min(1).max(1440).nullable().default(null).catch(null),
  warningThreshold: z.number().min(0).max(100).nullable().default(null).catch(null),
});
export type SlaSettings = z.infer<typeof slaSettingsSchema>;
