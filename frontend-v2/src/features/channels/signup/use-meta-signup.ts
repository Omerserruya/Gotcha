'use client';

import type { InspectResponse } from '@/api/contracts/whatsapp-connect';

import { inspectNumbers } from '../whatsapp-actions';
import { useMetaCode, type CodeExchange } from './use-meta-code';

export type SignupProblem = 'cancelled' | 'noCode' | 'inspectFailed' | 'unavailable';

/** The tenant's exchange: the numbers on that account - nothing is connected yet. */
const inspect: CodeExchange<InspectResponse> = (code, assets, launch) =>
  inspectNumbers(code, assets, launch.inspectPath);

/**
 * Meta's Embedded Signup for a workspace's own number: Meta's window
 * (`useMetaCode`), then the numbers on that account are inspected. Nothing is
 * connected until the person picks one (`ConnectWhatsApp`).
 */
export function useMetaSignup(appId: string) {
  const code = useMetaCode<InspectResponse>(appId, inspect);
  const problem: SignupProblem | null =
    code.problem === 'exchangeFailed' ? 'inspectFailed' : code.problem;
  return {
    sdk: code.sdk,
    stage: code.stage,
    problem,
    inspection: code.result,
    start: code.start,
    reset: code.reset,
  };
}
