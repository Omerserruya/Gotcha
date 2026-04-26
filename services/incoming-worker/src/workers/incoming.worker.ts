import { Job } from "bullmq";
import axios from "axios";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { prisma, createWorker, IncomingMessageJob, IncomingCommentJob, analyticsQueue, outgoingMessageQueue, publishEvent, decryptCredentials } from "@chatcenter/shared";
import { processCommentTrigger } from "../services/comment-trigger.service";

const FB_API_URL = process.env.FACEBOOK_API_URL || "https://graph.facebook.com/v19.0";
const WA_API_URL = process.env.WHATSAPP_API_URL || "https://graph.facebook.com/v19.0";
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.resolve(process.cwd(), "uploads");
const UPLOADS_BASE_URL = process.env.UPLOADS_BASE_URL || "/api/uploads";

// Unsupported media types that trigger an auto-reply
const UNSUPPORTED_MEDIA_TYPES = ["audio", "location"];

// Ensure uploads dir exists
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

async function fetchMetaProfile(senderId: string, accessToken: string, channel: string, pageId?: string): Promise<{ name: string | null; avatarUrl: string | null }> {
  let name: string | null = null;
  let avatarUrl: string | null = null;

  // Try direct profile lookup first
  try {
    // Instagram IGSID uses "profile_pic", Messenger uses "picture.type(large)"
    const fields = channel === "INSTAGRAM"
      ? "name,username,profile_pic"
      : "first_name,last_name,name,picture.type(large)";
    const res = await axios.get(`${FB_API_URL}/${senderId}`, {
      params: { fields, access_token: accessToken },
    });
    if (channel === "INSTAGRAM") {
      name = res.data.name || res.data.username || null;
      avatarUrl = res.data.profile_pic || null;
    } else {
      const { first_name, last_name, name: fullName, picture } = res.data;
      if (first_name || last_name) name = [first_name, last_name].filter(Boolean).join(" ");
      else if (fullName) name = fullName;
      avatarUrl = picture?.data?.url || null;
    }
  } catch (err: any) {
    console.warn(`[PROFILE] Direct lookup failed for ${senderId}:`, err.response?.data?.error?.message || err.message);
  }

  // Fallback for Messenger: use Conversations API to get participant name
  if (!name && channel === "MESSENGER" && pageId) {
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
        name = sender.name;
      }
    } catch (convErr: any) {
      console.warn(`[PROFILE] Conversations API fallback failed:`, convErr.response?.data?.error?.message || convErr.message);
    }
  }

  return { name, avatarUrl };
}

/**
 * Fetch WhatsApp contact profile picture via Cloud API contacts endpoint.
 * Uses POST /{phone_number_id}/contacts to retrieve profile info.
 */
