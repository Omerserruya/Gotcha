import {
  platformErrorReason,
  voiceErrorReason,
  type ChannelErrorReason,
} from '@/api/contracts/platform-errors';
import {
  CONNECTABLE_CHANNELS,
  voiceStateAsConnection,
  type Channel,
  type ChannelType,
  type ConnectionState,
  type VoiceChannel,
} from '@/api/contracts/channels';
import { WIDGET_CHANNELS } from '@/api/contracts/website-widget';

/**
 * The list: what is connected, then what could be.
 *
 * A pure function of what the read returned. No fetching, no translation, no
 * formatting - the component decides how a row reads in Hebrew; this decides
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
   * The platform's error as a reason (`platformErrorReason`, or
   * `voiceErrorReason` on voice), never its raw English. Present on a
   * healthy row too - see below.
   */
  readonly error: ChannelErrorReason | null;
  /** Open RIGHT NOW - not CLOSED, no window. */
  readonly openConversations: number | null;
  /**
   * STARTED inside the window, any status. A different measure from the one
   * above, not the same measure zoomed out.
   *
   * `null` = not served, never coerced to 0.
   */
  readonly windowConversations: number | null;
  /** Web chat's widget id - what its embed code carries. `null` on the rest. */
  readonly widgetId?: string | null;
}

export interface ConnectableRow {
  readonly kind: 'connectable';
  readonly channel: ChannelType;
}

/**
 * The Website widget (Omer, 2026-10-07): the web chat and every Shopify live
 * chat are ONE row - one product, set up once, installed in many places. Its
 * parts are the accounts it is made of; none yet is a widget not installed
 * anywhere, still a row, because its settings are where it is set up.
 */
export interface WidgetRow {
  readonly kind: 'widget';
  readonly parts: readonly ConnectedRow[];
}

export type ChannelRow = ConnectedRow | ConnectableRow | WidgetRow;

const isWidgetChannel = (channel: ChannelType) =>
  (WIDGET_CHANNELS as readonly ChannelType[]).includes(channel);

/**
 * A channel is a problem when the platform says so, whatever its status says.
 *
 * `connectionStatus` and `lastError` disagree in practice: this tenant's
 * Shopify channel is CONNECTED and carries *"Shopify Chat app was uninstalled
 * from the store."* Trusting the status alone would show it as healthy, which
 * is exactly the failure a health check exists to prevent - so an error text
 * is treated as a problem on its own.
 */
export function isTroubled(row: ConnectedRow): boolean {
  return row.status === 'ERROR' || row.status === 'DISCONNECTED' || row.error != null;
}

/**
 * The channels a row can disconnect, by `POST /api/channels/:id/disconnect`
 * (services/auth routes/channels.ts): the route works on any channel account
 * of the workspace, and these are the ones it was checked for - it stops the
 * platform's own delivery for Instagram, Messenger, Gmail, Outlook and Slack,
 * and for email the inbound route only takes active accounts.
 *
 * Not here: WhatsApp (its numbers are disconnected one by one, in 13b), voice
 * (another spine - its rows are not channel accounts), and the Website widget
 * (the route would wipe its settings, stored as its credentials, and the
 * widget has no way back from DISCONNECTED).
 */
export const DISCONNECTABLE_CHANNELS = [
  'INSTAGRAM',
  'MESSENGER',
  'GMAIL',
  'OUTLOOK',
  'SLACK',
  'EMAIL',
] as const satisfies readonly ChannelType[];

/** Channels whose Connect, run again, brings a disconnected account back (OAuth). */
export const RECONNECT_BY_CONNECTING = [
  'INSTAGRAM',
  'MESSENGER',
  'GMAIL',
  'OUTLOOK',
  'SLACK',
] as const satisfies readonly ChannelType[];

/** A Disconnect on this row - never on one that is disconnected already. */
export function canDisconnect(row: ConnectedRow): boolean {
  return (
    (DISCONNECTABLE_CHANNELS as readonly ChannelType[]).includes(row.channel) &&
    row.status !== 'DISCONNECTED'
  );
}

