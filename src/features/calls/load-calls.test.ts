import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Screen 05d's availability, in three states.
 *
 * This file exists because the collapse it guards survived every test we had:
 * a failed settings read returned `voiceEnabled: false`, and nothing asserted
 * on the difference between "no voice" and "we could not find out".
 *
 * It was harmless for as long as voice was off on all thirteen tenants — the
 * wrong answer and the right one were the same answer. The moment the flag
 * flipped, the same code began telling a merchant with voice to go and ask
 * somebody to enable it.
 */

const get = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get }) }));
vi.mock('server-only', () => ({}));

beforeEach(() => {
  get.mockReset();
});

describe('★★ three answers, because "we could not ask" is one of them', () => {
  it('★★ a failed settings read is NULL, never false', async () => {
    /*
     * THE DEFECT THIS FILE GUARDS.
     *
     * `voiceCopilotGate` 404s the whole voice router, byte-identically to a
     * missing route — so the settings read is what resolves the ambiguity.
     * When IT fails there is no answer, and `false` is a claim about the
     * workspace made from a failed request.
     *
     * Rendered, it says "Nothing here will show calls until voice is
     * enabled. Ask whoever set up GOTCHA for you" — to somebody who has it.
     */
    get.mockRejectedValueOnce(new Error('settings unreachable'));
    const { loadCalls } = await import('./load-calls');
    const data = await loadCalls();

    expect(data.voiceEnabled).toBeNull();
    // And not a fault either: we failed to ask, which is its own state.
    expect(data.failed).toBe(false);
  });

  it('reports voice genuinely off as false', async () => {
    get.mockResolvedValueOnce({ voiceCopilotEnabled: false });
    const { loadCalls } = await import('./load-calls');
    expect((await loadCalls()).voiceEnabled).toBe(false);
  });

  it('proceeds to the reads when voice is on', async () => {
    // `voice_copilot_enabled` is true on this tenant as of 2026-09-25.
    get.mockResolvedValueOnce({ voiceCopilotEnabled: true });
    get.mockResolvedValue({ data: [] });
    const { loadCalls } = await import('./load-calls');
    const data = await loadCalls();

    expect(data.voiceEnabled).toBe(true);
    // The settings call plus the two it gates.
    expect(get.mock.calls.length).toBeGreaterThan(1);
  });

  it('★ voice on with both reads failing IS a fault, unlike the other two', async () => {
    // The distinction the `failed` flag exists for: voice off is a fact
    // about the workspace, an unknown is our failure to ask, and this is a
    // real fault worth reporting as one.
    get.mockResolvedValueOnce({ voiceCopilotEnabled: true });
    get.mockRejectedValue(new Error('calls unreachable'));
    const { loadCalls } = await import('./load-calls');
    const data = await loadCalls();

    expect(data.voiceEnabled).toBe(true);
    expect(data.failed).toBe(true);
  });
});
