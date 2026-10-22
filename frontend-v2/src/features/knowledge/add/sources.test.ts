import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

const post = vi.hoisted(() => vi.fn());
const del = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/browser-api', () => ({ browserApi: { post, get: vi.fn(), delete: del } }));

import { disconnectSource, FOLDER, learnDrive, learnSpaces } from './sources';

beforeEach(() => {
  post.mockReset();
});

describe('★★ learning at the wire', () => {
  it('Drive: the picks as sources of one kind', async () => {
    post.mockResolvedValue({});
    await learnDrive('int1', [{ id: 'f2', name: 'Returns', mimeType: FOLDER }]);
    const call = post.mock.calls[0]![0] as { endpoint: { path: string }; body: unknown };
    expect(call.endpoint.path).toBe('/api/knowledge/integrations/int1/drive/sync');
    expect(call.body).toStrictEqual({
      sources: [{ id: 'f2', kind: 'folder', name: 'Returns', mimeType: FOLDER }],
    });
  });

  it('mixed kinds never leave; 409 is a sync already running', async () => {
    expect(
      await learnDrive('int1', [
        { id: 'f', name: 'F', mimeType: FOLDER },
        { id: 'd', name: 'D', mimeType: 'application/pdf' },
      ]),
    ).toEqual({ ok: false, reason: 'mixed' });
    expect(post).not.toHaveBeenCalled();
    post.mockImplementation(async () => {
      throw new ApiError({ kind: 'conflict', status: 409 });
    });
    expect(await learnDrive('int1', [{ id: 'd', name: 'D', mimeType: 'text/plain' }])).toEqual({
      ok: false,
      reason: 'busy',
    });
  });

  it('Confluence: the space keys', async () => {
    post.mockResolvedValue({});
    await learnSpaces('c1', ['OPS']);
    expect((post.mock.calls[0]![0] as { body: unknown }).body).toStrictEqual({
      spaceKeys: ['OPS'],
    });
  });
});

describe('★★ disconnecting a knowledge source at the wire', () => {
  beforeEach(() => {
    del.mockReset();
  });

  it('DELETEs the connection - and never asks for its documents to go too', async () => {
    del.mockResolvedValue({ data: { deleted: true, removed: 0 } });
    expect(await disconnectSource('int1')).toEqual({ ok: true });
    const call = del.mock.calls[0]![0] as { endpoint: { path: string } };
    expect(call.endpoint.path).toBe('/api/knowledge/integrations/int1');
    expect(call.endpoint.path).not.toMatch(/removeData/);
  });

  it('403 is an admin’s to do; anything else failed', async () => {
    del.mockRejectedValueOnce(new ApiError({ kind: 'authorization', status: 403 }));
    expect(await disconnectSource('int1')).toEqual({ ok: false, reason: 'forbidden' });
    del.mockRejectedValueOnce(new ApiError({ kind: 'server', status: 500 }));
    expect(await disconnectSource('int1')).toEqual({ ok: false, reason: 'failed' });
  });
});
