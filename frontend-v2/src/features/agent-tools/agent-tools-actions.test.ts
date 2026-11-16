import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/* ⚠ Mocked - nothing is sent: these queue servers, set what the AI may do, and call real APIs. */
const { api } = vi.hoisted(() => ({
  api: { post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => api }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: async () => {} }));
vi.mock('@/observability/logger', () => ({ logger: { warn: vi.fn() } }));

import {
  decideMcpServer,
  editMcpServer,
  removeMcpServer,
  saveCustomApiTool,
  sendMcpServer,
  setMcpToolLevel,
  testCustomApiTool,
} from './agent-tools-actions';
import { checkDraft, draftOf } from './custom-api-form';
import { customTool } from './fixtures';

const refused = (status: number, error: string, kind: string = 'conflict') =>
  new ApiError({ kind: kind as 'conflict', status, developerMessage: error });

beforeEach(() => {
  for (const fn of Object.values(api)) {
    fn.mockReset();
    fn.mockResolvedValue({});
  }
});

const input = {
  name: ' Orders ',
  url: ' https://mcp.example.com/mcp ',
  authKind: 'header' as const,
  headerName: ' X-Key ',
  secret: 's3cret',
};

describe('★★ MCP servers at the wire', () => {
  it('★★ a new server goes to the queue: trimmed, the header named, its value inside auth', async () => {
    expect(await sendMcpServer(input)).toEqual({ ok: true });
    const request = api.post.mock.calls[0]![0];
    expect(request.endpoint.path).toBe('/api/mcp-servers');
    expect(request.body).toEqual({
      name: 'Orders',
      url: 'https://mcp.example.com/mcp',
      auth: { kind: 'header', headerName: 'X-Key', headerValue: 's3cret' },
    });
  });

  it('a bearer token travels as auth.token', async () => {
    await sendMcpServer({ ...input, authKind: 'bearer' });
    expect(api.post.mock.calls[0]![0].body.auth).toEqual({ kind: 'bearer', token: 's3cret' });
  });

  it('★★ a rename sends no auth at all: a PATCH with auth goes back to GOTCHA', async () => {
    await editMcpServer('srv 1', { ...input, secret: '' }, false);
    const request = api.patch.mock.calls[0]![0];
    expect(request.endpoint.path).toBe('/api/mcp-servers/srv%201');
    expect(request.body).toEqual({ name: 'Orders', url: 'https://mcp.example.com/mcp' });
  });

  it('★ a new sign-in is sent; an empty value never is', async () => {
    await editMcpServer('srv_1', { ...input, headerName: 'X-New', secret: '' }, true);
    expect(api.patch.mock.calls[0]![0].body.auth).toEqual({ kind: 'header', headerName: 'X-New' });
  });

  it('★ no sign-in sends no token and no header, whatever was typed', async () => {
    await sendMcpServer({ ...input, authKind: 'none' });
    expect(api.post.mock.calls[0]![0].body).toEqual({
      name: 'Orders',
      url: 'https://mcp.example.com/mcp',
      auth: { kind: 'none' },
    });
  });

  it('a tool level is one PUT on that tool', async () => {
    await setMcpToolLevel('srv_1', 'issue/refund', 'ask');
    const request = api.put.mock.calls[0]![0];
    expect(request.endpoint.path).toBe('/api/mcp-servers/srv_1/tools/issue%2Frefund');
    expect(request.body).toEqual({ level: 'ask' });
  });

  it('remove is a DELETE of the server', async () => {
    await removeMcpServer('srv_1');
    expect(api.delete.mock.calls[0]![0].endpoint.path).toBe('/api/mcp-servers/srv_1');
  });

  it('★★ GOTCHA approves with no reason; a rejection carries it', async () => {
    await decideMcpServer('srv_1', 'approve', 'ignored');
    await decideMcpServer('srv_1', 'reject', '  Not reachable from the internet ');
    expect(api.post.mock.calls[0]![0].endpoint.path).toBe('/api/system/mcp-servers/srv_1/approve');
    expect(api.post.mock.calls[0]![0].body).toEqual({});
    expect(api.post.mock.calls[1]![0].endpoint.path).toBe('/api/system/mcp-servers/srv_1/reject');
    expect(api.post.mock.calls[1]![0].body).toEqual({ reason: 'Not reachable from the internet' });
  });

  it.each([
    [refused(422, 'url_private_host', 'validation'), 'url_private_host'],
    [refused(409, 'duplicate_server'), 'duplicate_server'],
    [refused(403, 'nope', 'authorization'), 'forbidden'],
    [refused(500, 'boom', 'server'), 'failed'],
  ])('a refusal reads in its own words', async (error, reason) => {
    api.post.mockRejectedValue(error);
    expect(await sendMcpServer(input)).toEqual({ ok: false, reason });
  });
});

describe('★★ custom API tools: the existing route', () => {
  const edit = checkDraft(draftOf(customTool()), { isNew: false, hasSecrets: true });

  it('★★ an edit PATCHes without the slug and without empty secrets', async () => {
    if (!edit.ok) throw new Error('fixture draft should pass');
    await saveCustomApiTool('cat_1', edit.input);
    const request = api.patch.mock.calls[0]![0];
    expect(request.endpoint.path).toBe('/api/custom-api-tools/cat_1');
    expect('slug' in request.body).toBe(false);
    expect('secrets' in request.body).toBe(false);
    expect(request.body).toMatchObject({
      method: 'GET',
      allowedHosts: ['api.shop-example.co.il'],
      auth: { kind: 'bearer' },
      responseFields: ['data.status'],
      whenNotToUse: null,
      // Backend maps category + riskLevel onto the four risks: both travel.
      category: 'READ',
      riskLevel: 'LOW',
    });
  });

  it('a new one POSTs with its slug; a taken slug is its own sentence', async () => {
    if (!edit.ok) throw new Error('fixture draft should pass');
    api.post.mockRejectedValue(refused(409, 'slug already exists for this tenant'));
    expect(await saveCustomApiTool(null, { ...edit.input, secrets: { bearer: 't' } })).toEqual({
      ok: false,
      reason: 'slug_taken',
    });
    const request = api.post.mock.calls[0]![0];
    expect(request.endpoint.path).toBe('/api/custom-api-tools');
    expect(request.body.slug).toBe('lookup_order');
    expect(request.body.secrets).toEqual({ bearer: 't' });
  });

  it('a test sends the args and returns what came back', async () => {
    api.post.mockResolvedValue({ ok: true, result: { status: 'shipped' }, meta: { status: 200, durationMs: 81 } });
    const result = await testCustomApiTool('cat_1', { order_id: '42' });
    expect(api.post.mock.calls[0]![0].body).toEqual({ args: { order_id: '42' } });
    expect(result).toMatchObject({ ok: true, test: { ok: true, meta: { status: 200, durationMs: 81 } } });
  });
});
