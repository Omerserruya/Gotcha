import { Job } from "bullmq";
import axios from "axios";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { prisma, createWorker, IncomingMessageJob, analyticsQueue, outgoingMessageQueue, publishEvent, decryptCredentials } from "@chatcenter/shared";

const FB_API_URL = process.env.FACEBOOK_API_URL || "https://graph.facebook.com/v19.0";
const WA_API_URL = process.env.WHATSAPP_API_URL || "https://graph.facebook.com/v19.0";
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.resolve(process.cwd(), "uploads");
const UPLOADS_BASE_URL = process.env.UPLOADS_BASE_URL || "/api/uploads";

// Unsupported media types that trigger an auto-reply
const UNSUPPORTED_MEDIA_TYPES = ["audio", "location"];

// Ensure uploads dir exists
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

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

/**
 * Resolve a WhatsApp media ID to a local file URL.
 * 1. GET /{media_id} → { url } (temporary CDN URL)
 * 2. Download the file from CDN with auth header
 * 3. Save to local uploads directory
 * 4. Return local URL path
 */
async function resolveWhatsAppMedia(mediaId: string, accessToken: string, messageType: string): Promise<{ localUrl: string; fileName: string } | null> {
  try {
    // Step 1: Get the CDN download URL
    const metaRes = await axios.get(`${WA_API_URL}/${mediaId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const cdnUrl = metaRes.data?.url;
    if (!cdnUrl) return null;

    // Step 2: Download the file
    const fileRes = await axios.get(cdnUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
      responseType: "arraybuffer",
    });

    // Determine file extension from content-type
    const contentType = fileRes.headers["content-type"] || "";
    const ext = getExtensionFromMime(contentType, messageType);
    const fileName = `${crypto.randomUUID()}${ext}`;
    const filePath = path.join(UPLOADS_DIR, fileName);

    // Step 3: Save to disk
    fs.writeFileSync(filePath, fileRes.data);

    return { localUrl: `${UPLOADS_BASE_URL}/${fileName}`, fileName };
  } catch (err: any) {
    console.error(`[incoming-worker] Failed to resolve WhatsApp media ${mediaId}:`, err.message);
    return null;
  }
}

function getExtensionFromMime(contentType: string, messageType: string): string {
  const mimeMap: Record<string, string> = {
    "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp",
    "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov",
    "audio/ogg": ".ogg", "audio/mpeg": ".mp3", "audio/aac": ".aac",
    "application/pdf": ".pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/zip": ".zip",
  };
  if (mimeMap[contentType]) return mimeMap[contentType];
  // Fallback based on message type
  switch (messageType) {
    case "image": return ".jpg";
    case "video": return ".mp4";
    case "audio": return ".ogg";
    case "document": return ".pdf";
    default: return ".bin";
  }
}

async function processIncomingMessage(job: Job<IncomingMessageJob>): Promise<void> {
  const { tenantId, channel, channelAccountId, normalizedMessage } = job.data;

  // Block message processing for non-active tenants
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { status: true },
  });
  if (!tenant || tenant.status !== "ACTIVE") {
    console.log(`[incoming-worker] Skipping message for non-active tenant ${tenantId} (status: ${tenant?.status})`);
    return;
  }

  const {
    externalMessageId,
    senderId,
    senderDisplayName,
    body,
    messageType,
    interactiveReply,
    mediaUrl: rawMediaUrl,
  } = normalizedMessage;

  // Idempotency check
  const existing = await prisma.message.findFirst({
    where: { externalMessageId },
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
  if (!displayName && !conversation?.customerName && (channel === "MESSENGER" || channel === "INSTAGRAM") && channelAccountId) {
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

  // Resolve media URL (download WhatsApp media, pass through Messenger/Instagram URLs)
  let resolvedMediaUrl: string | undefined;
  let resolvedFileName: string | undefined;
  if (rawMediaUrl) {
    if (channel === "WHATSAPP") {
      // WhatsApp gives us a media ID, not a URL - resolve and download it
      const channelAccount = await prisma.channelAccount.findUnique({ where: { id: channelAccountId } });
      const creds = channelAccount?.credentials;
      const decrypted = typeof creds === "string" ? decryptCredentials(creds) : (creds as any);
      if (decrypted?.accessToken) {
        const resolved = await resolveWhatsAppMedia(rawMediaUrl, decrypted.accessToken, messageType);
        if (resolved) {
          resolvedMediaUrl = resolved.localUrl;
          resolvedFileName = resolved.fileName;
        }
      }
    } else {
      // Messenger/Instagram: URL is directly usable
      resolvedMediaUrl = rawMediaUrl;
    }
  }

  // Create message record with channel metadata
  const message = await prisma.message.create({
    data: {
      tenantId,
      conversationId: conversation.id,
      channel,
      externalMessageId,
      direction: "INBOUND",
      body,
      messageType,
      senderName: displayName || senderDisplayName,
      status: "DELIVERED",
      metadata: interactiveReply ? { interactiveReply } : undefined,
      mediaUrl: resolvedMediaUrl,
      fileName: resolvedFileName,
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

  // Auto-reply for unsupported media types
  if (UNSUPPORTED_MEDIA_TYPES.includes(messageType) && channelAccountId) {
    try {
      const autoReplyBody = "We currently don't support this type of media. Please send text, images, or documents instead.";
      const autoReplyMsg = await prisma.message.create({
        data: {
          tenantId,
          conversationId: conversation.id,
          channel,
          direction: "OUTBOUND",
          body: autoReplyBody,
          messageType: "text",
          senderName: "System",
          status: "PENDING",
        },
      });

      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: new Date() },
      });

      await outgoingMessageQueue.add("send", {
        tenantId,
        conversationId: conversation.id,
        channel,
        channelAccountId,
        recipientExternalId: senderId,
        body: autoReplyBody,
        messageType: "text",
        senderName: "System",
        messageId: autoReplyMsg.id,
      }, { attempts: 3, backoff: { type: "exponential", delay: 1000 } });

      await publishEvent({
        event: "message:new",
        tenantId,
        data: { message: autoReplyMsg, conversationId: conversation.id },
      });
    } catch (err) {
      console.error("[incoming-worker] Failed to send unsupported media auto-reply:", err);
    }
    return; // Skip bot processing for unsupported media
  }

  // Process bot if no agent assigned
  if (!conversation.assignedAgentId && !conversation.isHandedOver) {
    try {
      // Check if this is a new conversation needing routing
      const messageCount = await prisma.message.count({ where: { conversationId: conversation.id } });

      if (messageCount <= 1 && !conversation.departmentId) {
        // New conversation - route via playbook rules
        const { routeConversation } = await import("../services/routing.service");
        const routing = await routeConversation(tenantId, conversation.id, body, channel);

        if (routing.handledByAI) {
          // AI agent or chatbot flow handled it inside routeConversation
          return;
        }
        if (routing.departmentId) {
          // Routed to department, conversation is WAITING for human
          return;
        }
        // No rule matched — conversation stays in inbox for manual pickup
      }
    } catch (err) {
      console.error("Bot processing error:", err);
    }
  }
}

let worker: any;
export function startIncomingWorker() {
  worker = createWorker<IncomingMessageJob>("incoming-messages", processIncomingMessage, 3);
  console.log("[incoming-worker] Incoming message worker started");
}
