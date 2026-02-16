import { Job } from "bullmq";
import { prisma, createWorker, IncomingMessageJob, analyticsQueue, publishEvent } from "@chatcenter/shared";
import { processChatbotFlow } from "../services/chatbot-engine.service";

function extractMessageBody(msg: any): { body: string; messageType: string } {
  const messageType = msg.type || "text";
  let body = "";
  switch (msg.type) {
    case "text": body = msg.text?.body || ""; break;
    case "interactive": body = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || ""; break;
    case "image": body = msg.image?.caption || "[Image]"; break;
    case "document": body = msg.document?.caption || "[Document]"; break;
    case "audio": body = "[Audio message]"; break;
    case "video": body = msg.video?.caption || "[Video]"; break;
    default: body = `[${msg.type || "unknown"} message]`;
  }
  return { body, messageType };
}

async function processIncomingMessage(job: Job<IncomingMessageJob>): Promise<void> {
  const { tenantId, message: msg, contacts } = job.data;
  const from = msg.from;
  const waMessageId = msg.id;
  const contactName = contacts?.[0]?.profile?.name || null;
  const { body, messageType } = extractMessageBody(msg);

  // Idempotency check
  const existing = await prisma.message.findFirst({ where: { waMessageId } });
  if (existing) return;

  // Find or create conversation
  let conversation = await prisma.conversation.findFirst({
    where: { tenantId, customerPhone: from, status: { not: "CLOSED" } },
    orderBy: { createdAt: "desc" },
  });

  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: { tenantId, customerPhone: from, customerName: contactName, status: "OPEN" },
    });
  } else if (contactName && !conversation.customerName) {
    await prisma.conversation.update({ where: { id: conversation.id }, data: { customerName: contactName } });
  }

  // Create message record
  const message = await prisma.message.create({
    data: { tenantId, conversationId: conversation.id, direction: "INBOUND", body, messageType, waMessageId, senderName: contactName, status: "DELIVERED" },
  });

  // Update conversation timestamp
  await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });

  // Publish real-time event via event bus (conversation-service will relay to Socket.IO)
  await publishEvent({ event: "message:new", tenantId, data: { message, conversationId: conversation.id } });
  await publishEvent({ event: "conversation:updated", tenantId, data: conversation });

  // Track analytics
  await analyticsQueue.add("message-received", {
    tenantId, event: "message_received",
    data: { conversationId: conversation.id, messageId: message.id },
    timestamp: new Date().toISOString(),
  });

  // Process chatbot flow if no agent assigned
  if (!conversation.assignedAgentId && !conversation.isHandedOver) {
    try { await processChatbotFlow(tenantId, conversation.id, body); } catch (err) { console.error("Chatbot flow error:", err); }
  }
}

let worker: any;
export function startIncomingWorker() {
  worker = createWorker<IncomingMessageJob>("incoming-messages", processIncomingMessage, 3);
  console.log("[incoming-worker] Incoming message worker started");
}
