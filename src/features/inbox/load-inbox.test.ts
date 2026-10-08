import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * How many server round trips one inbox page costs.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ THIS FILE EXISTS TO STOP THE WATERFALL COMING BACK
 * ════════════════════════════════════════════════════════════════════════════
 * Measured 2026-10-01: the inbox's TTFB was 738 ms against a 317 ms floor -
 * 420 ms of fetching, with ZERO API calls from the browser. The cause was
 * three sequential rounds where two would do: `queue` was awaited alone, and
 * `me`/`colleagues`/`greeting` waited behind a result none of them reads.
 *
 * ★ EVERY OTHER TEST HERE PASSES WHETHER THE CALLS ARE SERIAL OR PARALLEL.
 *   They assert the data, and the data is identical either way. Only the
 *   ORDER is the fix, so only a test about order can protect it - otherwise
 *   the next person to add a read awaits it and nothing goes red.
 */
const get = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get }) }));
vi.mock('server-only', () => ({}));

/** A promise this test decides when to settle, per endpoint path. */
const pending = new Map<string, (value: unknown) => void>();

const pathOf = (args: { endpoint: { path: string } }) => args.endpoint.path;

beforeEach(() => {
  pending.clear();
  get.mockReset().mockImplementation((args: { endpoint: { path: string } }) => {
    const path = pathOf(args);
    return new Promise((resolve) => pending.set(path, resolve));
  });
});

/** Lets every already-scheduled microtask run, without settling anything. */
const settleMicrotasks = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

const requested = () => [...pending.keys()];

describe('⚠⚠ two rounds, and the first one is four calls wide', () => {
  it('★★ asks for the queue, the viewer, colleagues and the greeting TOGETHER', async () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * THE ASSERTION THE FIX NEEDS: ALL FOUR ARE IN FLIGHT BEFORE ANY RESOLVES
     * ════════════════════════════════════════════════════════════════════════
     * If `queue` is awaited alone, the other three are not requested until it
     * settles - and nothing here settles it. So a serial implementation shows
     * exactly one request and fails this line.
     */
    const { loadInbox } = await import('./load-inbox');
    void loadInbox();
    await settleMicrotasks();

    const paths = requested();
    expect(paths).toHaveLength(4);
    expect(paths.some((p) => p.includes('/conversations'))).toBe(true);
    expect(paths.some((p) => p.includes('/auth/me'))).toBe(true);
    expect(paths.some((p) => p.includes('/agents'))).toBe(true);
    expect(paths.some((p) => p.includes('auto-greeting'))).toBe(true);
  });

  it('⚠⚠ and does NOT ask for a conversation before it knows which one', async () => {
    /*
     * ★ The second round's dependency is REAL and must stay. `open` is chosen
     *   from the queue's rows, and messages cannot be fetched for a
     *   conversation nobody has picked yet. Collapsing this one would be a
     *   different bug wearing the same fix.
     */
    const { loadInbox } = await import('./load-inbox');
    void loadInbox();
    await settleMicrotasks();

    expect(requested().some((p) => p.includes('/messages'))).toBe(false);
  });
});

describe('⚠⚠ the view reaches the route', () => {
  const queueCall = () =>
    get.mock.calls.find((c) => pathOf(c[0]).endsWith('/conversations'))?.[0] as
      { query: Record<string, string> } | undefined;

  it('★★ Resolved sends status=CLOSED to the list route', async () => {
    const { loadInbox } = await import('./load-inbox');
    void loadInbox(undefined, undefined, 'resolved');
    await settleMicrotasks();
    expect(queueCall()?.query).toMatchObject({ status: 'CLOSED' });
  });

  it('★ and the default view still starts all four reads at once', async () => {
    // The waterfall fix must survive the view being threaded through.
    const { loadInbox } = await import('./load-inbox');
    void loadInbox(undefined, undefined, 'active');
    await settleMicrotasks();
    expect(requested()).toHaveLength(4);
  });

  it('⚠⚠ Assigned to me WAITS for the viewer - the one real dependency', async () => {
    /*
     * ★ `mine` needs `assignedAgentId=<me>`, which only `/auth/me` knows. So
     *   for this view, and no other, the list is not requested until `me`
     *   answers. Asserted as ABSENT first and PRESENT after - a list fired
     *   early would carry no assignee and be the original bug.
     */
    const { loadInbox } = await import('./load-inbox');
    void loadInbox(undefined, undefined, 'mine');
    await settleMicrotasks();

    expect(requested().some((p) => p.endsWith('/conversations'))).toBe(false);

    const meKey = requested().find((p) => p.includes('/auth/me'))!;
    pending.get(meKey)!({ user: { id: 'u7' } });
    await settleMicrotasks();

    expect(queueCall()?.query).toMatchObject({ assignedAgentId: 'u7' });
  });

  it('★★ a channel filter reaches the route as its own `channel`', async () => {
    const { loadInbox } = await import('./load-inbox');
    void loadInbox(undefined, undefined, 'resolved', 'INSTAGRAM');
    await settleMicrotasks();
    expect(queueCall()?.query).toMatchObject({ status: 'CLOSED', channel: 'INSTAGRAM' });
  });

  it('⚠ and "All" sends no channel at all, not an empty one', async () => {
    const { loadInbox } = await import('./load-inbox');
    void loadInbox(undefined, undefined, 'queue', null);
    await settleMicrotasks();
    expect(queueCall()?.query).not.toHaveProperty('channel');
  });

  it('★ a period reaches the route as its own `from` / `to`', async () => {
    const { loadInbox } = await import('./load-inbox');
    void loadInbox(undefined, undefined, 'queue', null, { from: '2026-09-01', to: '2026-09-30' });
    await settleMicrotasks();
    expect(queueCall()?.query).toMatchObject({ from: '2026-09-01', to: '2026-09-30' });
  });

  it('an open end is not sent', async () => {
    const { loadInbox } = await import('./load-inbox');
    void loadInbox(undefined, undefined, 'queue', null, { from: '2026-09-01', to: null });
    await settleMicrotasks();
    expect(queueCall()?.query).toMatchObject({ from: '2026-09-01' });
    expect(queueCall()?.query).not.toHaveProperty('to');
  });
});

describe('★★ the page does not wait for the conversation - the second round is a promise', () => {
  it('⚠⚠ loadInbox resolves while the conversation’s own reads are still in flight', async () => {
    /*
     * Omer: "why does it take time to load each conversation". The page awaited
     * messages, timeline, orders and the Copilot before painting anything.
     * Round one settles here; round two is left unanswered on purpose.
     */
    const { loadInbox } = await import('./load-inbox');
    const result = loadInbox('c1');
    await settleMicrotasks();
    for (const key of requested()) {
      const answer = pending.get(key)!;
      if (key.endsWith('/conversations'))
        answer({
          data: [{ id: 'c1', status: 'OPEN' }],
          page: { hasMore: false, nextCursor: null },
        });
      else if (key.includes('/auth/me')) answer({ user: { id: 'u1' } });
      else if (key.includes('auto-greeting')) answer({ template: '' });
      else answer([]);
    }
    const shell = await result;
    expect(shell.open?.id).toBe('c1');
    expect(shell.detail).toBeInstanceOf(Promise);
    // The stream was asked for - and has not answered - yet the shell is here.
    expect(requested().some((p) => p.includes('/messages'))).toBe(true);
  });
});