export function buildChannelRows(
  channels: readonly Channel[],
  voice: readonly VoiceChannel[],
  voiceOffered: boolean,
  locale: string,
): ChannelRow[] {
  /*
   * ★ A channel someone disconnected is connectable again (2026-10-09).
   * Disconnect keeps its account, DISCONNECTED and inactive; the OAuth
   * callbacks find that account by its key and set it CONNECTED again. So it
   * is offered as a Connect row - not left on the list as "needs attention"
   * with nothing to press. Email is not here: its route answers 409 "already
   * connected" for a disconnected address (Backend gap), so its row stays.
   */
  const live = channels.filter(
    (c) =>
      !(
        c.connectionStatus === 'DISCONNECTED' &&
        (RECONNECT_BY_CONNECTING as readonly ChannelType[]).includes(c.channel)
      ),
  );
  const connected: ConnectedRow[] = live.map((channel) => ({
    kind: 'connected',
    id: channel.id,
    channel: channel.channel,
    identity: channel.displayName?.trim() || channel.externalId?.trim() || null,
    status: channel.connectionStatus,
    error: platformErrorReason(channel.lastError, channel.lastErrorCode),
    openConversations: channel._count?.conversations ?? null,
    /*
     * Checked with `typeof`, not truthiness: the route OMITS the key when no
     * window was asked for, and 0 is a real answer - a channel that received
     * nothing in 30 days is exactly what a health check needs to show.
     */
    windowConversations:
      typeof channel.conversationsInWindow === 'number' ? channel.conversationsInWindow : null,
    widgetId: channel.channel === 'WEBCHAT' ? (channel.externalId ?? null) : null,
  }));

  /*
   * Voice, folded in from the other spine.
   *
   * It carries no volume and no open count - those live on `Conversation`,
   * keyed to a `ChannelAccount` that a voice channel does not have - so both
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
      // A failed health check, or outgoing calls never set up, in words -
      // never `healthStatus`'s raw Twilio text.
      error: voiceErrorReason(vc.healthStatus, vc.config?.outboundProvisioningFailed ?? false),
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
  const parts = connected.filter((row) => isWidgetChannel(row.channel));
  const others = connected.filter((row) => !isWidgetChannel(row.channel));
  others.sort((a, b) => {
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
   * `VOICE` is conditional rather than excluded. It IS connectable - `POST
   * /api/voice-channels`, with typed-in Twilio credentials rather than OAuth -
   * but its router is gated on `Tenant.voiceCopilotEnabled` and answers 404
   * when voice is not sold here. So the product decides whether to offer the
   * row, and `voiceOffered` carries that answer.
   *
   * `SHOPIFY_LIVE_CHAT` stays out unconditionally: it is installed from
   * Shopify, so a Connect button would send someone to the wrong place. And
   * `WEBCHAT` now too: the widget's row is always there, and its Install tab
   * is where the code is made.
   */
  const already = new Set<ChannelType>(live.map((c) => c.channel));
  if (voice.length > 0) already.add('VOICE');

  const offerable: readonly ChannelType[] = voiceOffered
    ? [...CONNECTABLE_CHANNELS, 'VOICE']
    : CONNECTABLE_CHANNELS;

  const connectable: ConnectableRow[] = offerable
    .filter((type) => !already.has(type) && !isWidgetChannel(type))
    .map((type) => ({ kind: 'connectable', channel: type }));

  // Troubled first, as every row: a shop the app was removed from heads the list.
  const widget: WidgetRow = { kind: 'widget', parts };
  const troubled = others.filter(isTroubled);
  const healthy = others.filter((row) => !isTroubled(row));
  return parts.some(isTroubled)
    ? [widget, ...troubled, ...healthy, ...connectable]
    : [...troubled, ...healthy, widget, ...connectable];
}
