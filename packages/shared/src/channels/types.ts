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

// Public comment event normalized across IG (entry.changes[].field === "comments")
// and FB Messenger feed comments (entry.changes[].field === "feed", value.item === "comment").
// Used by the Comment Trigger pipeline; not a message and never written to the
// Message table — comments don't fit a 1:1 conversation model.
export interface NormalizedCommentEvent {
  channel: ChannelType;
  commentId: string;          // Comment node ID — passed to Private Reply API as recipient.comment_id
  postId: string;              // Parent post / media ID — what flow authors match against in CommentTrigger.data.postId
  postPermalink?: string;
  text: string;
  fromUserId: string;          // IGSID for IG / FB User ID for Messenger — informational only; cannot be used as messaging recipient (see Private Reply rationale)
  fromUsername?: string;
  timestamp: Date;
  parentCommentId?: string;    // Set when this is a reply to another comment, not a top-level comment
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
  // Optional — only IG/Messenger implement it today. Returning [] for all other
  // channels keeps the webhook handler indifferent.
  extractCommentEvents?(payload: any): NormalizedCommentEvent[];
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
  // Private Reply — DM the commenter in response to a public comment.
  // Returns the recipient PSID (Meta exposes it in the response) so the caller
  // can switch to regular sendTextMessage for any subsequent message in the
  // same flow run. Only IG and Messenger implement it. Optional `quickReplies`
  // attaches reply buttons when the first reaction is a Quick Reply node;
  // Meta supports it on the first private reply for both IG and Messenger.
  sendPrivateReply?(
    credentials: ChannelCredentials,
    accountExternalId: string,
    commentId: string,
    text: string,
    quickReplies?: Array<{ id: string; title: string }>
  ): Promise<{ messageId: string | null; recipientPsid: string | null } | null>;
  // Public reply — post a child comment under the original comment, visible to
  // everyone on the post. Distinct from sendPrivateReply: there is no PSID,
  // no DM channel opened, no 24-hour window, and the message is public. IG
  // uses POST /{ig-comment-id}/replies; Messenger uses POST /{comment-id}/comments.
  // Returns the new comment id on success. Only IG and Messenger implement it.
  sendCommentReply?(
    credentials: ChannelCredentials,
    accountExternalId: string,
    commentId: string,
    text: string
  ): Promise<string | null>;
}
