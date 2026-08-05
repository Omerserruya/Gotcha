import { Queue, Worker, Job, WorkerOptions } from "bullmq";
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
    fileName?: string;
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
