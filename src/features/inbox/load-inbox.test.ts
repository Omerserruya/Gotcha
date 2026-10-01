import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * How many server round trips one inbox page costs.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ THIS FILE EXISTS TO STOP THE WATERFALL COMING BACK
 * ════════════════════════════════════════════════════════════════════════════
 * Measured 2026-10-01: the inbox's TTFB was 738 ms against a 317 ms floor —
 * 420 ms of fetching, with ZERO API calls from the browser. The cause was
 * three sequential rounds where two would do: `queue` was awaited alone, and
 * `me`/`colleagues`/`greeting` waited behind a result none of them reads.
 *
 * ★ EVERY OTHER TEST HERE PASSES WHETHER THE CALLS ARE SERIAL OR PARALLEL.
 *   They assert the data, and the data is identical either way. Only the
 *   ORDER is the fix, so only a test about order can protect it — otherwise
 *   the next person to add a read awaits it and nothing goes red.
 */
const get = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get }) }));
vi.mock('server-only', () => ({}));
vi.mock('./load-copilot', () => ({ loadCopilot: async () => null }));

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
     * settles — and nothing here settles it. So a serial implementation shows
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
