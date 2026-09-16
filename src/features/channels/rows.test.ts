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
    const rows = buildChannelRows([channel()], 'en');
    expect(connectedOnly(rows)).toHaveLength(1);
    expect(rows.find((r) => r.kind === 'connected' && r.channel === 'WEBCHAT')).toBeUndefined();
  });

  it('reads the window count off the row', () => {
    const rows = buildChannelRows([channel({ conversationsInWindow: 71 })], 'en');
    expect(connectedOnly(rows)[0]!.windowConversations).toBe(71);
  });

  it('keeps a served zero as zero', () => {
    // A channel that received nothing in 30 days is exactly what a health
    // check needs to show, so 0 must survive rather than being falsy-dropped.
    const rows = buildChannelRows([channel({ conversationsInWindow: 0 })], 'en');
    expect(connectedOnly(rows)[0]!.windowConversations).toBe(0);
  });

  it('leaves the window count null when the key is absent', () => {
    // The route omits it entirely when no window was asked for. "You did not
    // ask" must never render as "there were none".
    const rows = buildChannelRows([channel()], 'en');
    expect(connectedOnly(rows)[0]!.windowConversations).toBeNull();
  });

  it('keeps the open count and the window count as separate measures', () => {
    // Open NOW vs STARTED in the window. Not one measure at two zoom levels:
    // a conversation running since August is in neither.
    const rows = buildChannelRows(
      [channel({ _count: { conversations: 3 }, conversationsInWindow: 71 })],
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
        'en',
      ),
    );
    expect(rows[0]!.id).toBe('bad');
  });

  it('offers only channels that have a provisioning path', () => {
    const rows = buildChannelRows([], 'en');
    const offered = rows.filter((r) => r.kind === 'connectable').map((r) => r.channel);
    // No voice provisioning route exists at all, and Shopify is installed
    // from Shopify — a Connect button for either reaches nothing.
    expect(offered).not.toContain('VOICE');
    expect(offered).not.toContain('SHOPIFY_LIVE_CHAT');
    expect(offered).toContain('WHATSAPP');
  });

  it('does not offer to connect something already connected', () => {
    const rows = buildChannelRows([channel()], 'en');
    const offered = rows.filter((r) => r.kind === 'connectable').map((r) => r.channel);
    expect(offered).not.toContain('WHATSAPP');
  });

  it('prefers the display name over the raw external id', () => {
    const rows = connectedOnly(
      buildChannelRows([channel({ displayName: 'Demo WhatsApp', externalId: '972...' })], 'en'),
    );
    expect(rows[0]!.identity).toBe('Demo WhatsApp');
  });

  it('falls back to the external id, and to null rather than an empty string', () => {
    expect(
      connectedOnly(buildChannelRows([channel({ externalId: '+972 3 921 4400' })], 'en'))[0]!
        .identity,
    ).toBe('+972 3 921 4400');
    expect(
      connectedOnly(buildChannelRows([channel({ displayName: '  ' })], 'en'))[0]!.identity,
    ).toBeNull();
  });
});
