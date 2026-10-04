import {
  CONNECTABLE_CHANNELS,
  voiceStateAsConnection,
  type Channel,
  type ChannelType,
  type ConnectionState,
  type ResponseMode,
  type VoiceChannel,
} from '@/api/contracts/channels';

/**
 * The list: what is connected, then what could be.
 *
 * A pure function of what the read returned. No fetching, no translation, no
 * formatting — the component decides how a row reads in Hebrew; this decides
 * what a row IS.
 */

export interface ConnectedRow {
  readonly kind: 'connected';
  readonly id: string;
  readonly channel: ChannelType;
  /** The phone number, handle or address. Absent on a channel that has none. */
  readonly identity: string | null;
  readonly status: ConnectionState;
  /**
   * Null for voice, which has no `responseMode` — it routes by
   * `defaultAgentId` and `fallbackDepartmentId` instead, on its own spine.
   * Rendering "a person answers" for it would assert a field it does not have.
   */
  readonly responseMode: ResponseMode | null;
  /** The platform's own words. Present on a healthy row too — see below. */
  readonly error: string | null;
  /** Open RIGHT NOW — not CLOSED, no window. */
  readonly openConversations: number | null;
  /**
   * STARTED inside the window, any status. A different measure from the one
   * above, not the same measure zoomed out.
   *
   * `null` = not served, never coerced to 0.
   */
  readonly windowConversations: number | null;
  /** Web chat's widget id — what its embed code carries. `null` on the rest. */
  readonly widgetId?: string | null;
}

export interface ConnectableRow {
  readonly kind: 'connectable';
  readonly channel: ChannelType;
}

export type ChannelRow = ConnectedRow | ConnectableRow;

/**
 * A channel is a problem when the platform says so, whatever its status says.
 *
 * `connectionStatus` and `lastError` disagree in practice: this tenant's
 * Shopify channel is CONNECTED and carries *"Shopify Chat app was uninstalled
 * from the store."* Trusting the status alone would show it as healthy, which
 * is exactly the failure a health check exists to prevent — so an error text
 * is treated as a problem on its own.
 */
export function isTroubled(row: ConnectedRow): boolean {
  return row.status === 'ERROR' || row.status === 'DISCONNECTED' || row.error != null;
}

export function buildChannelRows(
  channels: readonly Channel[],
  voice: readonly VoiceChannel[],
  voiceOffered: boolean,
  locale: string,
): ChannelRow[] {
  const connected: ConnectedRow[] = channels.map((channel) => ({
    kind: 'connected',
    id: channel.id,
    channel: channel.channel,
    identity: channel.displayName?.trim() || channel.externalId?.trim() || null,
    status: channel.connectionStatus,
    responseMode: channel.responseMode,
    error: channel.lastError?.trim() || null,
    openConversations: channel._count?.conversations ?? null,
    /*
     * Checked with `typeof`, not truthiness: the route OMITS the key when no
     * window was asked for, and 0 is a real answer — a channel that received
     * nothing in 30 days is exactly what a health check needs to show.
     */
    windowConversations:
      typeof channel.conversationsInWindow === 'number' ? channel.conversationsInWindow : null,
    widgetId: channel.channel === 'WEBCHAT' ? (channel.externalId ?? null) : null,
  }));

  /*
   * Voice, folded in from the other spine.
   *
   * It carries no volume and no open count — those live on `Conversation`,
   * keyed to a `ChannelAccount` that a voice channel does not have — so both
   * stay null and the row simply shows fewer facts rather than inventing any.
   */
  for (const vc of voice) {
    connected.push({
      kind: 'connected',
      id: vc.id,
      channel: 'VOICE',
      identity:
        vc.numbers
          .find((n: { phoneNumber?: string | null }) => n.phoneNumber)
          ?.phoneNumber?.trim() ||
        vc.friendlyName?.trim() ||
        null,
      status: voiceStateAsConnection(vc.status),
      responseMode: null,
      // `healthStatus` is a free-form string on this spine, not an error
      // message — it is only a problem when the status already says so.
      error: null,
      openConversations: null,
      windowConversations: null,
    });
  }

  /*
   * Troubled first: a channel that has stopped working is the reason someone
   * opened this screen, and it must not be below the fold under four healthy
   * ones. Otherwise by name, locale-aware.
   */
  const collator = new Intl.Collator(locale, { sensitivity: 'base' });
  connected.sort((a, b) => {
    const at = isTroubled(a);
    const bt = isTroubled(b);
    if (at !== bt) return at ? -1 : 1;
    return collator.compare(a.channel, b.channel);
  });

  /*
   * What could still be connected.
   *
   * Only kinds with a real provisioning path: the six OAuth platforms, plus
   * email and web chat, plus VOICE when the product offers it to this tenant.
   *
   * `VOICE` is conditional rather than excluded. It IS connectable — `POST
   * /api/voice-channels`, with typed-in Twilio credentials rather than OAuth —
   * but its router is gated on `Tenant.voiceCopilotEnabled` and answers 404
   * when voice is not sold here. So the product decides whether to offer the
   * row, and `voiceOffered` carries that answer.
   *
   * `SHOPIFY_LIVE_CHAT` stays out unconditionally: it is installed from
   * Shopify, so a Connect button would send someone to the wrong place.
   */
  const already = new Set<ChannelType>(channels.map((c) => c.channel));
  if (voice.length > 0) already.add('VOICE');

  const offerable: readonly ChannelType[] = voiceOffered
    ? [...CONNECTABLE_CHANNELS, 'VOICE']
    : CONNECTABLE_CHANNELS;

  const connectable: ConnectableRow[] = offerable
    .filter((type) => !already.has(type))
    .map((type) => ({ kind: 'connectable', channel: type }));

  return [...connected, ...connectable];
}
