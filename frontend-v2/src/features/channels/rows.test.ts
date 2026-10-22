import { describe, expect, it } from 'vitest';

import { channelSchema, voiceChannelSchema, type Channel } from '@/api/contracts/channels';

import { buildChannelRows, isTroubled, needsReconnect, type ConnectedRow } from './rows';

const channel = (over: Partial<Channel> = {}): Channel => ({
  id: 'c1',
  channel: 'WHATSAPP',
  isActive: true,
  connectionStatus: 'CONNECTED',
  ...over,
});

const connectedOnly = (rows: ReturnType<typeof buildChannelRows>): ConnectedRow[] =>
  rows.filter((r): r is ConnectedRow => r.kind === 'connected');

describe('buildChannelRows', () => {
  it('renders a row per ACCOUNT, never per channel type', () => {
    // The tenant has WEBCHAT conversations and no WEBCHAT account. The list is
    // driven by accounts, so a channel with no account cannot produce a row -
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

  it('★★ a voice channel’s failed check or missing outbound is its error, from the route’s shape', () => {
    // conversation routes/voice-channels.ts serializeChannel, field for field.
    const wire = (over: Record<string, unknown>) =>
      voiceChannelSchema.parse({
        id: 'v1',
        friendlyName: 'Main line',
        status: 'ACTIVE',
        healthStatus: null,
        healthCheckedAt: null,
        config: {},
        webhookSecret: 'hmac',
        numbers: [],
        ...over,
      });
    const errorOf = (over: Record<string, unknown>) =>
      connectedOnly(buildChannelRows([], [wire(over)], true, 'en'))[0]!;

    expect(errorOf({}).error).toBeNull();
    const outbound = errorOf({
      config: { outboundProvisioningFailed: true, outboundProvisioningError: 'twilio_api_401: x' },
    });
    expect(outbound.error).toBe('voice_outbound_not_set_up');
    expect(isTroubled(outbound)).toBe(true);
    expect(errorOf({ healthStatus: 'decryption_failed' }).error).toBe(
      'voice_credentials_unreadable',
    );
    expect(errorOf({ healthStatus: 'Some Twilio text' }).error).toBe('unknown');
    // ★ conversation 538c0218: the last failed activation, by its code; the sentence is never read.
    expect(
      errorOf({
        lastError: 'Twilio did not accept the new call address for this number.',
        lastErrorCode: 'TWILIO_WEBHOOK_UPDATE_FAILED',
      }).error,
    ).toBe('voice_webhook_not_updated');
    expect(
      errorOf({ healthStatus: 'ok', lastError: 'x', lastErrorCode: 'VOICE_PUBLIC_URL_MISSING' })
        .error,
    ).toBe('voice_public_url_missing');
    // A field in another shape is no error, not a rejected voice read.
    expect(errorOf({ lastError: 5, lastErrorCode: { a: 1 } }).error).toBeNull();
    // A config in another shape is no flag, not a rejected voice read.
    expect(errorOf({ config: 'nonsense' }).error).toBeNull();
    // Twilio's raw text and the webhook secret do not cross into the row's source.
    expect(wire({ config: { outboundProvisioningError: 'raw' } }).config).toStrictEqual({
      outboundProvisioningFailed: false,
    });
    expect(wire({})).not.toHaveProperty('webhookSecret');
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
    // someone to the wrong place. (Voice IS connectable - see above.)
    expect(offered).not.toContain('SHOPIFY_LIVE_CHAT');
    // Nor the web chat: the widget's row is always there, its code on Install.
    expect(offered).not.toContain('WEBCHAT');
    expect(offered).toContain('WHATSAPP');
  });

  it('★★ the web chat and every Shopify chat are ONE widget row, present even with neither', () => {
    const of = (type: string, id: string) =>
      channelSchema.parse({ id, channel: type, connectionStatus: 'CONNECTED' });
    const rows = buildChannelRows(
      [of('WEBCHAT', 'wc1'), of('SHOPIFY_LIVE_CHAT', 'sc1'), of('SHOPIFY_LIVE_CHAT', 'sc2')],
      [],
      false,
      'en',
    );
    const widgets = rows.filter((r) => r.kind === 'widget');
    expect(widgets).toHaveLength(1);
    expect(widgets[0]?.kind === 'widget' && widgets[0].parts.map((p) => p.id)).toEqual([
      'wc1',
      'sc1',
      'sc2',
    ]);
    expect(connectedOnly(rows)).toHaveLength(0);
    expect(buildChannelRows([], [], false, 'en').filter((r) => r.kind === 'widget')).toHaveLength(
      1,
    );
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

describe('★ a channel someone disconnected can be connected again (2026-10-09)', () => {
  const connectable = (rows: ReturnType<typeof buildChannelRows>) =>
    rows.flatMap((r) => (r.kind === 'connectable' ? [r.channel] : []));

  it('★ a disconnected Instagram is a Connect row - not "needs attention" with nothing to press', () => {
    const rows = buildChannelRows(
      [channel({ id: 'ig1', channel: 'INSTAGRAM', connectionStatus: 'DISCONNECTED' })],
      [],
      false,
      'en',
    );
    expect(connectedOnly(rows).map((r) => r.id)).not.toContain('ig1');
    expect(connectable(rows)).toContain('INSTAGRAM');
  });

  it('one of two Messenger pages disconnected: the other stays, and no second Connect row', () => {
    const rows = buildChannelRows(
      [
        channel({ id: 'p1', channel: 'MESSENGER', connectionStatus: 'DISCONNECTED' }),
        channel({ id: 'p2', channel: 'MESSENGER', connectionStatus: 'CONNECTED' }),
      ],
      [],
      false,
      'en',
    );
    expect(connectedOnly(rows).map((r) => r.id)).toEqual(['p2']);
    expect(connectable(rows)).not.toContain('MESSENGER');
  });

  it('a disconnected mailbox stays its row: its connect route refuses the same address (409)', () => {
    const rows = buildChannelRows(
      [channel({ id: 'e1', channel: 'EMAIL', connectionStatus: 'DISCONNECTED' })],
      [],
      false,
      'en',
    );
    expect(connectedOnly(rows).map((r) => r.id)).toContain('e1');
    expect(connectable(rows)).not.toContain('EMAIL');
  });
});

describe('★★ connected, but nothing arrives: a Reconnect on the row (auth 4061f669)', () => {
  const rowOf = (over: Partial<Channel>) =>
    connectedOnly(buildChannelRows([channel(over)], [], false, 'en'))[0]!;

  it.each([
    ['MESSENGER', 'PENDING', 'SUBSCRIBE_FAILED'],
    ['INSTAGRAM', 'PENDING', 'SUBSCRIBE_FAILED'],
    ['GMAIL', 'CONNECTED', 'WATCH_FAILED'],
    ['OUTLOOK', 'CONNECTED', 'OUTLOOK_SUBSCRIPTION_FAILED'],
  ] as const)('%s %s with %s: needs attention, and Reconnect', (type, status, code) => {
    const row = rowOf({
      channel: type,
      connectionStatus: status,
      lastError: 'provider text',
      lastErrorCode: code,
    });
    expect(isTroubled(row)).toBe(true);
    expect(needsReconnect(row)).toBe(true);
  });

  it('another error, or none: no Reconnect - Connect would not mend it', () => {
    expect(needsReconnect(rowOf({ channel: 'MESSENGER' }))).toBe(false);
    expect(
      needsReconnect(
        rowOf({ channel: 'INSTAGRAM', lastError: 'Token expired', lastErrorCode: null }),
      ),
    ).toBe(false);
  });

  it('a channel whose Connect does not come back to its account gets none, whatever the code', () => {
    expect(
      needsReconnect(
        rowOf({ channel: 'WHATSAPP', lastError: 'x', lastErrorCode: 'SUBSCRIBE_FAILED' }),
      ),
    ).toBe(false);
    expect(
      needsReconnect(rowOf({ channel: 'EMAIL', lastError: 'x', lastErrorCode: 'WATCH_FAILED' })),
    ).toBe(false);
  });
});
