import type { InboundAdapter, OutboundAdapter, ChannelType } from "./types";
import { whatsAppInboundAdapter, whatsAppOutboundAdapter } from "./whatsapp.adapter";
import { messengerInboundAdapter, messengerOutboundAdapter } from "./messenger.adapter";
import { instagramInboundAdapter, instagramOutboundAdapter } from "./instagram.adapter";
import { emailInboundAdapter, emailOutboundAdapter } from "./email.adapter";
import { gmailInboundAdapter, gmailOutboundAdapter } from "./gmail.adapter";
import { outlookInboundAdapter, outlookOutboundAdapter } from "./outlook.adapter";
import { slackInboundAdapter, slackOutboundAdapter } from "./slack.adapter";
import { webchatOutboundAdapter } from "./webchat.adapter";
import { shopifyLiveChatOutboundAdapter } from "./shopify-live-chat.adapter";
import { withEmailTemplate } from "./email-template-apply";

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
  // The channel's HTML email template is applied here, once, for every producer.
  ["EMAIL", withEmailTemplate("EMAIL", emailOutboundAdapter)],
  ["GMAIL", withEmailTemplate("GMAIL", gmailOutboundAdapter)],
  ["OUTLOOK", withEmailTemplate("OUTLOOK", outlookOutboundAdapter)],
  ["SLACK", slackOutboundAdapter],
  ["WEBCHAT", webchatOutboundAdapter],
  ["SHOPIFY_LIVE_CHAT", shopifyLiveChatOutboundAdapter],
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
