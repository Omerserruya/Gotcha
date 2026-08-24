import type { EmailThreadContext } from "./email-thread";

// ─── Channel Types & Interfaces ──────────────────────────────

export type ChannelType = "WHATSAPP" | "MESSENGER" | "INSTAGRAM" | "EMAIL" | "GMAIL" | "OUTLOOK" | "SLACK" | "WEBCHAT" | "SHOPIFY_LIVE_CHAT";

export interface NormalizedInboundMessage {
  externalMessageId: string;
  channel: ChannelType;
  senderId: string;           // Phone number (WA) or PSID (Messenger)
  senderDisplayName?: string;
  timestamp: Date;
  content: MessageContent;
  /**
   * The provider's id of the message this one is a reply to, when the customer
   * used the channel's quote affordance.
   *
   * Carried because without it a reply is unreadable. "Yes, that one works"
   * against a list of four dates is a coin flip for a human agent and worse for
   * the AI, which will confidently pick the most recent thing it said. WhatsApp
   * sends it as `context.id`, Meta's other channels as `reply_to.mid`.
   */
  replyToExternalId?: string;
}

export interface MessageContent {
  type: "text" | "image" | "document" | "audio" | "video" | "interactive" | "location" | "contact";
  text?: string;
  /**
   * WhatsApp hands us a media ID to resolve; Meta's other channels hand us a
   * ready CDN URL. Either way this is what the worker turns into a local file.
   */
  mediaUrl?: string;
  caption?: string;
  /**
   * The name the SENDER gave the file, when the channel tells us. Carried
   * separately from `caption` because the download link needs a real name:
   * WhatsApp media is stored under a generated UUID, so without this the
   * agent is offered "9f3c1e....pdf" and cannot tell one attachment from
   * another.
   */
  fileName?: string;
  /** MIME type as reported by the channel, when it reports one. */
  mimeType?: string;
  /**
   * A voice note rather than an attached audio file. Both arrive as `audio`
   * on WhatsApp and differ only by this flag, and they read completely
   * differently in a transcript - one is someone talking to you, the other is
   * a file they forwarded.
   */
  voice?: boolean;
  interactiveReply?: {
    type: "button" | "quick_reply" | "postback";
    payload: string;
    title: string;
  };
  /**
   * A shared contact card. WhatsApp's "send a contact" lands here.
   *
   * Structured rather than flattened into text because the useful thing about
   * a shared contact is that you can act on it: call the number, or open a
   * conversation with it. A customer forwarding their spouse's number so the
   * business can arrange delivery was previously rendered as the dead string
   * "[contacts message]", which loses the entire point of the message.
   */
  contacts?: SharedContact[];
  /**
   * Everything we know about a message the channel could not represent.
   *
   * WhatsApp answers `type: "unsupported"` with an `errors[]` array naming the
   * reason and NO content - and we used to drop that array on the floor, so
   * "why did this arrive empty" had no answer anywhere: not in the logs (the
   * payload log truncates at 500 chars, one field short of `type`), not in the
   * queue (the raw message is normalized before it is enqueued) and not on the
   * row. The provider's own reason is the only evidence that exists; it is
   * kept here and written to the message's metadata.
   */
  unsupported?: {
    /** The provider's own type string, e.g. "unsupported", "revoke", "edit". */
    providerType: string;
    /** Meta's `errors[]`: code, title, message, details. Empty when absent. */
    errors: Array<{ code?: number; title?: string; message?: string; details?: string }>;
    /** The message object as it arrived, minus nothing. Small by definition. */
    raw?: unknown;
  };
}

