import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';
import { knowledgeSourceSchema, type KnowledgeSource } from '@/api/contracts/knowledge';

/**
 * K6's read. The platform is mocked: nothing here reaches it.
 *
 * The route is scoped by tenant AND base, so the base comes from the list the
 * page already read; an id in no listed source is "not found" without a
 * request, and a failed list is a failure, not "not found".
 */
const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get }) }));

const { loadKnowledgeDocument } = await import('./load-document');

const sources: KnowledgeSource[] = [
  knowledgeSourceSchema.parse({ id: 'kb-1', documents: [{ id: 'd0' }] }),
  knowledgeSourceSchema.parse({ id: 'kb-2', documents: [{ id: 'd1' }, { id: 'd2' }] }),
];

beforeEach(() => {
  get.mockReset();
});

describe('★★ K6 - one document, from its own base', () => {
  it('asks the base that lists it, for that id', async () => {
    get.mockResolvedValueOnce({ id: 'd1' });
    expect(await loadKnowledgeDocument(sources, 'd1')).toEqual({
      state: 'ok',
      document: { id: 'd1' },
    });
    const [request] = get.mock.calls[0] as [{ endpoint: { path: string } }];
    expect(request.endpoint.path).toBe('/api/knowledge-bases/kb-2/documents/d1');
  });

  it('★ in no listed source: not found, and nothing is asked', async () => {
    expect(await loadKnowledgeDocument(sources, 'elsewhere')).toEqual({ state: 'not_found' });
    expect(get).not.toHaveBeenCalled();
  });

  it('★★ the list failed: a failure - never "not found"', async () => {
    expect(await loadKnowledgeDocument(null, 'd1')).toEqual({ state: 'failed' });
    expect(get).not.toHaveBeenCalled();
  });

  it.each([
    [404, 'not_found'],
    [403, 'forbidden'],
    [500, 'failed'],
  ] as const)('%s → %s', async (status, state) => {
    get.mockRejectedValueOnce(
      new ApiError({ kind: status === 403 ? 'authorization' : 'server', status }),
    );
    expect(await loadKnowledgeDocument(sources, 'd1')).toEqual({ state });
  });
});
