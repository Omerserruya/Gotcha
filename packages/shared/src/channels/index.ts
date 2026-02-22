export type {
  ChannelType,
  NormalizedInboundMessage,
  NormalizedStatusUpdate,
  MessageContent,
  OutboundMessagePayload,
  ChannelCredentials,
  InboundAdapter,
  OutboundAdapter,
} from "./types";

export {
  detectInboundAdapter,
  getOutboundAdapter,
  getInboundAdapters,
  getSupportedChannels,
} from "./registry";

export { whatsAppInboundAdapter, whatsAppOutboundAdapter } from "./whatsapp.adapter";
export { messengerInboundAdapter, messengerOutboundAdapter } from "./messenger.adapter";
export { instagramInboundAdapter, instagramOutboundAdapter } from "./instagram.adapter";
