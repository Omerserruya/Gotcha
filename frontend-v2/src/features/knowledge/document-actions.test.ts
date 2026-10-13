import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/* Nothing here edits or deletes real knowledge: the client is a spy. */
const put = vi.hoisted(() => vi.fn());
const del = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ put, delete: del }) }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: async () => {} }));

import { deleteDocument, saveDocument } from './document-actions';

type Call = {
  endpoint: { path: string };
  body?: unknown;
  payload: { parse: (v: unknown) => unknown };
};

beforeEach(() => {
  put.mockReset();
  del.mockReset();
  revalidatePath.mockClear();
});

/** The route's own answer: the updated row, plus `reprocessing`. */
const answers = (reprocessing: boolean) =>
  put.mockImplementationOnce(async ({ payload }: Call) =>
    payload.parse({ id: 'd1', title: 'Shipping', status: 'pending', reprocessing }),
  );

describe('★★ K11 save, at the wire', () => {
  it('PUT …/knowledge-bases/:base/documents/:doc with the changed fields and manualEdit - content as typed, title trimmed', async () => {
    answers(true);
    expect(
      await saveDocument('kb-1', 'd1', {
        title: '  Shipping terms ',
        content: ' We ship in 2 days.\n',
      }),
    ).toEqual({ ok: true, reprocessing: true });
    const call = put.mock.calls[0]![0] as Call;
    expect(call.endpoint.path).toBe('/api/knowledge-bases/kb-1/documents/d1');
    expect(call.body).toEqual({
      title: 'Shipping terms',
      content: ' We ship in 2 days.\n',
      manualEdit: true,
    });
    expect(revalidatePath).toHaveBeenCalledWith('/[locale]/(app)/studio/knowledge', 'page');
  });

  it('a title alone sends the title alone - never a content the drawer may hold only part of', async () => {
    answers(false);
    expect(await saveDocument('kb-1', 'd1', { title: 'Terms' })).toEqual({
      ok: true,
      reprocessing: false,
    });
    expect((put.mock.calls[0]![0] as Call).body).toEqual({ title: 'Terms', manualEdit: true });
  });

  it('★ blank title or content is refused here - the route would keep the old one and answer 200', async () => {
    expect(await saveDocument('kb-1', 'd1', { title: '   ' })).toEqual({
      ok: false,
      reason: 'empty_title',
    });
    expect(await saveDocument('kb-1', 'd1', { content: ' \n ' })).toEqual({
      ok: false,
      reason: 'empty_content',
    });
    expect(await saveDocument('kb-1', 'd1', {})).toEqual({ ok: false, reason: 'unchanged' });
    expect(await saveDocument('', 'd1', { title: 'x' })).toEqual({ ok: false, reason: 'failed' });
    expect(put).not.toHaveBeenCalled();
  });

  it.each([
    [403, 'authorization', 'forbidden'],
    [404, 'not_found', 'gone'],
    [500, 'server', 'failed'],
    [400, 'validation', 'failed'],
    // The tenant is gated, not the person: no permission fixes that.
    [403, 'tenant_inactive', 'failed'],
  ] as const)('%s (%s) → %s', async (status, kind, reason) => {
    put.mockRejectedValueOnce(new ApiError({ kind, status }));
    expect(await saveDocument('kb-1', 'd1', { title: 'Terms' })).toEqual({ ok: false, reason });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe('★★ K11 delete, at the wire', () => {
  it('DELETE the same path; the list is read again', async () => {
    del.mockImplementationOnce(async ({ payload }: Call) => payload.parse({ deleted: true }));
    expect(await deleteDocument('kb-1', 'd1')).toEqual({ ok: true });
    const call = del.mock.calls[0]![0] as Call;
    expect(call.endpoint.path).toBe('/api/knowledge-bases/kb-1/documents/d1');
    expect(call.body).toBeUndefined();
    expect(revalidatePath).toHaveBeenCalledWith('/[locale]/(app)/studio/knowledge', 'page');
  });

  it.each([
    [403, 'authorization', 'forbidden'],
    [404, 'not_found', 'gone'],
    [500, 'server', 'failed'],
    [403, 'tenant_inactive', 'failed'],
  ] as const)('%s (%s) → %s', async (status, kind, reason) => {
    del.mockRejectedValueOnce(new ApiError({ kind, status }));
    expect(await deleteDocument('kb-1', 'd1')).toEqual({ ok: false, reason });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('no base: refused before any call', async () => {
    expect(await deleteDocument('', 'd1')).toEqual({ ok: false, reason: 'failed' });
    expect(del).not.toHaveBeenCalled();
  });
});
