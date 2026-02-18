import { Job } from "bullmq";
import axios from "axios";
import { prisma, createWorker, IncomingMessageJob, analyticsQueue, publishEvent } from "@chatcenter/shared";
import { processChatbotFlow } from "../services/chatbot-engine.service";

const FB_API_URL = process.env.FACEBOOK_API_URL || "https://graph.facebook.com/v19.0";

async function fetchMessengerProfile(psid: string, accessToken: string): Promise<string | null> {
  try {
    const res = await axios.get(`${FB_API_URL}/${psid}`, {
      params: { fields: "first_name,last_name", access_token: accessToken },
    });
    const { first_name, last_name } = res.data;
    if (first_name || last_name) {
      return [first_name, last_name].filter(Boolean).join(" ");
    }
    return null;
  } catch (err: any) {
    console.warn(`Failed to fetch Messenger profile for ${psid}:`, err.response?.data?.error?.message || err.message);
    return null;
  }
}

async function processIncomingMessage(job: Job<IncomingMessageJob>): Promise<void> {
  const { tenantId, channel, channelAccountId, normalizedMessage } = job.data;

  // Support legacy job format during migration
  if (!normalizedMessage && job.data.message) {
    return processLegacyMessage(job);
  }

  const {
    externalMessageId,
    senderId,
    senderDisplayName,
    body,
    messageType,
    interactiveReply,
  } = normalizedMessage;

  // Idempotency check
  const existing = await prisma.message.findFirst({
    where: {
      OR: [
        { externalMessageId },
        { waMessageId: externalMessageId }, // legacy compat
      ],
    },
  });
  if (existing) return;

  // Find or create conversation using channel-aware lookup
  let conversation = await prisma.conversation.findFirst({
    where: {
      tenantId,
      channel,
      customerExternalId: senderId,
      status: { not: "CLOSED" },
    },
    orderBy: { createdAt: "desc" },
  });

  // For Messenger, fetch display name from Graph API if not provided
  let displayName = senderDisplayName || null;
  if (!displayName && channel === "MESSENGER" && channelAccountId) {
    const channelAccount = await prisma.channelAccount.findUnique({ where: { id: channelAccountId } });
    const accessToken = (channelAccount?.credentials as any)?.accessToken;
    if (accessToken) {
      displayName = await fetchMessengerProfile(senderId, accessToken);
    }
  }

  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: {
        tenantId,
        channel,
        channelAccountId: channelAccountId || undefined,
        customerExternalId: senderId,
        customerPhone: channel === "WHATSAPP" ? senderId : undefined,
        customerName: displayName,
        status: "OPEN",
      },
    });
  } else if (displayName && !conversation.customerName) {
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { customerName: displayName },
    });
  }

  // Create message record with channel metadata
  const message = await prisma.message.create({
    data: {
      tenantId,
      conversationId: conversation.id,
      channel,
      externalMessageId,
      waMessageId: externalMessageId, // legacy compat
      direction: "INBOUND",
      body,
      messageType,
      senderName: displayName || senderDisplayName,
      status: "DELIVERED",
      metadata: interactiveReply ? { interactiveReply } : undefined,
    },
  });

  // Update conversation timestamp
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: new Date() },
  });

  // Publish real-time events with channel info
  await publishEvent({
    event: "message:new",
    tenantId,
    data: { message, conversationId: conversation.id, channel },
  });
  await publishEvent({
    event: "conversation:updated",
    tenantId,
    data: { ...conversation, channel },
  });

  // Track analytics
  await analyticsQueue.add("message-received", {
    tenantId,
    event: "message_received",
    data: { conversationId: conversation.id, messageId: message.id, channel },
    timestamp: new Date().toISOString(),
  });

  // Process chatbot flow if no agent assigned
  if (!conversation.assignedAgentId && !conversation.isHandedOver) {
    try {
      await processChatbotFlow(tenantId, conversation.id, body);
    } catch (err) {
      console.error("Chatbot flow error:", err);
    }
  }
}

// Legacy message processing for backward compat during migration
async function processLegacyMessage(job: Job<IncomingMessageJob>): Promise<void> {
  const { tenantId, message: msg, contacts } = job.data;
  const from = msg.from;
  const waMessageId = msg.id;
  const contactName = contacts?.[0]?.profile?.name || null;
  const { body, messageType } = extractLegacyMessageBody(msg);

  const existing = await prisma.message.findFirst({ where: { waMessageId } });
  if (existing) return;

  let conversation = await prisma.conversation.findFirst({
    where: { tenantId, customerPhone: from, status: { not: "CLOSED" } },
    orderBy: { createdAt: "desc" },
  });

  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: {
        tenantId,
        channel: "WHATSAPP",
        customerExternalId: from,
        customerPhone: from,
        customerName: contactName,
        status: "OPEN",
      },
    });
  } else if (contactName && !conversation.customerName) {
    await prisma.conversation.update({ where: { id: conversation.id }, data: { customerName: contactName } });
  }

  const message = await prisma.message.create({
    data: {
      tenantId,
      conversationId: conversation.id,
      channel: "WHATSAPP",
      direction: "INBOUND",
      body,
      messageType,
      waMessageId,
      externalMessageId: waMessageId,
      senderName: contactName,
      status: "DELIVERED",
    },
  });

  await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
  await publishEvent({ event: "message:new", tenantId, data: { message, conversationId: conversation.id } });
  await publishEvent({ event: "conversation:updated", tenantId, data: conversation });

  await analyticsQueue.add("message-received", {
    tenantId, event: "message_received",
    data: { conversationId: conversation.id, messageId: message.id },
    timestamp: new Date().toISOString(),
  });

  if (!conversation.assignedAgentId && !conversation.isHandedOver) {
    try { await processChatbotFlow(tenantId, conversation.id, body); } catch (err) { console.error("Chatbot flow error:", err); }
  }
}

function extractLegacyMessageBody(msg: any): { body: string; messageType: string } {
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

let worker: any;
export function startIncomingWorker() {
  worker = createWorker<IncomingMessageJob>("incoming-messages", processIncomingMessage, 3);
  console.log("[incoming-worker] Incoming message worker started");
}
