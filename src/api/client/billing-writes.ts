import 'server-only';

import { serverEnv } from '@/config/env.server';

/**
 * May billing move money from this deployment? `BILLING_WRITES=on` only -
 * fail closed (env.server.ts). Read by every billing write before it calls
 * anything, and by the pages that decide whether to hand a write to the
 * screen at all.
 */
export function billingWritesEnabled(): boolean {
  return serverEnv().BILLING_WRITES === 'on';
}
