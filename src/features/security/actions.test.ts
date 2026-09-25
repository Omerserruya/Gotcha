import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Screen 16's writes — specifically, whether the answer is read.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THE SCHEMA DEFAULT WAS THE HARMLESS HALF OF THIS DEFECT
 * ════════════════════════════════════════════════════════════════════════════
 * `revokeResultSchema` defaulted `ok` to **true**, which a contract test can
 * catch. But `revokeSession` never consulted the value: it awaited the call,
 * discarded the result and returned success. So a 200 whose body explicitly
 * said `{ ok: false }` reported "signed out" just the same, and flipping the
 * default would have fixed nothing.
 *
 * The sweep that found this could only see the schema. **A scan sees the
 * half of a defect that is written down in the shape it scans for** — which
 * is why its own header says the question it cannot answer is what the
 * screen ends up saying.
 */

const del = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ delete: del }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('server-only', () => ({}));

beforeEach(() => {
  del.mockReset();
});

describe('★★ revoking a session reports what the server said, not that we asked', () => {
  it('★★ an explicit `{ ok: false }` is NOT a completed sign-out', async () => {
    /*
     * The request not throwing is a different fact from the session being
     * gone. Told "signed out", somebody stops worrying about a session that
     * is still live — which on this screen is the whole point of the list.
     */
    del.mockResolvedValue({ ok: false });
    const { revokeSession } = await import('./actions');
    const result = await revokeSession('sess-1');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // And not dressed as a flat failure: we did not confirm it, which is a
    // different sentence and a different thing to tell somebody.
    expect(result.reason).toBe('unconfirmed');
  });

  it('reports a confirmed revoke as done', async () => {
    del.mockResolvedValue({ ok: true });
    const { revokeSession } = await import('./actions');
    expect((await revokeSession('sess-1')).ok).toBe(true);
  });

  it('★ the same holds for signing out every other device', async () => {
    // Fix the instance, then sweep the name — the sibling had the identical
    // discard, and a fix applied to one of two call sites is half a fix.
    del.mockResolvedValue({ ok: false });
    const { revokeOtherSessions } = await import('./actions');
    const result = await revokeOtherSessions();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unconfirmed');
  });
});
