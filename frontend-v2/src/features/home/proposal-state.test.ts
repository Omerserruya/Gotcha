import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/** At the wire. `serverApi` is mocked: nothing is read. */
const get = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get }) }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: vi.fn(async () => undefined) }));
vi.mock('server-only', () => ({}));

import { readProposalState } from './proposal-state';

beforeEach(() => {
  get.mockReset();
});

describe('★ a proposal re-read is its approval request, as Approvals reads it', () => {
  it('reads GET /api/approvals/:id, and only the fields the state is made of', async () => {
    // No summary, no tool: the card does not show them, so they cannot fail it.
    get.mockResolvedValueOnce({
      approval: {
        status: 'APPROVED',
        executionState: 'SUCCEEDED',
        expiresAt: '2099-01-01T00:00:00Z',
      },
    });
    expect(await readProposalState('ap1')).toBe('executed');
    const [call] = get.mock.calls[0]!;
    expect(call.endpoint.path).toBe('/api/approvals/ap1');
    expect(call.raw).toBe(true);
  });

  it('a failed or forbidden read is null - the card keeps what it showed', async () => {
    get.mockRejectedValueOnce(new ApiError({ kind: 'not_found', status: 404 }));
    expect(await readProposalState('gone')).toBeNull();
  });
});
