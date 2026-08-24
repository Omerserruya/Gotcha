export * from "./email-thread";
export type {
  ChannelType,
  NormalizedInboundMessage,
  NormalizedStatusUpdate,
  NormalizedCommentEvent,
  NormalizedOutboundEcho,
  NormalizedHistoryChunk,
  NormalizedHistoricalMessage,
  MessageContent,
  OutboundMessagePayload,
  ChannelCredentials,
  InboundAdapter,
  OutboundAdapter,
  ProviderSendError,
} from "./types";

export { ChannelSendError, describeSendError } from "./types";

export {
  detectInboundAdapter,
  getOutboundAdapter,
  getInboundAdapters,
  getSupportedChannels,
} from "./registry";

export { whatsAppInboundAdapter, whatsAppOutboundAdapter } from "./whatsapp.adapter";
export { messengerInboundAdapter, messengerOutboundAdapter } from "./messenger.adapter";
export { instagramInboundAdapter, instagramOutboundAdapter } from "./instagram.adapter";
export { emailInboundAdapter, emailOutboundAdapter } from "./email.adapter";
export { gmailInboundAdapter, gmailOutboundAdapter, resolveAccessToken as gmailResolveAccessToken, fetchNewMessages as gmailFetchNewMessages } from "./gmail.adapter";
export type { GmailFetchedMessage } from "./gmail.adapter";
export { outlookInboundAdapter, outlookOutboundAdapter } from "./outlook.adapter";
export { slackInboundAdapter, slackOutboundAdapter } from "./slack.adapter";
export { webchatOutboundAdapter } from "./webchat.adapter";
export { shopifyLiveChatOutboundAdapter } from "./shopify-live-chat.adapter";
