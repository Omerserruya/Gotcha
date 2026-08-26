import { Queue, Worker, Job, WorkerOptions } from "bullmq";
import type { EmailThreadContext } from "../channels/email-thread";
import { withCrossTenantAccess } from "./prisma";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

// Per-channel rate limits (messages per second)
export const CHANNEL_RATE_LIMITS: Record<string, { max: number; duration: number }> = {
  WHATSAPP:  { max: 80, duration: 1000 },   // 80 msg/sec (WhatsApp Cloud API limit)
  MESSENGER: { max: 100, duration: 1000 },
  INSTAGRAM: { max: 100, duration: 1000 },
  GMAIL:     { max: 50, duration: 1000 },
  OUTLOOK:   { max: 50, duration: 1000 },
  EMAIL:     { max: 50, duration: 1000 },
  SLACK:     { max: 30, duration: 1000 },
};

// ─── Queues ─────────────────────────────────────────────────

export const incomingMessageQueue = new Queue("incoming-messages", { connection: { url: REDIS_URL } });
export const outgoingMessageQueue = new Queue("outgoing-messages", { connection: { url: REDIS_URL } });
export const analyticsQueue = new Queue("analytics-aggregation", { connection: { url: REDIS_URL } });
export const channelHealthQueue = new Queue("channel-health", { connection: { url: REDIS_URL } });
export const idleConversationQueue = new Queue("idle-conversations", { connection: { url: REDIS_URL } });
export const broadcastQueue = new Queue("broadcast-messages", { connection: { url: REDIS_URL } });
export const scheduledMessageQueue = new Queue("scheduled-messages", { connection: { url: REDIS_URL } });
// Delayed resume for flow Wait nodes. When a flow hits a Wait(5s), the
// walker enqueues a job here with { delay: 5000 } and halts. The worker
// picks it up after the delay and resumes the flow at the next node.
export const flowResumeQueue = new Queue("flow-resume", { connection: { url: REDIS_URL } });
/**
 * The multi-stage analysis of imported conversation history.
 *
 * Its own queue rather than a job name on `incoming-messages`, because the two
 * have opposite shapes: inbound work is thousands of small jobs that must run
 * within seconds, this is a handful of long jobs that run for minutes and call
 * an LLM. Sharing a concurrency budget would let one import's knowledge
 * extraction sit in front of a customer's message.
 *
 * One job per STAGE per import, so a stage that fails can be retried without
 * redoing the ones before it - which matters when the expensive stages are the
 * later ones.
 */
export const historicalIntelligenceQueue = new Queue("historical-intelligence", { connection: { url: REDIS_URL } });

// ─── Job types ──────────────────────────────────────────────

export interface IncomingMessageJob {
  tenantId: string;
  channel: "WHATSAPP" | "MESSENGER" | "INSTAGRAM" | "EMAIL" | "GMAIL" | "OUTLOOK" | "SLACK" | "WEBCHAT" | "SHOPIFY_LIVE_CHAT";
  channelAccountId: string;
  normalizedMessage: {
    externalMessageId: string;
    senderId: string;
    senderDisplayName?: string;
    timestamp: string; // ISO string (serialized for queue)
    contentType: string;
    body: string;
    messageType: string;
    interactiveReply?: {
      type: string;
      payload: string;
      title: string;
    };
    mediaUrl?: string;
    /**
     * The provider's id of the message being replied to, when the customer
     * quoted one. Resolved to a local Message row by the worker; kept even when
     * that resolution misses, because "replying to an earlier message" is still
     * more than nothing.
     */
    replyToExternalId?: string;
    /**
     * Click-to-WhatsApp origin, when this is the first message of a
     * conversation opened from an ad. The worker owns conversation creation,
     * so it has to travel with the job to be recorded at all.
     */
    referral?: {
      sourceType?: string;
      sourceId?: string;
      sourceUrl?: string;
      headline?: string;
      body?: string;
      ctwaClid?: string;
      mediaUrl?: string;
    };
    /**
     * The name the SENDER gave the file. WhatsApp media is stored under a
     * generated UUID, so without this the agent is offered a download called
     * "9f3c1e....pdf" and cannot tell one attachment from another.
     */
    fileName?: string;
    /** MIME type the channel reported, used to pick the saved extension. */
    mimeType?: string;
    /**
     * Extra, already-sanitized context to persist on the created Message
     * row's `metadata`. Producers must put only safe, structured values
     * here - the worker copies it verbatim. Used by Shopify Live Chat to
     * carry the storefront page context the visitor asked from.
     */
    metadata?: Record<string, unknown>;
  };
}

