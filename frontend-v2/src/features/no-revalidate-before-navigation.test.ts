import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ★★ AU2's cause, swept (2026-10-14). Measured on dev: a server action that
 * revalidated sent back the whole re-rendered tree (780 KB), which replaced
 * the router's state and aborted the navigation the screen had already
 * started - the URL never moved. Every action a screen navigates (or
 * refreshes) after now revalidates nothing; the screen does it.
 *
 * Each is driven down its SUCCESS path - asserted, or "no revalidate" would
 * pass vacuously on a failure. ⚠ The platform is mocked: nothing is written.
 */
const { revalidatePath, api } = vi.hoisted(() => {
  const answer = {
    ok: true,
    chatDisabled: false,
    id: 'x1',
    data: { id: 'x1', name: 'n', status: 'active' },
  };
  const call = vi.fn(async (request: { body?: { rules?: unknown } }) =>
    // addCustomer first looks the phone up (a list with rules): nobody has it.
    request.body?.rules ? { data: [] } : answer,
  );
  return {
    revalidatePath: vi.fn(),
    api: { get: call, post: call, put: call, patch: call, delete: call },
  };
});
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath, revalidateTag: vi.fn() }));
vi.mock('next-intl/server', () => ({ getLocale: async () => 'he' }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => api }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: vi.fn() }));
vi.mock('@/observability/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const { disconnectSystem } = await import('./capabilities/connect-actions');
const { deleteDocument } = await import('./knowledge/document-actions');
const { connectWebChat } = await import('./channels/actions');
const { rerunAnalysis } = await import('./channels/candidate-actions');
const { duplicateTemplate, createTemplate, createCampaignDraft } =
  await import('./outreach/create-actions');
const { updateRole } = await import('./roles/actions');
const { saveSkill, archiveSkill } = await import('./skills/skill-actions');
const { addCustomer } = await import('./customers/customer-actions');

const okOf = (result: unknown) =>
  result === true || (typeof result === 'object' && result !== null && 'ok' in result && result.ok);

beforeEach(() => {
  revalidatePath.mockReset();
});

describe('★★ an action a screen navigates after revalidates nothing', () => {
  it.each([
    ['disconnectSystem', () => disconnectSystem('shopify')],
    ['deleteDocument', () => deleteDocument('kb1', 'd1')],
    ['connectWebChat', () => connectWebChat('')],
    ['rerunAnalysis', () => rerunAnalysis('imp1')],
    ['duplicateTemplate', () => duplicateTemplate('t1')],
    [
      'createTemplate',
      () => createTemplate({ name: 'n', body: 'b', category: 'UTILITY', language: 'he' }),
    ],
    [
      'createCampaignDraft',
      () =>
        createCampaignDraft({ name: 'n', channelAccountId: 'a1', channel: 'EMAIL', body: 'hi' }),
    ],
    [
      'updateRole',
      () => updateRole('r1', { name: 'n', description: '', features: [], isSystem: false }),
    ],
    [
      'updateRole (a system role)',
      () => updateRole('r1', { name: 'n', description: '', features: [], isSystem: true }),
    ],
    ['saveSkill', () => saveSkill('s1', { status: 'active' })],
    ['archiveSkill', () => archiveSkill('s1')],
    ['addCustomer', () => addCustomer({ name: 'Dana', phone: '0501234567', email: '' })],
  ] as const)('%s: succeeds, with no revalidatePath', async (_name, run) => {
    const result = await run();
    expect(okOf(result)).toBeTruthy();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
