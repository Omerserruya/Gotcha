import { z } from 'zod';

/**
 * Settings · Channels - screen 13.
 *
 * *"Where customers reach you. Connecting is a two-step task, not an
 * integration form."*
 *
 * Shapes read from `services/auth/src/routes/channels.ts` and
 * `services/analytics/src/services/analytics.service.ts`.
 *
 * Three things the design draws that nothing behind them can store:
 *
 *   - **"Who should answer it?" naming an AI employee or a team.**
 *     `ChannelAccount` has no `aiAgentId`, no `departmentId` and no owner
 *     field of any kind. Who answers is the automation's / playbook's to
 *     decide, not the channel's (Omer, 2026-10-07): the channel's old
 *     answer-mode field was read by nothing at runtime and is no longer
 *     parsed, drawn or written. (`object` strips it if the route still sends
 *     it.)
 *   - **Per-channel greeting, hours and auto-assignment.**
 *     `autoGreetingEnabled`, `autoGreetingMessage` and `workingHours` are
 *     fields on `Department`. A channel has none of them.
 *   - **"Phone calls - Connect".** `VOICE` is a `ChannelType`, but the
 *     channels router has no voice provisioning route: the voice service
 *     handles live calls, not connecting a number. So the row is absent
 *     rather than offering a button that reaches nothing.
 */

/** Every channel the platform models. Not all of them can be connected. */
export const CHANNEL_TYPES = [
  'WHATSAPP',
  'MESSENGER',
  'INSTAGRAM',
  'EMAIL',
  'GMAIL',
  'OUTLOOK',
  'SLACK',
  'VOICE',
  'WEBCHAT',
  'SHOPIFY_LIVE_CHAT',
] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

/**
 * The six platforms `GET /api/channels/oauth/init` accepts, in its own order
 * of validation. Anything else is a 400 from that route.
 */
export const OAUTH_PLATFORMS = {
  MESSENGER: 'messenger',
  INSTAGRAM: 'instagram',
  WHATSAPP: 'whatsapp',
  GMAIL: 'gmail',
  OUTLOOK: 'outlook',
  SLACK: 'slack',
} as const satisfies Partial<Record<ChannelType, string>>;

/**
 * What a person can start connecting from this screen.
 *
 * The six OAuth platforms plus the two that need no authorisation handshake:
 * `EMAIL` (its own IMAP/SMTP route) and `WEBCHAT` (created outright).
 *
 * `VOICE` is deliberately absent - see the note at the top of this file - and
 * `SHOPIFY_LIVE_CHAT` too: it is provisioned by installing the Shopify app,
 * not from here, so a Connect button would send someone to the wrong place.
 */
export const CONNECTABLE_CHANNELS = [
  'WHATSAPP',
  'INSTAGRAM',
  'MESSENGER',
  'EMAIL',
  'GMAIL',
  'OUTLOOK',
  'SLACK',
  'WEBCHAT',
] as const satisfies readonly ChannelType[];

export const CONNECTION_STATES = ['PENDING', 'CONNECTED', 'ERROR', 'DISCONNECTED'] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

/**
 * `GET /api/channels` - enveloped in `data`, needs `channels:manage:read`.
 *
 * **`object`, not `looseObject`, deliberately.** The route does not return
 * `credentials`, which is the important thing - but it does return
 * `platformMeta`, a free-form blob that holds a widget's entire appearance
 * config for Shopify and platform identifiers (an Outlook subscription id, an
 * Instagram page id) for others. None of it is needed to render a row, so
 * none of it crosses out of this layer. A loose schema would carry all of it
 * into the page.
 *
 * `externalId` IS kept: it is the phone number or page handle the design
 * shows as the channel's identity, and it is public by nature.
 */
export const channelSchema = z.object({
  id: z.string().min(1),
  channel: z.enum(CHANNEL_TYPES).catch('WEBCHAT'),
  externalId: z.string().nullable().optional(),
  displayName: z.string().nullable().optional(),
  isActive: z.boolean().default(true),
  connectionStatus: z.enum(CONNECTION_STATES).catch('PENDING'),
  connectedAt: z.string().nullable().optional(),
  tokenExpiresAt: z.string().nullable().optional(),
  /**
   * The platform's own words for what is wrong, e.g. *"Shopify Chat app was
   * uninstalled from the store."* Rendered as-is: our paraphrase of a
   * platform error is a second, vaguer copy of a message it already wrote.
   */
  lastError: z.string().nullable().optional(),
  /** The error's code (auth e28012b0): `platformErrorReason` keys on it first. */
  lastErrorCode: z.string().nullable().optional(),
  lastHealthCheck: z.string().nullable().optional(),
  _count: z.object({ conversations: z.number().default(0) }).optional(),
  /**
   * Conversations that STARTED on this account inside the requested window.
   *
   * By `createdAt`, so a conversation running since August is not in a
   * September window. It counts what arrived, not what was open - which is
   * why it sits beside `_count.conversations` rather than replacing it. The
   * two are different measures, not one measure at two zoom levels, and the
   * copy must not caption them as the same thing.
   *
   * Optional, and absent is NOT zero: the route omits the key entirely when
   * no window is asked for, so "you did not ask" never renders as "there were
   * none". Checked with `typeof`, never for truthiness - 0 is a real answer.
   */
  conversationsInWindow: z.number().optional(),
});

