import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/** At the wire. `browserApi` is mocked: nothing is added. */
const post = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/browser-api', () => ({ browserApi: { post } }));

import { addKnowledge, documentProblem, MAX_DOCUMENT_BYTES, pageAddress } from './add-knowledge';

const doc = { id: 'd1', title: 'Terms', status: 'pending' };
const path = (i: number) =>
  (post.mock.calls[i]![0] as { endpoint: { path: string } }).endpoint.path;
const body = (i: number) => (post.mock.calls[i]![0] as { body: unknown }).body;

beforeEach(() => {
  post.mockReset();
});

describe('★★ 08b at the wire', () => {
  it('a typed fact: one document, trimmed, into the base', async () => {
    post.mockResolvedValue(doc);
    expect(
      await addKnowledge(
        { id: 'kb1' },
        { way: 'text', title: ' Trade ', body: ' 40% ' },
        'Knowledge',
      ),
    ).toEqual({ ok: true, title: 'Terms', status: 'pending' });
    expect(path(0)).toBe('/api/knowledge-bases/kb1/documents');
    expect(body(0)).toStrictEqual({ title: 'Trade', content: '40%', sourceType: 'text' });
  });

  it('a page: the server reads the address', async () => {
    post.mockResolvedValue(doc);
    await addKnowledge({ id: 'kb1' }, { way: 'page', url: 'https://shop.example.com/terms' }, 'K');
    expect(body(0)).toStrictEqual({
      sourceType: 'url',
      sourceUrl: 'https://shop.example.com/terms',
    });
  });

  it('a document: multipart, to the upload route', async () => {
    post.mockResolvedValue(doc);
    const file = new File(['%PDF'], 'terms.pdf', { type: 'application/pdf' });
    await addKnowledge({ id: 'kb1' }, { way: 'document', file }, 'K');
    expect(path(0)).toBe('/api/knowledge-bases/kb1/documents/upload');
    expect((body(0) as FormData).get('file')).toBeInstanceOf(File);
  });

  it('★ no base yet: one is made first — then the document goes into it', async () => {
    post.mockResolvedValueOnce({ id: 'kb-new' }).mockResolvedValueOnce(doc);
    await addKnowledge('none', { way: 'text', title: 'a', body: 'b' }, 'Knowledge');
    expect(path(0)).toBe('/api/knowledge-bases');
    expect(body(0)).toStrictEqual({ name: 'Knowledge' });
    expect(path(1)).toBe('/api/knowledge-bases/kb-new/documents');
  });

  it('★★ the bases could not be read: refused — a failed read never makes a second base', async () => {
    expect(await addKnowledge('unknown', { way: 'text', title: 'a', body: 'b' }, 'K')).toEqual({
      ok: false,
      reason: 'failed',
    });
    expect(post).not.toHaveBeenCalled();
  });

  it('refused here, nothing sent: a bad address, a wrong type, too large', async () => {
    expect(await addKnowledge('none', { way: 'page', url: 'javascript:alert(1)' }, 'K')).toEqual({
      ok: false,
      reason: 'bad_url',
    });
    expect(
      await addKnowledge('none', { way: 'document', file: new File(['x'], 'a.exe') }, 'K'),
    ).toEqual({ ok: false, reason: 'wrong_type' });
    expect(post).not.toHaveBeenCalled();
  });

  it.each([
    [400, 'unreadable'],
    [402, 'entitlement'],
    [403, 'forbidden'],
    [500, 'failed'],
  ] as const)('%i → %s', async (status, reason) => {
    post.mockImplementation(async () => {
      throw new ApiError({ kind: status === 403 ? 'authorization' : 'server', status });
    });
    expect(await addKnowledge({ id: 'kb1' }, { way: 'text', title: 'a', body: 'b' }, 'K')).toEqual({
      ok: false,
      reason,
    });
  });

  it('the rules: http(s) only; the types and the size the platform takes', () => {
    expect(pageAddress('https://a.co/x')).toBe('https://a.co/x');
    expect(pageAddress('ftp://a.co')).toBeNull();
    expect(pageAddress('a.co')).toBeNull();
    expect(documentProblem(new File(['x'], 'A.PDF'))).toBeNull();
    expect(documentProblem(new File(['x'], 'notes.md'))).toBeNull();
    expect(documentProblem(new File(['x'], 'sheet.xlsx'))).toBe('wrong_type');
    const big = new File(['x'], 'big.pdf');
    Object.defineProperty(big, 'size', { value: MAX_DOCUMENT_BYTES + 1 });
    expect(documentProblem(big)).toBe('too_large');
  });
});
