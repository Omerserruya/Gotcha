// ─── Channel Types & Interfaces ──────────────────────────────

export type ChannelType = "WHATSAPP" | "MESSENGER" | "INSTAGRAM" | "EMAIL" | "GMAIL" | "OUTLOOK" | "SLACK" | "WEBCHAT";

export interface NormalizedInboundMessage {
  externalMessageId: string;
  channel: ChannelType;
  senderId: string;           // Phone number (WA) or PSID (Messenger)
  senderDisplayName?: string;
  timestamp: Date;
  content: MessageContent;
}

export interface MessageContent {
  type: "text" | "image" | "document" | "audio" | "video" | "interactive" | "location";
  text?: string;
  mediaUrl?: string;
  caption?: string;
  interactiveReply?: {
    type: "button" | "quick_reply" | "postback";
    payload: string;
    title: string;
  };
}

export interface NormalizedStatusUpdate {
  externalMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  timestamp?: Date;
  errorMessage?: string;
}

export interface OutboundMessagePayload {
  type: "text" | "interactive";
  text?: string;
  interactive?: {
    type: "quick_reply";
    bodyText: string;
    buttons: Array<{ id: string; title: string }>;
  };
}

export interface ChannelCredentials {
  accessToken: string;
  appSecret?: string;
  webhookSecret?: string;
  [key: string]: any;
}

// ─── Adapter Interfaces ─────────────────────────────────────

export interface InboundAdapter {
  channel: ChannelType;
  canHandle(webhookPayload: any): boolean;
  extractMessages(payload: any): NormalizedInboundMessage[];
  extractStatusUpdates(payload: any): NormalizedStatusUpdate[];
  resolveChannelAccountExternalId(payload: any): string | null;
  verifySignature(appSecret: string, rawBody: Buffer, signature: string): boolean;
  getSignatureHeader(): string;
}

export interface OutboundAdapter {
  channel: ChannelType;
  sendTextMessage(
    credentials: ChannelCredentials,
    accountExternalId: string,
    recipientId: string,
    text: string
  ): Promise<string | null>;
  sendInteractiveMessage(
    credentials: ChannelCredentials,
    accountExternalId: string,
    recipientId: string,
    bodyText: string,
    buttons: Array<{ id: string; title: string }>
  ): Promise<string | null>;
  sendMediaMessage?(
    credentials: ChannelCredentials,
    accountExternalId: string,
    recipientId: string,
    mediaUrl: string,
    mediaType: "image" | "video" | "document",
    fileName?: string,
    caption?: string
  ): Promise<string | null>;
  sendTemplateMessage?(
    credentials: ChannelCredentials,
    accountExternalId: string,
    recipientId: string,
    templateName: string,
    language: string,
    components?: any[]
  ): Promise<string | null>;
}