/** One contact from a shared contact card, reduced to what an agent can use. */
export interface SharedContact {
  name: string;
  phones: Array<{ number: string; type?: string; waId?: string }>;
  emails: Array<{ address: string; type?: string }>;
  organization?: string;
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

/**
 * A message the BUSINESS sent from outside GOTCHA, echoed back to us by the
 * provider. Today this is only WhatsApp Coexistence (`smb_message_echoes`):
 * the owner replies from the WhatsApp Business app on their phone and Meta
 * mirrors that message to our webhook.
 *
 * It is NOT a customer message, so it must never enter the inbound pipeline:
 * no bot turn, no routing, no language detection, no identity-link. It lands
 * as an OUTBOUND row in the thread and, because a human just spoke, it takes
 * the conversation away from the AI.
 *
 * `customerExternalId` is the ECHO's `to` (the customer), not its `from` -
 * that is what makes it addressable to the same conversation as the
 * customer's own inbound messages.
 */
export interface NormalizedOutboundEcho {
  externalMessageId: string;
  channel: ChannelType;
  /** The customer the business wrote to - the conversation key. */
  customerExternalId: string;
  /** The business number the message was sent from. Audit only. */
  businessExternalId?: string;
  timestamp: Date;
  content: MessageContent;
}

// ─── Historical import ───────────────────────────────────────

/**
 * One message inside an imported history chunk.
 *
 * Deliberately NOT `NormalizedInboundMessage`. An inbound message is an event
 * that just happened and carries only a sender; a historical message is a
 * record of something finished and has to carry BOTH ends, because the same
 * chunk contains what the customer wrote and what the business replied. The
 * direction is a property of the row, not of the pipeline that received it.
 */
export interface NormalizedHistoricalMessage {
  externalMessageId: string;
  /** The customer's identifier - the thread key, whichever way the message went. */
  customerExternalId: string;
  direction: "INBOUND" | "OUTBOUND";
  timestamp: Date;
  content: MessageContent;
  /** The source's own delivery status, when it reports one. Audit only. */
  sourceStatus?: string;
}

/**
 * A batch of history as the source delivered it, already normalized.
 *
 * This interface is the seam that keeps the intelligence pipeline free of
 * WhatsApp: everything below it sees threads, messages and a progress number,
 * and nothing below it knows what a WABA is. A second source (Glassix, a CSV)
 * implements `extractHistorySync` and reuses the entire pipeline.
 */
export interface NormalizedHistoryChunk {
  channel: ChannelType;
  /** The account this history belongs to, for tenant + channel resolution. */
  accountExternalId: string;
  /**
   * Meta phase: 0 = day 0-1, 1 = day 1-90, 2 = day 90-180. Sources without a
   * phase concept report 0.
   */
  phase: number;
  /**
   * Sequence number within the transfer. Chunks ARRIVE OUT OF ORDER - Meta
   * documents this - so consumers order by this and never by arrival time.
   */
  chunkOrder: number;
  /** Percentage complete, 0-100. 100 is the only completion signal there is. */
  progress: number;
  messages: NormalizedHistoricalMessage[];
  /** Distinct customers seen in this chunk. */
  threadCount: number;
  /**
   * The source says it cannot provide history at all - typically because the
   * business declined sharing during signup (Meta code 2593109). An honest end
   * state rather than a failure, and reported as such.
   */
  unavailable?: { code?: number; reason: string };
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
  // Optional - only WhatsApp (Coexistence) implements it today. Messages the
  // business sent from a provider-native app, mirrored back to us.
  extractOutboundEchoes?(payload: any): NormalizedOutboundEcho[];
  // Optional - only WhatsApp (Coexistence) implements it today. Batches of the
  // business's PAST conversations, delivered once after onboarding. Data
  // import, never live traffic: nothing extracted here may reach the bot.
  extractHistorySync?(payload: any): NormalizedHistoryChunk[];
}

export interface OutboundAdapter {
  channel: ChannelType;
  sendTextMessage(
    credentials: ChannelCredentials,
    accountExternalId: string,
    recipientId: string,
    text: string,
    /**
     * The provider's id of a message to quote, so the reply renders as a reply
     * on the customer's phone rather than as a loose message.
     *
     * Optional and last so every existing caller and every adapter that does
     * not support quoting is unaffected. An adapter that ignores it still
     * delivers the text, which is the part that matters - a reply that arrives
     * without its quote is a small loss, a reply that fails to send is a real one.
     */
    replyToExternalId?: string,
    /**
     * Email threading. Only the mail adapters read it.
     *
     * Email has no native notion of a conversation, so a reply carrying no
     * In-Reply-To / References / matching Subject arrives in the customer's
     * inbox as an unrelated new message. This is how the inbox tells a mail
     * adapter which thread the agent is answering. Absent means "send a fresh
     * email", which is also the only correct reading for every other channel.
     */
    emailThread?: EmailThreadContext,
  ): Promise<string | null>;
  sendInteractiveMessage(
    credentials: ChannelCredentials,
    accountExternalId: string,
    recipientId: string,
    bodyText: string,
    buttons: Array<{ id: string; title: string }>,
    emailThread?: EmailThreadContext,
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
