import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/*
 * ⚠ Hiring is REAL on a live workspace. Nothing here reaches a server:
 * serverApi is replaced, and every call is recorded in the order it ran.
 */
const calls = vi.hoisted(() => [] as { method: string; path: string; body: unknown }[]);
const answers = vi.hoisted(() => ({ fail: null as null | { at: string; error: unknown } }));
const record =
  (method: string) => async (request: { endpoint: { path: string }; body?: unknown }) => {
    const key = `${method} ${request.endpoint.path}`;
    if (answers.fail && key === answers.fail.at) throw answers.fail.error;
    calls.push({ method, path: request.endpoint.path, body: request.body });
    return method === 'POST' && request.endpoint.path.endsWith('/builder/start')
      ? { agentId: 'd1' }
      : {};
  };
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({
  serverApi: () => ({ post: record('POST'), patch: record('PATCH'), put: record('PUT') }),
}));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: async () => {} }));

import type { HireRequest } from './hire-plan';
import { hireEmployee } from './hire-actions';

const REQUEST: HireRequest = {
  goal: 'Answer customers about their orders.',
  role: 'customer_support',
  name: 'Ronnie',
  escalationRules: [{ label: 'they ask for a person', enabled: true }],
  integrationAccess: ['shopify'],
  knowledgeBaseIds: ['k1', 'k2'],
  skillIds: ['s2', 's1'],
  levels: [
    { toolName: 'shopify.process_refund', level: 'never' },
    { toolName: 'send_message', level: 'ask' },
  ],
  locale: 'he',
};

beforeEach(() => {
  calls.length = 0;
  answers.fail = null;
});

describe('★★ H5 - the hire at the wire: the exact calls, in order, with their bodies', () => {
  it('a new draft, the plan written onto it, complete() last', async () => {
    expect(await hireEmployee(REQUEST)).toEqual({ ok: true, id: 'd1' });
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/api/ai-agents/builder/start',
        // forceNew: never resume (and overwrite) another unfinished draft.
        body: { goal: 'Answer customers about their orders.', forceNew: true, locale: 'he' },
      },
      {
        method: 'PATCH',
        path: '/api/ai-agents/d1',
        // status DRAFT: the PATCH would otherwise promote a ready draft before complete().
        body: {
          status: 'DRAFT',
          role: 'customer_support',
          goal: 'Answer customers about their orders.',
          escalationRules: [{ label: 'they ask for a person', enabled: true }],
          integrationAccess: ['shopify'],
          knowledgeBaseIds: ['k1', 'k2'],
        },
      },
      { method: 'POST', path: '/api/ai-agents/builder/d1/refinements', body: { name: 'Ronnie' } },
      {
        method: 'PUT',
        path: '/api/ai-agents/d1/skills',
        body: [
          { skillId: 's2', mode: 'watch', order: 0 },
          { skillId: 's1', mode: 'watch', order: 1 },
        ],
      },
      {
        method: 'PUT',
        path: '/api/ai-agents/d1/tool-levels/shopify.process_refund',
        body: { level: 'never' },
      },
      { method: 'PUT', path: '/api/ai-agents/d1/tool-levels/send_message', body: { level: 'ask' } },
      { method: 'POST', path: '/api/ai-agents/builder/d1/complete', body: { locale: 'he' } },
    ]);
  });

  it('no skills and no levels: neither route is called', async () => {
    await hireEmployee({ ...REQUEST, skillIds: [], levels: [] });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/ai-agents/builder/start',
      'PATCH /api/ai-agents/d1',
      'POST /api/ai-agents/builder/d1/refinements',
      'POST /api/ai-agents/builder/d1/complete',
    ]);
  });

  it('★ a draft left by a stopped hire is continued, never a second one started', async () => {
    expect(await hireEmployee(REQUEST, 'd0')).toEqual({ ok: true, id: 'd0' });
    expect(calls[0]).toMatchObject({ method: 'PATCH', path: '/api/ai-agents/d0' });
    expect(calls.some((c) => c.path.endsWith('/builder/start'))).toBe(false);
  });
});

describe('★★ H5 - a part-way failure stops, says what was saved, and never completes', () => {
  it('a level refused: the earlier writes saved, the rest not tried, no complete()', async () => {
    answers.fail = {
      at: 'PUT /api/ai-agents/d1/tool-levels/send_message',
      error: new ApiError({ kind: 'server', status: 500 }),
    };
    expect(await hireEmployee(REQUEST)).toEqual({
      ok: false,
      id: 'd1',
      saved: ['draft', 'settings', 'name', 'skills'],
      failed: 'levels',
      reason: 'failed',
      levels: { saved: 1, total: 2 },
    });
    expect(calls.some((c) => c.path.endsWith('/complete'))).toBe(false);
  });

  it('the start refused: nothing created, nothing else tried', async () => {
    answers.fail = {
      at: 'POST /api/ai-agents/builder/start',
      error: new ApiError({ kind: 'authorization', status: 403 }),
    };
    expect(await hireEmployee(REQUEST)).toMatchObject({
      ok: false,
      id: null,
      saved: [],
      failed: 'draft',
      reason: 'forbidden',
    });
    expect(calls).toEqual([]);
  });

  it('each refusal its own reason; a draft that is gone is not continued', async () => {
    const stop = async (at: string, init: ConstructorParameters<typeof ApiError>[0]) => {
      calls.length = 0;
      answers.fail = { at, error: new ApiError(init) };
      return hireEmployee(REQUEST);
    };
    expect(
      await stop('PATCH /api/ai-agents/d1', {
        kind: 'validation',
        status: 422,
        code: 'INVALID_INTEGRATION_ACCESS',
      }),
    ).toMatchObject({ reason: 'invalid_access', failed: 'settings', id: 'd1' });
    expect(
      await stop('PATCH /api/ai-agents/d1', {
        kind: 'validation',
        status: 400,
        code: 'INVALID_ESCALATION_RULES',
      }),
    ).toMatchObject({ reason: 'invalid_rules' });
    expect(
      await stop('POST /api/ai-agents/builder/d1/refinements', { kind: 'not_found', status: 404 }),
    ).toMatchObject({ reason: 'gone', failed: 'name', id: null });
    expect(
      await stop('PUT /api/ai-agents/d1/tool-levels/shopify.process_refund', {
        kind: 'validation',
        status: 422,
        code: 'LOOSER_THAN_WORKSPACE',
      }),
    ).toMatchObject({ reason: 'changed', id: 'd1' });
    expect(
      await stop('POST /api/ai-agents/builder/d1/complete', { kind: 'validation', status: 422 }),
    ).toMatchObject({
      reason: 'not_ready',
      failed: 'hired',
      saved: ['draft', 'settings', 'name', 'skills', 'levels'],
    });
  });
});
