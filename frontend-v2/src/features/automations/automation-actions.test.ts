import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/**
 * ★★ AU2 (dev, 2026-10-14, measured): the create's revalidate payload (the
 * whole tree) replaced the router's state under the push to the new builder.
 * The action now opens the builder itself, and revalidates nothing.
 * ⚠ The platform is mocked: nothing here creates or deletes anything.
 */
const { post, del, revalidatePath, redirect } = vi.hoisted(() => ({
  post: vi.fn(),
  del: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('next-intl/server', () => ({ getLocale: async () => 'he' }));
vi.mock('@/i18n/navigation', () => ({ redirect }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ post, delete: del }) }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: vi.fn() }));
vi.mock('@/observability/logger', () => ({ logger: { warn: vi.fn() } }));

const { createAutomation, deleteAutomation } = await import('./automation-actions');

const BODY = { name: 'x', trigger: { type: 'message_received' as const, config: {} } };

beforeEach(() => {
  post.mockReset();
  del.mockReset();
  revalidatePath.mockReset();
  redirect.mockReset();
});

describe('★★ AU2 - the new automation’s builder is opened by the action, with no tree to race it', () => {
  it('★★ made: redirected to its builder, in the reader’s locale - and nothing revalidated', async () => {
    post.mockResolvedValue({ data: { id: 'new1' } });
    await createAutomation(BODY);
    expect(redirect).toHaveBeenCalledWith({ href: '/studio/automations/new1', locale: 'he' });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('refused: said, never redirected', async () => {
    post.mockRejectedValue(new ApiError({ kind: 'tenant_inactive', status: 402 }));
    expect(await createAutomation(BODY)).toEqual({ ok: false, reason: 'limit' });
    expect(redirect).not.toHaveBeenCalled();
  });

  it('★ a redirect thrown is not swallowed as a failure', async () => {
    post.mockResolvedValue({ data: { id: 'new1' } });
    redirect.mockImplementation(() => {
      throw new Error('NEXT_REDIRECT');
    });
    await expect(createAutomation(BODY)).rejects.toThrow('NEXT_REDIRECT');
  });

  it('delete revalidates nothing either - the builder’s push back to the list is not raced', async () => {
    del.mockResolvedValue({});
    expect(await deleteAutomation('a1')).toBe(true);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
