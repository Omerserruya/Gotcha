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

/**
 * A settings payload the platform could actually send.
 *
 * ★ THE MOCK BYPASSES ZOD, SO THE FIXTURE HAS TO CARRY ITS OWN HONESTY.
 * `api.get` is stubbed, which means `payload: voiceAvailabilitySchema` never
 * runs here. A fixture naming only the field a test cares about would be a
 * claim the platform can send that object — and after these three became
 * required it cannot. `tenant-settings` sends all three unconditionally.
 */
const settings = (over: Record<string, boolean> = {}) => ({
  voiceCopilotEnabled: false,
  voiceIncomingEnabled: false,
  hasActiveVoiceChannel: false,
  ...over,
});
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
    get.mockResolvedValueOnce(settings({ voiceCopilotEnabled: false }));
    const { loadCalls } = await import('./load-calls');
    expect((await loadCalls()).voiceEnabled).toBe(false);
  });

  it('proceeds to the reads when voice is on', async () => {
    // `voice_copilot_enabled` is true on this tenant as of 2026-09-25.
    get.mockResolvedValueOnce(settings({ voiceCopilotEnabled: true, hasActiveVoiceChannel: true }));
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
    get.mockResolvedValueOnce(settings({ voiceCopilotEnabled: true, hasActiveVoiceChannel: true }));
    get.mockRejectedValue(new Error('calls unreachable'));
    const { loadCalls } = await import('./load-calls');
    const data = await loadCalls();

    expect(data.voiceEnabled).toBe(true);
    expect(data.failed).toBe(true);
  });

  it('★ carries whether a number is connected, which the empty screen needs', async () => {
    /*
     * Voice switched on and no ACTIVE VOICE channel is a real state, and the
     * two empty screens say different things: "calls appear here as they
     * happen" is a promise that cannot come true without a number.
     */
    get.mockResolvedValueOnce(
      settings({ voiceCopilotEnabled: true, hasActiveVoiceChannel: false }),
    );
    get.mockResolvedValue({ data: [] });
    const { loadCalls } = await import('./load-calls');
    expect((await loadCalls()).hasNumber).toBe(false);
  });

  it('★★ an unknown availability leaves the number unknown too', async () => {
    // Not `false`. We never got to ask, and "no number connected" would be
    // the same manufactured claim as "no voice" — one field along.
    get.mockRejectedValueOnce(new Error('settings unreachable'));
    const { loadCalls } = await import('./load-calls');
    expect((await loadCalls()).hasNumber).toBeNull();
  });
});

describe('★★ the contract refuses to default the answer', () => {
  it('★★ a response missing the flag FAILS the parse rather than reading as "off"', async () => {
    /*
     * `voiceCopilotEnabled` was `.default(false)`. A payload that stopped
     * carrying it parsed cleanly and rendered "voice is not switched on for
     * this workspace" — the loader's repaired collapse, committed one level
     * down where nothing logs.
     *
     * Required, absence throws, the loader catches, and the screen says we
     * could not find out.
     */
    const { voiceAvailabilitySchema } = await import('@/api/contracts/calls');

    expect(() => voiceAvailabilitySchema.parse({})).toThrow();
    expect(() =>
      voiceAvailabilitySchema.parse({ voiceCopilotEnabled: true, voiceIncomingEnabled: false }),
    ).toThrow();
    expect(
      voiceAvailabilitySchema.parse({
        voiceCopilotEnabled: true,
        voiceIncomingEnabled: false,
        hasActiveVoiceChannel: true,
      }).hasActiveVoiceChannel,
    ).toBe(true);
  });
});

describe('★ the week’s summary', () => {
  it('★ summaryDays reaches the route as `from` — so "this week" is the week’s figure', async () => {
    get
      .mockResolvedValueOnce(settings({ voiceCopilotEnabled: true }))
      .mockResolvedValueOnce({ data: [], nextCursor: null })
      .mockResolvedValueOnce({ total: 0 });
    const { loadCalls } = await import('./load-calls');
    const before = Date.now();
    await loadCalls({ summaryDays: 7 });
    const summaryCall = get.mock.calls.find(([req]) =>
      (req as { endpoint: { path: string } }).endpoint.path.endsWith('/summary'),
    )![0] as { query?: { from?: string } };
    const from = Date.parse(summaryCall.query!.from!);
    expect(before - from).toBeGreaterThanOrEqual(7 * 86_400_000 - 1000);
    expect(before - from).toBeLessThanOrEqual(7 * 86_400_000 + 1000);
  });

  it('omitted, the summary is all-time — no `from`', async () => {
    get
      .mockResolvedValueOnce(settings({ voiceCopilotEnabled: true }))
      .mockResolvedValueOnce({ data: [], nextCursor: null })
      .mockResolvedValueOnce({ total: 0 });
    const { loadCalls } = await import('./load-calls');
    await loadCalls();
    const summaryCall = get.mock.calls.find(([req]) =>
      (req as { endpoint: { path: string } }).endpoint.path.endsWith('/summary'),
    )![0] as { query?: unknown };
    expect(summaryCall.query).toBeUndefined();
  });
});

describe("★★ loadLiveCall — the caller's name, beside the transcript", () => {
  const call = (over: Record<string, unknown> = {}) => ({
    id: 'v1',
    conversationId: 'c1',
    customerNumber: '972524189930',
    customerId: 'k1',
    direction: 'inbound',
    startedAt: '2026-10-02T09:00:00.000Z',
    ...over,
  });
  const route = (contact: () => Promise<unknown>, active = call()) =>
    get.mockImplementation(async ({ endpoint }: { endpoint: { path: string } }) => {
      const path = String(endpoint.path ?? endpoint);
      if (path.includes('/contacts/')) return contact();
      if (path.includes('transcript')) return { data: [] };
      return { data: [active] };
    });

  it("★★ a matched call carries the contact's name", async () => {
    route(async () => ({ id: 'k1', displayName: '  Dana Cohen ' }));
    const { loadLiveCall } = await import('./load-calls');
    expect((await loadLiveCall()).contactName).toBe('Dana Cohen');
  });

  it('⚠ the contact read failing is not the call failing — the number stands in', async () => {
    route(async () => {
      throw new Error('500');
    });
    const { loadLiveCall } = await import('./load-calls');
    const read = await loadLiveCall();
    expect(read.call?.id).toBe('v1');
    expect(read.contactName).toBeNull();
  });

  it('a contact with no name, or an unmatched call: null — and no contact read for the latter', async () => {
    route(async () => ({ id: 'k1', displayName: '   ' }));
    const { loadLiveCall } = await import('./load-calls');
    expect((await loadLiveCall()).contactName).toBeNull();
    get.mockReset();
    const contact = vi.fn();
    route(contact, call({ customerId: null }));
    expect((await loadLiveCall()).contactName).toBeNull();
    expect(contact).not.toHaveBeenCalled();
  });
});
