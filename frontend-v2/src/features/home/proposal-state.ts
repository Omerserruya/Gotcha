'use server';

import { z } from 'zod';

import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { proposalStateOf, type ProposalState } from '@/api/contracts/assistant-threads';
import { approvalEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/*
 * Only the three fields the state is made of. The full approval schema
 * requires fields this card never shows, and one of them missing would turn a
 * readable request into "unknown".
 */
const stateOnly = z.object({
  approval: z.object({
    status: z.string(),
    executionState: z.string().catch('NOT_STARTED'),
    expiresAt: z.string(),
  }),
});

/**
 * A proposal's current state, read from its approval request
 * (`GET /api/approvals/:id`, as Approvals reads it for this person) - for when
 * it was decided or expired somewhere else while the card was on screen.
 * `null`: not readable now (gone, not theirs, a failed read); keep what is shown.
 */
export async function readProposalState(id: string): Promise<ProposalState | null> {
  try {
    const read = await serverApi().get({
      endpoint: approvalEndpoints.detail(id),
      payload: stateOnly,
      raw: true,
    });
    return proposalStateOf(read.approval);
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('home.proposal_read_failed', { cause });
    return null;
  }
}
