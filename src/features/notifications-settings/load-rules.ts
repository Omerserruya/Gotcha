import 'server-only';

import { z } from 'zod';

import { serverApi } from '@/api/client/server-api';
import { notificationEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * The tenant's notification rules.
 *
 * `GET /api/notification-preferences` — ADMIN only, `{ data }` enveloped,
 * filterable by `departmentId` and `eventType`. This is the table the
 * dispatcher at `notification-engine.service.ts:133` actually reads.
 *
 * **The shape here is the minimum the day-one state needs.** The full rule —
 * recipients, channels, conditions, priority — is deliberately not modelled
 * yet: the backend is confirming the exact contract and whether the route is
 * reachable through both gateway templates, and committing to a shape before
 * that answer would be guessing at the one thing worth waiting for.
 *
 * `null` means the read failed and is never conflated with an empty list. On
 * this screen the difference is stark: no rules means GOTCHA is telling nobody
 * about anything, which is a real state an admin must be able to see and act
 * on; a failed read means they learned nothing.
 */
const ruleSchema = z.object({
  id: z.string().min(1),
  eventType: z.string().min(1),
});

const rulesSchema = z.array(ruleSchema);

export interface RulesData {
  readonly rules: readonly z.infer<typeof ruleSchema>[];
  readonly available: boolean;
}

export async function loadRules(): Promise<RulesData> {
  try {
    const rules = await serverApi().get({
      endpoint: notificationEndpoints.rules(),
      payload: rulesSchema,
    });
    return { rules, available: true };
  } catch (cause) {
    logger.warn('notification_rules.read_failed', { cause });
    return { rules: [], available: false };
  }
}
