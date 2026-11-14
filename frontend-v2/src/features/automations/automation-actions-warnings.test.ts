import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

import { ApiError } from '@/api/client/api-error';

/**
 * ★★ B3 (Backend e16c53bc): a branch no line leaves (`branch_unconnected`) is
 * a warning, never a refusal. It comes back on a live route's PUT
 * (`{ data, warnings }`) and, on activate, only next to errors in a 422.
 * Both must reach the screen.
 *
 * The mock parses each answer with the schema the action passes, so a strict
 * `{ data }` schema that strips `warnings` fails here, as it would in the app.
 * ⚠ The platform is mocked: nothing here saves or activates anything.
 */
const { put, post } = vi.hoisted(() => ({ put: vi.fn(), post: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next-intl/server', () => ({ getLocale: async () => 'he' }));
vi.mock('@/i18n/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ put, post }) }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: vi.fn() }));
vi.mock('@/observability/logger', () => ({ logger: { warn: vi.fn() } }));

const { publishAutomation } = await import('./automation-actions');

type Call = { readonly payload: z.ZodType };
const answers = (fn: typeof put, body: unknown) =>
  fn.mockImplementation(async (o: Call) => o.payload.parse(body));

const route = (status: 'live' | 'draft') => ({
  id: 'a1',
  name: 'Who answers new conversations',
  description: null,
  trigger: { type: 'conversation_started', config: {} },
  status,
  activatedAt: null,
  activatedBy: null,
  pausedAt: null,
  pausedBy: null,
  nodes: [],
  edges: [],
  updatedAt: '2026-11-09T10:00:00.000Z',
  createdAt: '2026-11-09T09:00:00.000Z',
});
const unconnected = {
  severity: 'warning',
  code: 'branch_unconnected',
  nodeId: 'w1',
  message:
    '"Wait for reply" has a branch with no next step (btn:b2, reply, timeout): a customer who takes it gets no answer.',
};
const BODY = {
  name: 'x',
  trigger: { type: 'conversation_started', config: {} },
  nodes: [],
  edges: [],
  expectedUpdatedAt: '2026-11-09T10:00:00.000Z',
};

beforeEach(() => {
  put.mockReset();
  post.mockReset();
});

describe('★★ B3: a branch with no next step is said, never dropped', () => {
  it("a live route saved: the PUT's warning reaches the outcome", async () => {
    answers(put, { data: route('live'), warnings: [unconnected] });
    const r = await publishAutomation('a1', BODY);
    expect(r).toMatchObject({
      ok: true,
      live: true,
      warnings: [{ code: 'branch_unconnected', nodeId: 'w1' }],
    });
    expect(post).not.toHaveBeenCalled();
  });

  it('a live route saved, nothing warned: none, and a PUT without `warnings` still reads', async () => {
    answers(put, { data: route('live') });
    expect(await publishAutomation('a1', BODY)).toMatchObject({
      ok: true,
      live: true,
      warnings: [],
    });
  });

  it("a draft refused going live: the 422's warning follows its errors", async () => {
    answers(put, { data: route('draft') });
    post.mockRejectedValue(
      new ApiError({
        kind: 'validation',
        status: 422,
        issues: {
          errors: [{ severity: 'error', code: 'missing_config', nodeId: 'n2', message: '' }],
          warnings: [unconnected],
        },
      }),
    );
    const r = await publishAutomation('a1', BODY);
    expect(r).toMatchObject({ ok: true, live: false });
    expect(r.ok ? r.blocked.map((i) => i.code) : null).toEqual([
      'missing_config',
      'branch_unconnected',
    ]);
  });

  it("a draft going live: activate's warning reaches the outcome", async () => {
    answers(put, { data: route('draft') });
    answers(post, { data: route('live'), warnings: [unconnected] });
    expect(await publishAutomation('a1', BODY)).toMatchObject({
      ok: true,
      live: true,
      warnings: [{ code: 'branch_unconnected' }],
    });
  });
});
