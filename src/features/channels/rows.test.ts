import { describe, expect, it } from 'vitest';

import type { Channel } from '@/api/contracts/channels';

import { buildChannelRows, isTroubled, type ConnectedRow } from './rows';

const channel = (over: Partial<Channel> = {}): Channel => ({
  id: 'c1',
  channel: 'WHATSAPP',
  isActive: true,
  connectionStatus: 'CONNECTED',
  responseMode: 'HUMAN_WITH_COPILOT',
  ...over,
});

const connectedOnly = (rows: ReturnType<typeof buildChannelRows>): ConnectedRow[] =>
  rows.filter((r): r is ConnectedRow => r.kind === 'connected');

describe('buildChannelRows', () => {
  it('renders a row per ACCOUNT, never per channel type', () => {
    // The tenant has WEBCHAT conversations and no WEBCHAT account. The list is
    // driven by accounts, so a channel with no account cannot produce a row —
    // which is what stops "unattributed volume" ever needing a label. An
    // unmatched conversation means EITHER "it outlived its account" or "no
    // such account existed"; `onDelete: SetNull` makes those identical, and a
    // settings screen is the wrong place to make anyone reason about it.
    const rows = buildChannelRows([channel()], [], true, 'en');
    expect(connectedOnly(rows)).toHaveLength(1);
    expect(rows.find((r) => r.kind === 'connected' && r.channel === 'WEBCHAT')).toBeUndefined();
  });

  it('reads the window count off the row', () => {
    const rows = buildChannelRows([channel({ conversationsInWindow: 71 })], [], true, 'en');
    expect(connectedOnly(rows)[0]!.windowConversations).toBe(71);
  });

  it('keeps a served zero as zero', () => {
    // A channel that received nothing in 30 days is exactly what a health
    // check needs to show, so 0 must survive rather than being falsy-dropped.
    const rows = buildChannelRows([channel({ conversationsInWindow: 0 })], [], true, 'en');
    expect(connectedOnly(rows)[0]!.windowConversations).toBe(0);
  });

  it('leaves the window count null when the key is absent', () => {
    // The route omits it entirely when no window was asked for. "You did not
    // ask" must never render as "there were none".
    const rows = buildChannelRows([channel()], [], true, 'en');
    expect(connectedOnly(rows)[0]!.windowConversations).toBeNull();
  });

  it('keeps the open count and the window count as separate measures', () => {
    // Open NOW vs STARTED in the window. Not one measure at two zoom levels:
    // a conversation running since August is in neither.
    const rows = buildChannelRows(
      [channel({ _count: { conversations: 3 }, conversationsInWindow: 71 })],
      [],
      true,
      'en',
    );
    expect(connectedOnly(rows)[0]!.openConversations).toBe(3);
    expect(connectedOnly(rows)[0]!.windowConversations).toBe(71);
  });

  it('treats CONNECTED with an error as troubled', () => {
    // The live case: Shopify is CONNECTED and says "the app was uninstalled".
    // Trusting the status alone would render it healthy.
    const rows = buildChannelRows(
      [channel({ lastError: 'Shopify Chat app was uninstalled from the store.' })],
      [],
      true,
      'en',
    );
    expect(isTroubled(connectedOnly(rows)[0]!)).toBe(true);
  });

  it('sorts a troubled channel above a healthy one', () => {
    const rows = connectedOnly(
      buildChannelRows(
        [
          channel({ id: 'ok', channel: 'WHATSAPP' }),
          channel({ id: 'bad', channel: 'INSTAGRAM', connectionStatus: 'ERROR' }),
        ],
        [],
        true,
        'en',
      ),
    );
    expect(rows[0]!.id).toBe('bad');
  });

  it('folds a connected voice channel in from the other spine', () => {
    // Voice is `CommunicationChannel` -> `VoiceChannel`, not a ChannelAccount.
    const rows = connectedOnly(
      buildChannelRows(
        [],
        [{ id: 'v1', status: 'ACTIVE', numbers: [{ phoneNumber: '+972 3 000 0000' }] }],
        true,
        'en',
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.channel).toBe('VOICE');
    expect(rows[0]!.identity).toBe('+972 3 000 0000');
  });

  it('maps ACTIVE to connected and DISABLED to disconnected', () => {
    // Voice has no CONNECTED and no DISCONNECTED. Mapping is explicit so
    // neither enum pretends to be the other.
    const active = connectedOnly(
      buildChannelRows([], [{ id: 'v1', status: 'ACTIVE', numbers: [] }], true, 'en'),
    );
    const disabled = connectedOnly(
      buildChannelRows([], [{ id: 'v1', status: 'DISABLED', numbers: [] }], true, 'en'),
    );
    expect(active[0]!.status).toBe('CONNECTED');
    expect(disabled[0]!.status).toBe('DISCONNECTED');
  });

  it('gives a voice row no responseMode, because it has none', () => {
    // Voice routes by defaultAgentId / fallbackDepartmentId on its own spine.
    // Rendering "a person answers" would assert a field it does not have.
    const rows = connectedOnly(
      buildChannelRows([], [{ id: 'v1', status: 'ACTIVE', numbers: [] }], true, 'en'),
    );
    expect(rows[0]!.responseMode).toBeNull();
  });

  it('offers Phone calls only when the product offers voice to this tenant', () => {
    // The voice router is gated on `Tenant.voiceCopilotEnabled` and answers
    // 404 when voice is not sold here. That 404 is an answer, not a fault.
    const offered = buildChannelRows([], [], true, 'en')
      .filter((r) => r.kind === 'connectable')
      .map((r) => r.channel);
    const withheld = buildChannelRows([], [], false, 'en')
      .filter((r) => r.kind === 'connectable')
      .map((r) => r.channel);
    expect(offered).toContain('VOICE');
    expect(withheld).not.toContain('VOICE');
  });

  it('does not offer voice once it is connected', () => {
    const rows = buildChannelRows([], [{ id: 'v1', status: 'ACTIVE', numbers: [] }], true, 'en');
    expect(rows.filter((r) => r.kind === 'connectable').map((r) => r.channel)).not.toContain(
      'VOICE',
    );
  });

  it('offers only channels that have a provisioning path', () => {
    const rows = buildChannelRows([], [], true, 'en');
    const offered = rows.filter((r) => r.kind === 'connectable').map((r) => r.channel);
    // Shopify is installed from Shopify, so a Connect button here would send
    // someone to the wrong place. (Voice IS connectable — see above.)
    expect(offered).not.toContain('SHOPIFY_LIVE_CHAT');
    expect(offered).toContain('WHATSAPP');
  });

  it('does not offer to connect something already connected', () => {
    const rows = buildChannelRows([channel()], [], true, 'en');
    const offered = rows.filter((r) => r.kind === 'connectable').map((r) => r.channel);
    expect(offered).not.toContain('WHATSAPP');
  });

  it('prefers the display name over the raw external id', () => {
    const rows = connectedOnly(
      buildChannelRows(
        [channel({ displayName: 'Demo WhatsApp', externalId: '972...' })],
        [],
        true,
        'en',
      ),
    );
    expect(rows[0]!.identity).toBe('Demo WhatsApp');
  });

  it('falls back to the external id, and to null rather than an empty string', () => {
    expect(
      connectedOnly(
        buildChannelRows([channel({ externalId: '+972 3 921 4400' })], [], true, 'en'),
      )[0]!.identity,
    ).toBe('+972 3 921 4400');
    expect(
      connectedOnly(buildChannelRows([channel({ displayName: '  ' })], [], true, 'en'))[0]!
        .identity,
    ).toBeNull();
  });
});
