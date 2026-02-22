import { Job } from "bullmq";
import axios from "axios";
import { prisma, createWorker, IncomingMessageJob, analyticsQueue, publishEvent, decryptCredentials } from "@chatcenter/shared";
import { processChatbotFlow } from "../services/chatbot-engine.service";

const FB_API_URL = process.env.FACEBOOK_API_URL || "https://graph.facebook.com/v19.0";

async function fetchMetaProfile(senderId: string, accessToken: string, channel: string, pageId?: string): Promise<string | null> {
  // Try direct profile lookup first
  try {
    const fields = channel === "INSTAGRAM" ? "name,username" : "first_name,last_name,name";
    const res = await axios.get(`${FB_API_URL}/${senderId}`, {
      params: { fields, access_token: accessToken },
    });
    if (channel === "INSTAGRAM") {
      return res.data.name || res.data.username || null;
    }
    const { first_name, last_name, name } = res.data;
    if (first_name || last_name) return [first_name, last_name].filter(Boolean).join(" ");
    if (name) return name;
  } catch (err: any) {
    console.warn(`[PROFILE] Direct lookup failed for ${senderId}:`, err.response?.data?.error?.message || err.message);
  }

  // Fallback for Messenger: use Conversations API to get participant name
  if (channel === "MESSENGER" && pageId) {
    try {
      const res = await axios.get(`${FB_API_URL}/${pageId}/conversations`, {
        params: {
          platform: "messenger",
          user_id: senderId,
          fields: "participants",
          access_token: accessToken,
        },
      });
      const participants = res.data?.data?.[0]?.participants?.data || [];
      const sender = participants.find((p: any) => p.id === senderId);
      if (sender?.name) {
        console.log(`[PROFILE] Messenger name via conversations API: ${sender.name}`);
        return sender.name;
      }
    } catch (convErr: any) {
      console.warn(`[PROFILE] Conversations API fallback failed:`, convErr.response?.data?.error?.message || convErr.message);
    }
  }

  return null;
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

  // For Messenger/Instagram, fetch display name from Graph API if not provided
  let displayName = senderDisplayName || null;
  if (!displayName && (channel === "MESSENGER" || channel === "INSTAGRAM") && channelAccountId) {
    const channelAccount = await prisma.channelAccount.findUnique({ where: { id: channelAccountId } });
    const creds = channelAccount?.credentials;
    const decrypted = typeof creds === "string" ? decryptCredentials(creds) : (creds as any);
    const accessToken = decrypted?.accessToken;
    const pageId = decrypted?.pageId || channelAccount?.externalId;
    if (accessToken) {
      displayName = await fetchMetaProfile(senderId, accessToken, channel, pageId);
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