// Comment-trigger job. Shares the "incoming-messages" BullMQ queue with the
// existing message processor (one worker, two job names) - discriminated by
// job.name = "process-comment". Comments are NOT messages: no Conversation
// row, no Message row; they fan out into 0..N flow runs based on which
// comment_trigger nodes target this post.
export interface IncomingCommentJob {
  tenantId: string;
  channel: "MESSENGER" | "INSTAGRAM";
  channelAccountId: string;
  comment: {
    commentId: string;
    postId: string;
    postPermalink?: string;
    text: string;
    fromUserId: string;
    fromUsername?: string;
    timestamp: string; // ISO
    parentCommentId?: string;
  };
}

// A message the BUSINESS sent from a provider-native app, mirrored back to us.
// Today: WhatsApp Coexistence (`smb_message_echoes`) - the owner replied from
// the WhatsApp Business app on their phone. Shares the "incoming-messages"
// queue, discriminated by job.name = "process-echo".
//
// It rides the same queue as customer messages but must never take the same
// path: an echo is OUTBOUND, skips the bot entirely, and pulls the
// conversation away from the AI because a human just spoke in it.
export interface OutboundEchoJob {
  tenantId: string;
  channel: "WHATSAPP";
  channelAccountId: string;
  echo: {
    externalMessageId: string;
    /** The customer that was written TO - the conversation key. */
    customerExternalId: string;
    /** The business number the message came FROM. Audit only. */
    businessExternalId?: string;
    timestamp: string; // ISO
    contentType: string;
    body: string;
    messageType: string;
    /** WhatsApp media ID, resolved to a local file by the worker. */
    mediaUrl?: string;
    /** The name the owner's phone gave the file. */
    fileName?: string;
    /** MIME type the channel reported, used to pick the saved extension. */
    mimeType?: string;
  };
}

// Generic inbound webhook trigger. Shares the "incoming-messages" BullMQ queue
// with the message + comment paths (one worker, discriminated by
// job.name = "webhook-trigger"). Emitted by services/webhook when an
// authenticated POST /webhooks/:token arrives. Carries the caller's raw JSON
// body untouched in `payload` - looking up the customer, running the flow, and
// variable injection all happen downstream (ticket 3), not at ingest.
export interface WebhookTriggerJob {
  triggerId: string;
  workflowId: string;
  tenantId: string;
  payload: unknown;
  // How the inbound call runs (see WebhookTrigger.targetMode):
  //   "flow"      → run the associated ChatbotFlow (`workflowId`).
  //   "connected" → walk the nodes wired to the webhook trigger node on the
  //                 Main Playbook canvas, context-free.
  // Optional + defaults to "flow" downstream so jobs enqueued before this field
  // existed keep the original behavior.
  targetMode?: "flow" | "connected";
}

/**
 * One chunk of imported conversation history. Shares the "incoming-messages"
 * queue, discriminated by job.name = "process-history", exactly as the
 * Coexistence echo does - the webhook stays a thin, fast producer and all the
 * work happens here.
 *
 * The payload carries the chunk ALREADY NORMALIZED by the channel adapter, so
 * the handler below it is source agnostic and a second importer can enqueue the
 * same job shape without the handler learning anything new.
 */
export interface HistoricalImportChunkJob {
  tenantId: string;
  channelAccountId: string;
  /** Matches the HistoricalImportSource enum. */
  source: "WHATSAPP_BUSINESS_APP";
  chunk: {
    phase: number;
    /** Chunks arrive out of order; this is what re-sequences them. */
    chunkOrder: number;
    /** 0-100. 100 is the only completion signal the source gives. */
    progress: number;
    threadCount: number;
    messages: Array<{
      externalMessageId: string;
      customerExternalId: string;
      direction: "INBOUND" | "OUTBOUND";
      timestamp: string; // ISO
      body: string;
      messageType: string;
      mediaUrl?: string;
      fileName?: string;
      mimeType?: string;
      sourceStatus?: string;
    }>;
    /** The source cannot provide history at all (e.g. the business declined). */
    unavailable?: { code?: number; reason: string };
  };
}

/**
 * One STAGE of the intelligence pipeline for one import. Runs on the
 * `historical-intelligence` queue.
 *
 * Stages are separate jobs rather than one long function so that a failure in,
 * say, knowledge extraction is retried on its own instead of re-importing
 * messages and re-running every LLM call that already succeeded.
 */
export interface HistoricalIntelligenceJob {
  tenantId: string;
  importId: string;
  stage:
    | "identity"
    | "customer-learning"
    | "knowledge-extraction"
    | "knowledge-clustering"
    // Merges candidates that are the same question phrased differently.
    // Embeddings cannot do this for Hebrew paraphrase at any threshold.
    | "knowledge-dedupe"
    // Counts how the business actually writes and turns it into prompt guidance.
    // Runs after the knowledge work because it reads the same conversations and
    // a failure here must not cost the expensive stages a retry.
    | "brand-voice"
    | "analytics"
    | "finalize";
  /** Set by the customer-learning stage to process one batch of customers. */
  cursor?: string;
}