export const channelsSchema = z.array(channelSchema);
export type Channel = z.infer<typeof channelSchema>;

/*
 * ── Why volume is NOT read from analytics ───────────────────────────────
 *
 * `GET /api/analytics/channel-performance` also serves per-channel counts, and
 * this screen deliberately does not use it. It groups by channel TYPE, so two
 * WhatsApp numbers collapse into one figure - and it counts conversations
 * whose account is gone or never existed.
 *
 * Those orphans are two different stories that look identical:
 * `Conversation.channelAccountId` is `onDelete: SetNull` - deliberately,
 * because it was `Cascade` once and removing a WhatsApp number silently
 * deleted every conversation on it - so an unmatched row means EITHER "these
 * conversations outlived their account" or "no such account was ever created".
 * This tenant has both shapes: WEBCHAT conversations with no WEBCHAT account.
 *
 * `conversationsInWindow` comes from the channel row instead, driven by
 * `ChannelAccount`. An account that does not exist cannot produce a row, so
 * the orphan question disappears rather than being answered. Reconciling
 * orphan volume against a tenant total is analytics' job, and a different one.
 */

// ── Voice, which is a different spine entirely ──────────────────────

/**
 * `GET /api/voice-channels` - enveloped in `data`, ADMIN only.
 *
 * Voice is NOT a `ChannelAccount`. It is `CommunicationChannel` →
 * `VoiceChannel`, served by the conversation service, and the two share the
 * `ChannelType` enum and nothing else:
 *
 *   - status is `PENDING | ACTIVE | DISABLED | ERROR` - note `ACTIVE`, not
 *     `CONNECTED`, and `DISABLED`, not `DISCONNECTED`. Mapped explicitly
 *     rather than unified: one type over two enums would invent a
 *     correspondence that does not exist.
 *   - health is `healthStatus` + `healthCheckedAt`, not `lastError`.
 *   - connecting is **typed-in Twilio credentials**, not an OAuth redirect.
 *
 * **404 is a real answer, not a failure.** The router is gated on
 * `Tenant.voiceCopilotEnabled`, which answers `404 not_found` when voice is
 * not offered to this tenant at all. So the Phone calls row appears only when
 * the product says voice exists here - the product decides, not us.
 *
 * **`object`, not `looseObject`:** the route serialises `webhookSecret`, a
 * per-channel HMAC used to authenticate inbound webhooks. It must not cross
 * into a browser payload, and a loose schema would carry it there.
 */
export const VOICE_STATES = ['PENDING', 'ACTIVE', 'DISABLED', 'ERROR'] as const;
export type VoiceState = (typeof VOICE_STATES)[number];

export const voiceChannelSchema = z.object({
  id: z.string().min(1),
  friendlyName: z.string().nullable().optional(),
  status: z.enum(VOICE_STATES).catch('PENDING'),
  healthStatus: z.string().nullable().optional(),
  healthCheckedAt: z.string().nullable().optional(),
  /** Always an array from the backend, even when discovery was skipped. */
  numbers: z.array(z.object({ phoneNumber: z.string().nullable().optional() })).default([]),
});

export const voiceChannelsSchema = z.array(voiceChannelSchema);
export type VoiceChannel = z.infer<typeof voiceChannelSchema>;

/**
 * Voice status onto the one this screen renders.
 *
 * Explicit, and the two gaps are the point: voice has no `CONNECTED` and no
 * `DISCONNECTED`. `ACTIVE` is the working state and `DISABLED` is the
 * switched-off one, so they map onto the words this screen already uses
 * without either enum pretending to be the other.
 */
export function voiceStateAsConnection(status: VoiceState): ConnectionState {
  if (status === 'ACTIVE') return 'CONNECTED';
  if (status === 'DISABLED') return 'DISCONNECTED';
  if (status === 'ERROR') return 'ERROR';
  return 'PENDING';
}
