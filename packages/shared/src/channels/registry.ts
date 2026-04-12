import type { InboundAdapter, OutboundAdapter, ChannelType } from "./types";
import { whatsAppInboundAdapter, whatsAppOutboundAdapter } from "./whatsapp.adapter";
import { messengerInboundAdapter, messengerOutboundAdapter } from "./messenger.adapter";
import { instagramInboundAdapter, instagramOutboundAdapter } from "./instagram.adapter";
import { emailInboundAdapter, emailOutboundAdapter } from "./email.adapter";
import { gmailInboundAdapter, gmailOutboundAdapter } from "./gmail.adapter";
import { outlookInboundAdapter, outlookOutboundAdapter } from "./outlook.adapter";
import { slackInboundAdapter, slackOutboundAdapter } from "./slack.adapter";
import { webchatOutboundAdapter } from "./webchat.adapter";

// ─── Channel Registry ────────────────────────────────────────

const inboundAdapters: InboundAdapter[] = [
  whatsAppInboundAdapter,
  messengerInboundAdapter,
  instagramInboundAdapter,
  emailInboundAdapter,
  gmailInboundAdapter,
  outlookInboundAdapter,
  slackInboundAdapter,
];

const outboundAdapters: Map<ChannelType, OutboundAdapter> = new Map([
  ["WHATSAPP", whatsAppOutboundAdapter],
  ["MESSENGER", messengerOutboundAdapter],
  ["INSTAGRAM", instagramOutboundAdapter],
  ["EMAIL", emailOutboundAdapter],
  ["GMAIL", gmailOutboundAdapter],
  ["OUTLOOK", outlookOutboundAdapter],
  ["SLACK", slackOutboundAdapter],
  ["WEBCHAT", webchatOutboundAdapter],
]);

/**
 * Detect which inbound adapter can handle the webhook payload.
 * Returns the first adapter whose canHandle() returns true.
 */
export function detectInboundAdapter(webhookPayload: any): InboundAdapter | null {
  for (const adapter of inboundAdapters) {
    if (adapter.canHandle(webhookPayload)) {
      return adapter;
    }
  }
  return null;
}

/**
 * Get the outbound adapter for a specific channel.
 */
export function getOutboundAdapter(channel: ChannelType): OutboundAdapter | null {
  return outboundAdapters.get(channel) || null;
}

/**
 * Get all registered inbound adapters.
 */
export function getInboundAdapters(): InboundAdapter[] {
  return [...inboundAdapters];
}

/**
 * Get all supported channel types.
 */
export function getSupportedChannels(): ChannelType[] {
  return Array.from(outboundAdapters.keys());
}
