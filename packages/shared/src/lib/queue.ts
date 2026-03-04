import { Queue, Worker, Job } from "bullmq";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

// ─── Queues ─────────────────────────────────────────────────

export const incomingMessageQueue = new Queue("incoming-messages", { connection: { url: REDIS_URL } });
export const outgoingMessageQueue = new Queue("outgoing-messages", { connection: { url: REDIS_URL } });
export const analyticsQueue = new Queue("analytics-aggregation", { connection: { url: REDIS_URL } });
export const channelHealthQueue = new Queue("channel-health", { connection: { url: REDIS_URL } });
export const idleConversationQueue = new Queue("idle-conversations", { connection: { url: REDIS_URL } });

// ─── Job types ──────────────────────────────────────────────

export interface IncomingMessageJob {
  tenantId: string;
  channel: "WHATSAPP" | "MESSENGER" | "INSTAGRAM" | "EMAIL" | "GMAIL" | "OUTLOOK" | "SLACK";
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
  };
}

export interface OutgoingMessageJob {
  tenantId: string;
  conversationId: string;
  channel: "WHATSAPP" | "MESSENGER" | "INSTAGRAM" | "EMAIL" | "GMAIL" | "OUTLOOK" | "SLACK";
  channelAccountId: string;
  recipientExternalId: string;
  body: string;
  messageType: string;
  senderName: string;
  messageId: string;
  retryCount?: number;
}

export interface AnalyticsJob {
  tenantId: string;
  event: string;
  data: Record<string, any>;
  timestamp: string;
}

// ─── Worker factory ─────────────────────────────────────────

export function createWorker<T>(
  queueName: string,
  processor: (job: Job<T>) => Promise<void>,
  concurrency = 5
): Worker<T> {
  const worker = new Worker<T>(queueName, processor, {
    connection: { url: REDIS_URL },
    concurrency,
  });

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
