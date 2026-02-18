import type { InboundAdapter, OutboundAdapter, ChannelType } from "./types";
import { whatsAppInboundAdapter, whatsAppOutboundAdapter } from "./whatsapp.adapter";
import { messengerInboundAdapter, messengerOutboundAdapter } from "./messenger.adapter";

// ─── Channel Registry ────────────────────────────────────────

const inboundAdapters: InboundAdapter[] = [
  whatsAppInboundAdapter,
  messengerInboundAdapter,
];

const outboundAdapters: Map<ChannelType, OutboundAdapter> = new Map([
  ["WHATSAPP", whatsAppOutboundAdapter],
  ["MESSENGER", messengerOutboundAdapter],
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
