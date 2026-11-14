import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/* The file, at the wire. ⚠ Mocked: nothing is uploaded. */
const { api, warn } = vi.hoisted(() => ({ api: { post: vi.fn() }, warn: vi.fn() }));
vi.mock('@/api/client/browser-api', () => ({ browserApi: api }));
vi.mock('@/observability/logger', () => ({ logger: { warn } }));

import { learnedUploadSchema } from '@/api/contracts/onboarding-v2';

import { MAX_UPLOAD_BYTES, uploadLearned, uploadProblem } from './upload-learned';

const file = (name: string, size = 10) => new File([new Uint8Array(size)], name);

beforeEach(() => {
  api.post.mockReset();
  warn.mockClear();
});

describe('★★ a file into what was learned', () => {
  it('★★ refused HERE when too large or not a type Backend reads; nothing travels', async () => {
    expect(uploadProblem(file('a.pdf', MAX_UPLOAD_BYTES + 1))).toBe('too_large');
    expect(uploadProblem(file('old.doc'))).toBe('unsupported');
    for (const ok of ['a.PDF', 'b.docx', 'c.txt', 'd.md'])
      expect(uploadProblem(file(ok))).toBeNull();
    expect(await uploadLearned(file('old.doc'))).toEqual({ ok: false, reason: 'unsupported' });
    expect(api.post).not.toHaveBeenCalled();
  });

  it('★ the skipped kinds are read; absent (an older backend) is none, never a failed upload', () => {
    expect(
      learnedUploadSchema.parse({ added: { policies: [] }, skipped: { policies: ['returns'] } })
        .skipped,
    ).toEqual({ policies: ['returns'] });
    expect(learnedUploadSchema.parse({ added: { policies: [] } }).skipped).toEqual({
      policies: [],
    });
    expect(learnedUploadSchema.parse({ skipped: 'x' }).skipped).toEqual({ policies: [] });
  });

  it('★★ from the browser, multipart, ONE field named "file", with a long timeout', async () => {
    const parsed = learnedUploadSchema.parse({
      added: { policies: ['returns'], faq: 1 },
      partial: false,
    });
    api.post.mockResolvedValue(parsed);
    const f = file('policies.pdf');
    expect(await uploadLearned(f)).toEqual({ ok: true, result: parsed });
    const call = api.post.mock.calls[0]![0];
    expect(call.endpoint.path).toBe('/api/onboarding/learned/upload');
    expect(call.body).toBeInstanceOf(FormData);
    expect((call.body as FormData).get('file')).toBeInstanceOf(File);
    expect(call.timeoutMs).toBeGreaterThanOrEqual(60_000);
    expect(call.payload).toBe(learnedUploadSchema);
  });

  it.each([
    ['FILE_TOO_LARGE', 'too_large'],
    ['UNSUPPORTED_TYPE', 'unsupported'],
    ['UNREADABLE_FILE', 'unreadable'],
    ['NOTHING_FOUND', 'nothing_found'],
    ['NOT_LEARNED', 'not_learned'],
    ['UPLOAD_FAILED', 'failed'],
  ])('★ %s reads as %s', async (code, reason) => {
    api.post.mockRejectedValue(new ApiError({ kind: 'server', status: 422, code }));
    expect(await uploadLearned(file('a.pdf'))).toEqual({ ok: false, reason });
  });

  it('★ nothing new in the file: the kinds already learned come with the refusal', async () => {
    api.post.mockRejectedValue(
      new ApiError({
        kind: 'validation',
        status: 422,
        code: 'NOTHING_FOUND',
        skipped: { policies: ['returns'] },
      }),
    );
    expect(await uploadLearned(file('a.pdf'))).toEqual({
      ok: false,
      reason: 'nothing_found',
      skipped: ['returns'],
    });
  });

  it('★ never logs the file or its name', async () => {
    api.post.mockRejectedValue(
      new ApiError({ kind: 'server', status: 502, code: 'UPLOAD_FAILED' }),
    );
    await uploadLearned(file('secret-contract.pdf'));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-contract');
  });
});
