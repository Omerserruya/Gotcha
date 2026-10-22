import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/*
 * ⚠ Hiring is REAL on a live workspace. Nothing here reaches a server:
 * serverApi is replaced, and every call is recorded in the order it ran.
 */
const calls = vi.hoisted(() => [] as { method: string; path: string; body: unknown }[]);
const answers = vi.hoisted(() => ({
  fail: null as null | { at: string; error: unknown },
  /* The draft after the seed: one tool given, one not, a built-in. */
  tools: [
    { toolName: 'shopify.get_order', granted: true },
    { toolName: 'shopify.process_refund', granted: false },
    { toolName: 'send_message', granted: null },
  ] as unknown,
  grant: { ok: true } as { ok: true } | { ok: false; reason: string },
}));
const record =
  (method: string) => async (request: { endpoint: { path: string }; body?: unknown }) => {
    const key = `${method} ${request.endpoint.path}`;
    if (answers.fail && key === answers.fail.at) throw answers.fail.error;
    calls.push({ method, path: request.endpoint.path, body: request.body });
    if (method === 'GET') return answers.tools;
    if (method === 'POST' && request.endpoint.path === '/api/funnels') return { id: 'row1' };
    return method === 'POST' && request.endpoint.path.endsWith('/builder/start')
      ? { agentId: 'd1' }
      : {};
  };
/* The employee page's shared grant action, recorded in the same order. */
const setEmployeeToolGrant = vi.hoisted(() =>
  vi.fn(async (id: string, toolName: string, granted: boolean) => {
    calls.push({ method: 'GRANT', path: id, body: { toolName, granted } });
    return answers.grant;
  }),
);
vi.mock('../page/tool-grant-actions', () => ({ setEmployeeToolGrant }));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({
  serverApi: () => ({
    get: record('GET'),
    post: record('POST'),
    patch: record('PATCH'),
    put: record('PUT'),
  }),
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
  disclosesAi: false,
  funnel: null,
  grants: [
    { toolName: 'shopify.get_order', give: true },
    { toolName: 'shopify.process_refund', give: true },
    { toolName: 'shopify.cancel_order', give: false },
  ],
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
  answers.grant = { ok: true };
  setEmployeeToolGrant.mockClear();
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
          disclosesAi: false,
        },
      },
      { method: 'POST', path: '/api/ai-agents/builder/d1/refinements', body: { name: 'Ronnie' } },
      // The draft's real grants, after the seed - then only the difference.
      { method: 'GET', path: '/api/ai-agents/d1/tools', body: undefined },
      { method: 'GRANT', path: 'd1', body: { toolName: 'shopify.process_refund', granted: true } },
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

  it('★ H8c: Sales sends its role and funnel together, in the one PATCH', async () => {
    await hireEmployee({ ...REQUEST, role: 'sales', funnel: { id: 'f1' } });
    expect(calls[1]).toMatchObject({
      method: 'PATCH',
      body: { role: 'sales', funnelId: 'f1' },
    });
    expect(calls.some((c) => c.path === '/api/funnels')).toBe(false);
  });

  it('★★ H8c: from a template - created after /start, never active, its row’s id in the PATCH', async () => {
    await hireEmployee({ ...REQUEST, role: 'sales', funnel: { template: 'saas-default' } });
    expect(calls.slice(0, 3)).toEqual([
      expect.objectContaining({ path: '/api/ai-agents/builder/start' }),
      { method: 'POST', path: '/api/funnels', body: { template: 'saas-default' } },
      expect.objectContaining({
        method: 'PATCH',
        body: expect.objectContaining({ role: 'sales', funnelId: 'row1' }),
      }),
    ]);
  });

  it('a template refused: said, the draft saved, no PATCH, no complete()', async () => {
    answers.fail = {
      at: 'POST /api/funnels',
      error: new ApiError({ kind: 'validation', status: 400, code: 'UNKNOWN_TEMPLATE' }),
    };
    expect(
      await hireEmployee({ ...REQUEST, role: 'sales', funnel: { template: 'x' } }),
    ).toMatchObject({
      ok: false,
      id: 'd1',
      saved: ['draft'],
      failed: 'funnel',
      reason: 'unknown_template',
    });
    expect(calls.map((c) => c.method)).toEqual(['POST']);
  });

  it('★ H8a: what is given already, and what is not to be, sends nothing', async () => {
    answers.tools = [
      { toolName: 'shopify.get_order', granted: true },
      { toolName: 'shopify.process_refund', granted: true },
      { toolName: 'shopify.cancel_order', granted: true },
    ];
    await hireEmployee(REQUEST);
    expect(setEmployeeToolGrant.mock.calls).toEqual([['d1', 'shopify.cancel_order', false]]);
    answers.tools = [
      { toolName: 'shopify.get_order', granted: true },
      { toolName: 'shopify.process_refund', granted: false },
      { toolName: 'send_message', granted: null },
    ];
  });

  it('no grants, skills or levels: none of their routes is called', async () => {
    await hireEmployee({ ...REQUEST, grants: [], skillIds: [], levels: [] });
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
      saved: ['draft', 'settings', 'name', 'grants', 'skills'],
      failed: 'levels',
      reason: 'failed',
      levels: { saved: 1, total: 2 },
      grants: { saved: 1, total: 1 },
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
      saved: ['draft', 'settings', 'name', 'grants', 'skills', 'levels'],
    });
  });
});

describe('★★ H8a - a grant refused is a failed write like the others', () => {
  it('404 TOOL_NOT_PROVISIONED: said, the earlier writes saved, nothing after it, no complete()', async () => {
    answers.grant = { ok: false, reason: 'not_provisioned' };
    expect(await hireEmployee(REQUEST)).toEqual({
      ok: false,
      id: 'd1',
      saved: ['draft', 'settings', 'name'],
      failed: 'grants',
      reason: 'not_provisioned',
      levels: { saved: 0, total: 2 },
      grants: { saved: 0, total: 1 },
    });
    expect(calls.some((c) => c.method === 'PUT' || c.path.endsWith('/complete'))).toBe(false);
  });

  it('the draft’s tools unread: the grants are not saved, and it stops there', async () => {
    answers.fail = {
      at: 'GET /api/ai-agents/d1/tools',
      error: new ApiError({ kind: 'server', status: 500 }),
    };
    expect(await hireEmployee(REQUEST)).toMatchObject({ failed: 'grants', reason: 'failed' });
    expect(setEmployeeToolGrant).not.toHaveBeenCalled();
  });
});