export interface OutgoingMessageJob {
  tenantId: string;
  conversationId: string | null;
  channel: "WHATSAPP" | "MESSENGER" | "INSTAGRAM" | "EMAIL" | "GMAIL" | "OUTLOOK" | "SLACK";
  channelAccountId: string;
  recipientExternalId: string;
  body: string;
  messageType: string;
  senderName: string;
  messageId: string;
  retryCount?: number;
  /**
   * The PROVIDER's id of the message being replied to. Carried separately from
   * our own id because this is what the channel API needs: WhatsApp takes it as
   * `context.message_id` and renders the quote on the customer's phone.
   * Undefined for a normal send.
   */
  replyToExternalId?: string;
  /**
   * Email threading for this send.
   *
   * Present when the agent is answering an existing email thread, absent when
   * they deliberately chose to start a new one. Resolved by the producer rather
   * than the worker because only the producer knows which conversation the
   * agent was looking at and which button they pressed.
   */
  emailThread?: EmailThreadContext;
  /**
   * Email only. "new" makes the send start a fresh thread; anything else (the
   * default) continues the conversation's existing one.
   *
   * The default matters more than the option: every producer that never heard
   * of email threading - the bot, flows, approvals, scheduled sends - reaches
   * the worker with this unset, and unset has to mean "reply properly".
   */
  emailReplyMode?: "reply" | "new";
  mediaUrl?: string;
  fileName?: string;
  // Broadcast linkage - when set, the outgoing worker writes the send result
  // back to the BroadcastRecipient row and updates broadcast counters.
  broadcastId?: string;
  broadcastRecipientId?: string;
  // Template fields (forwarded by broadcast worker)
  templateName?: string;
  templateLanguage?: string;
  templateComponents?: any[];
}

export interface AnalyticsJob {
  tenantId: string;
  event: string;
  data: Record<string, any>;
  timestamp: string;
}

export interface BroadcastJob {
  tenantId: string;
  broadcastId: string;
  channel: "WHATSAPP" | "MESSENGER" | "INSTAGRAM" | "EMAIL" | "GMAIL" | "OUTLOOK" | "SLACK";
  channelAccountId: string;
  recipientExternalId: string;
  recipientId: string; // BroadcastRecipient ID
  body: string;
  messageType: string;
  templateId?: string;
  variables?: Record<string, string>;
  // Per-campaign override for IMAGE/VIDEO/DOCUMENT WhatsApp template
  // headers. When set, worker uses this URL as the live header instead
  // of the template's example URL.
  headerMediaUrl?: string;
}

export interface ScheduledMessageJob {
  tenantId: string;
  scheduledMessageId: string;
}

export interface FlowResumeJob {
  tenantId: string;
  conversationId: string;
  // "main" | ChatbotFlow.id - which graph to resume
  flowKind: "main" | "sub";
  flowId?: string;
  // Node to resume AT - the walker restarts from here
  resumeNodeId: string;
  // Inbound channel (used to pick adapter / channel_entry when re-entering)
  channel: string;
  // Message to carry through on resume (usually empty for a Wait resume)
  message: string;
}

// ─── Worker factory ─────────────────────────────────────────

export function createWorker<T>(
  queueName: string,
  processor: (job: Job<T>) => Promise<void>,
  concurrencyOrOptions: number | Partial<WorkerOptions> = 5
): Worker<T> {
  const baseOptions: WorkerOptions = { connection: { url: REDIS_URL }, concurrency: 5 };
  const options: WorkerOptions =
    typeof concurrencyOrOptions === "number"
      ? { ...baseOptions, concurrency: concurrencyOrOptions }
      : { ...baseOptions, ...concurrencyOrOptions };

  // Every worker legitimately operates across tenants (polling due
  // scheduled messages, idle conversations, channel health, etc). Wrap
  // each job in `withCrossTenantAccess` so the Prisma tenant-guard is
  // disabled for background worker work - the work is trusted,
  // tenant-scoped at the data level, and has no user to derive tenant
  // context from. Individual job processors are still responsible for
  // passing the correct tenantId when writing rows.
  const wrappedProcessor = (job: Job<T>): Promise<void> =>
    withCrossTenantAccess(() => processor(job));

  const worker = new Worker<T>(queueName, wrappedProcessor, options);

  worker.on("failed", (job, err) => {
    console.error(`Job ${job?.id} in ${queueName} failed:`, err.message);
  });

  worker.on("completed", (job) => {
    if (process.env.NODE_ENV === "development") {
      console.log(`Job ${job.id} in ${queueName} completed`);
    }
  });

  return worker;
}
