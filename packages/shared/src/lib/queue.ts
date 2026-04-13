import { Queue, Worker, Job, WorkerOptions } from "bullmq";

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

// ─── Job types ──────────────────────────────────────────────

export interface IncomingMessageJob {
  tenantId: string;
  channel: "WHATSAPP" | "MESSENGER" | "INSTAGRAM" | "EMAIL" | "GMAIL" | "OUTLOOK" | "SLACK" | "WEBCHAT";
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
  };
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
  // Broadcast linkage — when set, the outgoing worker writes the send result
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
}

export interface ScheduledMessageJob {
  tenantId: string;
  scheduledMessageId: string;
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

  const worker = new Worker<T>(queueName, processor, options);

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