async function fetchWhatsAppAvatar(phoneNumberId: string, contactWaId: string, accessToken: string): Promise<string | null> {
  try {
    const res = await axios.post(
      `${WA_API_URL}/${phoneNumberId}/contacts`,
      { blocking: "wait", contacts: [`+${contactWaId}`] },
      { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } },
    );
    const contact = res.data?.contacts?.[0];
    if (contact?.status === "valid" && contact?.profile?.photo) {
      return contact.profile.photo;
    }
    return null;
  } catch {
    // Profile picture not available (privacy settings) — silent fail
    return null;
  }
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

  // Find or create conversation using channel-aware lookup.
  // A closed conversation stays closed — the next inbound from the same
  // customer starts a brand-new conversation. Reopening leaks stale state
  // (assignment, handoff, chatbot flow, escalation clock) and causes the
  // customer to hit whatever the previous session's terminal state was
  // instead of being routed fresh.
  let conversation = await prisma.conversation.findFirst({
    where: {
      tenantId,
      channel,
      customerExternalId: senderId,
      status: { not: "CLOSED" },
    },
    orderBy: { createdAt: "desc" },
  });

  // Fall back to the saved Contact's display name + avatar so replies don't
  // surface as raw phone numbers when the channel webhook omits the profile.
  // Use the resolver so merged-away contacts route to their surviving
  // target (personId) instead of presenting as a fresh row. Without this,
  // a merged WhatsApp contact would miss the direct lookup and downstream
  // code would see null, losing displayName/avatar continuity.
  const { resolveContactByChannelId } = await import("@chatcenter/shared");
  const savedContact = await resolveContactByChannelId(tenantId, channel, senderId);

  // For Messenger/Instagram, fetch display name + avatar from Graph API if not provided
  let displayName = senderDisplayName || savedContact?.displayName || null;
  let avatarUrl: string | null = savedContact?.avatarUrl || null;
  if ((!displayName || !conversation?.customerAvatarUrl) && (channel === "MESSENGER" || channel === "INSTAGRAM") && channelAccountId) {
    const channelAccount = await prisma.channelAccount.findUnique({ where: { id: channelAccountId } });
    const creds = channelAccount?.credentials;
    const decrypted = typeof creds === "string" ? decryptCredentials(creds) : (creds as any);
    const accessToken = decrypted?.accessToken;
    const pageId = decrypted?.pageId || channelAccount?.externalId;
    if (accessToken) {
      const profile = await fetchMetaProfile(senderId, accessToken, channel, pageId);
      if (!displayName) displayName = profile.name;
      avatarUrl = profile.avatarUrl;
    }
  }

  // For WhatsApp, try fetching profile picture
  if (!conversation?.customerAvatarUrl && channel === "WHATSAPP" && channelAccountId) {
    try {
      const channelAccount = await prisma.channelAccount.findUnique({ where: { id: channelAccountId } });
      const creds = channelAccount?.credentials;
      const decrypted = typeof creds === "string" ? decryptCredentials(creds) : (creds as any);
      const accessToken = decrypted?.accessToken;
      const phoneNumberId = channelAccount?.externalId;
      if (accessToken && phoneNumberId) {
        avatarUrl = await fetchWhatsAppAvatar(phoneNumberId, senderId, accessToken);
      }
    } catch { /* silent */ }
  }

  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: {
        tenantId,
        channel,
        channelAccountId: channelAccountId || undefined,
        customerExternalId: senderId,
        customerName: displayName,
        customerAvatarUrl: avatarUrl || undefined,
        status: "OPEN",
      },
    });
  } else {
    const updates: any = {};
    if (displayName && !conversation.customerName) updates.customerName = displayName;
    if (avatarUrl && !conversation.customerAvatarUrl) updates.customerAvatarUrl = avatarUrl;
    if (Object.keys(updates).length > 0) {
      await prisma.conversation.update({ where: { id: conversation.id }, data: updates });
    }
  }

  // Also update Contact avatarUrl if we got one. Target the resolved
  // contact's id so a merged-away row doesn't receive the write (and so
  // avatars keep updating on the surviving target).
  if (avatarUrl && savedContact && !savedContact.avatarUrl) {
    await prisma.contact.update({
      where: { id: savedContact.id },
      data: { avatarUrl },
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
      } else if ((conversation as any).handledBy === "ai_agent") {
        // Ongoing AI conversation — continue processing with AI bot
        const { processAIBot } = await import("../services/ai-bot.service");
        await processAIBot(tenantId, conversation.id, body);
        return;
      } else if ((conversation as any).chatbotFlowId) {
        // Ongoing chatbot flow — continue processing
        const { processChatbotFlow } = await import("../services/chatbot-engine.service");
        await processChatbotFlow(tenantId, conversation.id, body);
        return;
      }
    } catch (err) {
      console.error("Bot processing error:", err);
    }
  }
}

// Dispatcher: same queue, two job names. Keeps DM and comment-trigger
// processing in one worker process — same Redis connection, same DLQ, same
// concurrency budget — but each job kind has its own handler.
async function dispatch(job: Job<IncomingMessageJob | IncomingCommentJob>): Promise<void> {
  if (job.name === "process-comment") {
    await processCommentTrigger(job as Job<IncomingCommentJob>);
    return;
  }
  // Default ("process") — DM / message path.
  await processIncomingMessage(job as Job<IncomingMessageJob>);
}

let worker: any;
export function startIncomingWorker() {
  worker = createWorker<IncomingMessageJob | IncomingCommentJob>("incoming-messages", dispatch, 3);
  console.log("[incoming-worker] Incoming message worker started (handles: process, process-comment)");
}
