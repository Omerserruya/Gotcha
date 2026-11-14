'use server';

import type { MfaGate } from '@/api/contracts/mfa';

import { readMfaGate } from './read-mfa-gate';

/**
 * The gate's re-check while it is open: every few seconds, on focus, and when
 * the framed flow moves on. `null` (not read) keeps the gate as it was:
 * a network blip must never release it (the legacy gate's fail-open fix).
 */
export async function checkMfaGate(): Promise<MfaGate | null> {
  return readMfaGate();
}
