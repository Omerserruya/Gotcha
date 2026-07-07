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
  // Structured provider failure detail for FAILED deliveries. `errorMessage`
  // stays for back-compat (human string); `error` carries the full breakdown
  // so a failed send is diagnosable from the DB/UI without server logs.
  error?: ProviderSendError;
}

/**
 * Full, structured provider send/delivery failure. Every field a provider hands
 * us is preserved so a failed message can be diagnosed end-to-end from the
 * database and Inbox UI alone - no log-diving, no reproduction.
 *
 * Shape is provider-neutral; `channel` + `raw` let a specific channel's quirks
 * survive. For WhatsApp/Meta these map to the Graph API error object
 * (`error.code`, `error.error_subcode`, `error.type`, `error.error_data.details`,
 * `error.fbtrace_id`) plus the HTTP status and `x-fb-request-id` header.
 */
export interface ProviderSendError {
  channel: ChannelType;
  phase: "send" | "delivery";   // synchronous send-time vs async delivery webhook
  httpStatus?: number;          // HTTP status of the provider response
  code?: number;                // provider error code (Meta error.code)
  subcode?: number;             // provider error subcode (Meta error.error_subcode)
  type?: string;                // provider error type (e.g. "OAuthException")
  message: string;              // best human-readable summary
  detail?: string;              // extra detail (error_data.details / error_user_msg)
  fbtraceId?: string;           // Meta fbtrace_id - quote to Meta support
  requestId?: string;           // provider request id (x-fb-request-id header)
  retryable: boolean;           // whether a retry could plausibly succeed
  at: string;                   // ISO timestamp the failure was captured
  raw?: unknown;                // trimmed original error payload for deep debug
}

/**
 * Error thrown by outbound adapters on a send failure. Carries the full
 * `ProviderSendError` so callers persist structure (not just `.message`).
 * `err.message` remains the human summary for back-compat with existing
 * `err?.message` logging.
 */
export class ChannelSendError extends Error {
  readonly provider: ProviderSendError;
  constructor(provider: ProviderSendError) {
    super(provider.message);
    this.name = "ChannelSendError";
    this.provider = provider;
    // Restore prototype chain when compiled down to ES5.
    Object.setPrototypeOf(this, ChannelSendError.prototype);
  }
}

/**
 * Normalize ANY thrown send error into a persistable shape. Callers use this in
 * their catch blocks so every FAILED outbound row gets both a human
 * `errorMessage` and structured `metadata.sendError`, regardless of whether the
 * adapter threw a rich `ChannelSendError` or a bare `Error`.
 */
export function describeSendError(
  err: unknown,
  fallbackChannel?: ChannelType,
): { errorMessage: string; sendError: ProviderSendError } {
  if (err instanceof ChannelSendError) {
    return { errorMessage: err.provider.message, sendError: err.provider };
  }
  const anyErr = err as any;
  const message =
    (typeof anyErr?.message === "string" && anyErr.message) ||
    String(err ?? "Send failed");
  return {
    errorMessage: message,
    sendError: {
      channel: (fallbackChannel ?? "WHATSAPP") as ChannelType,
      phase: "send",
      code: typeof anyErr?.code === "number" ? anyErr.code : undefined,
      httpStatus: typeof anyErr?.response?.status === "number" ? anyErr.response.status : undefined,
      message,
      retryable: false,
      at: new Date().toISOString(),
      raw: anyErr?.code && typeof anyErr.code === "string" ? { code: anyErr.code } : undefined,
    },
  };
}

// Public comment event normalized across IG (entry.changes[].field === "comments")
// and FB Messenger feed comments (entry.changes[].field === "feed", value.item === "comment").
// Used by the Comment Trigger pipeline; not a message and never written to the
// Message table - comments don't fit a 1:1 conversation model.
export interface NormalizedCommentEvent {
  channel: ChannelType;
  commentId: string;          // Comment node ID - passed to Private Reply API as recipient.comment_id
  postId: string;              // Parent post / media ID - what flow authors match against in CommentTrigger.data.postId
  postPermalink?: string;
  text: string;
  fromUserId: string;          // IGSID for IG / FB User ID for Messenger - informational only; cannot be used as messaging recipient (see Private Reply rationale)
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
  // Optional - only IG/Messenger implement it today. Returning [] for all other
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
  // Private Reply - DM the commenter in response to a public comment.
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
  // Public reply - post a child comment under the original comment, visible to
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
