import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';
import { capabilitySchema, type AdminChoice } from '@/api/contracts/capabilities';

/**
 * Screen 10's write (S2, 2026-10-11). The platform is mocked: nothing here
 * reaches it.
 *
 * The action re-checks the ceiling because it is an endpoint - anything that
 * can post can post `do_it`. Its table is the server's: `requiresApproval:
 * false` is refused for delete, financial and administrative, and for a row
 * with no group; every other group goes through to the PUT.
 */
const { put, signInIfSignedOut } = vi.hoisted(() => ({
  put: vi.fn(),
  signInIfSignedOut: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ put }) }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut }));

const { setToolPermission } = await import('./permission-actions');

const tool = (riskGroup: string | null) =>
  capabilitySchema.parse({ toolName: `x.${riskGroup}`, riskGroup });

beforeEach(() => {
  put.mockReset();
  put.mockResolvedValue({});
  signInIfSignedOut.mockReset();
});

describe('★★ the action’s own guard is the server’s table', () => {
  it.each([
    ['read_only', true],
    ['create_update', true],
    ['sensitive_data', true],
    ['delete', false],
    ['financial', false],
    ['administrative', false],
    [null, false],
    ['', false],
  ] as const)('do_it on %s reaches the PUT: %s', async (group, sent) => {
    const result = await setToolPermission(tool(group), 'do_it');
    if (sent) {
      expect(result).toEqual({ ok: true });
      expect(put).toHaveBeenCalledTimes(1);
      const [request] = put.mock.calls[0] as [{ body: unknown }];
      expect(request.body).toEqual({ enabled: true, requiresApproval: false });
    } else {
      expect(result).toEqual({ ok: false, reason: 'not_automatable' });
      expect(put).not.toHaveBeenCalled();
    }
  });

  it.each(['ask_me', 'never'] as const satisfies readonly AdminChoice[])(
    '%s is never refused here, whatever the group',
    async (choice) => {
      for (const group of ['financial', 'delete', 'administrative', null]) {
        expect(await setToolPermission(tool(group), choice)).toEqual({ ok: true });
      }
      expect(put).toHaveBeenCalledTimes(4);
    },
  );
});

describe('★★ the server keeping approval (422) is its own reason', () => {
  it('422 `approval_cannot_be_removed` - not "didn’t save"', async () => {
    put.mockRejectedValueOnce(
      new ApiError({
        kind: 'validation',
        status: 422,
        developerMessage: 'approval_cannot_be_removed',
      }),
    );
    expect(await setToolPermission(tool('create_update'), 'do_it')).toEqual({
      ok: false,
      reason: 'approval_cannot_be_removed',
    });
  });

  it('another 422 stays a failure', async () => {
    put.mockRejectedValueOnce(
      new ApiError({ kind: 'validation', status: 422, developerMessage: 'something_else' }),
    );
    expect(await setToolPermission(tool('create_update'), 'do_it')).toEqual({
      ok: false,
      reason: 'failed',
    });
  });
});
