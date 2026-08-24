import { Router, Request, Response } from "express";
import { z } from "zod";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { prisma, authenticate, resolveTenant, validate, outgoingMessageQueue, decryptCredentials, requireActiveTenant,
  type EmailThreadContext,
} from "@chatcenter/shared";
import * as messageService from "../services/message.service";

const router = Router();
router.use(authenticate, resolveTenant, requireActiveTenant());

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.resolve(process.cwd(), "uploads");
const UPLOADS_BASE_URL = process.env.UPLOADS_BASE_URL || "/api/uploads";
const MAX_FILE_SIZE = 16 * 1024 * 1024; // 16MB

// Ensure uploads dir exists
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const sendMessageSchema = z.object({
  body: z.string().min(1),
  messageType: z.string().optional(),
  /**
   * The message being quoted.
   *
   * Declared here because `validate` reassigns `req.body` to the PARSED value
   * and Zod strips keys the schema does not name. Without this line the handler
   * below read `req.body.replyToMessageId` off an object it had already been
   * removed from, so every quoted reply from the inbox was silently sent as a
   * plain message. The resolution code was correct; it was never reached.
   */
  replyToMessageId: z.string().optional(),
  /**
   * Email only. "reply" (the default) continues the customer's existing mail
   * thread; "new" deliberately starts a fresh one.
   *
   * Defaulting to "reply" is the whole point: an agent answering from the inbox
   * is answering something, and a mail client that cannot see that puts the
   * answer in a separate message the customer has to connect by hand.
   */
  emailReplyMode: z.enum(["reply", "new"]).optional(),
  /** Subject for a deliberately new email thread. Ignored when replying. */
  subject: z.string().max(200).optional(),
});

/** Channels where a send is an email and therefore needs threading. */
const EMAIL_CHANNELS = new Set(["GMAIL", "OUTLOOK", "EMAIL"]);

router.get("/:conversationId/messages", async (req: Request, res: Response) => {
  try {
    const { page, limit } = req.query;
    const result = await messageService.listByConversation(
      req.tenantId!, req.params.conversationId as string,
      { page: page ? parseInt(page as string, 10) : undefined, limit: limit ? parseInt(limit as string, 10) : undefined }
    );
    res.json(result);
  } catch (err) {
    console.error("List messages error:", err);
    res.status(500).json({ error: "Failed to list messages" });
  }
});

router.post("/:conversationId/messages", validate(sendMessageSchema), async (req: Request, res: Response) => {
  try {
    const conversationId = req.params.conversationId as string;
    const { body, messageType, emailReplyMode, subject } = req.body;
    // The message the agent is replying to, if any. Validated below against
    // this conversation: a reply must quote something in the thread it is sent
    // to, or WhatsApp rejects the send and the agent gets a failure they cannot
    // explain.
    const replyToMessageId: string | undefined =
      typeof req.body?.replyToMessageId === "string" && req.body.replyToMessageId
        ? req.body.replyToMessageId
        : undefined;

    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, tenantId: req.tenantId! },
      include: { channelAccount: true },
    });
    if (!conversation) { res.status(404).json({ error: "Conversation not found" }); return; }

    const channel = conversation.channel || "WHATSAPP";
    const recipientId = conversation.customerExternalId;

    // Resolve the quote before anything is sent.
    //
    // Scoped to this conversation and this tenant, so a stale or hand-crafted
    // id cannot make GOTCHA quote another customer's message into this thread.
    // A quoted message with no provider id (a webchat row, or one that never
    // reached the channel) can still be shown locally but cannot be quoted at
    // the provider, so the reply is sent as a normal message rather than
    // failing - the agent's words matter more than the quote decoration.
    let quoted: { id: string; externalMessageId: string | null } | null = null;
    if (replyToMessageId) {
      quoted = await prisma.message.findFirst({
        where: { id: replyToMessageId, tenantId: req.tenantId!, conversationId },
        select: { id: true, externalMessageId: true },
      });
      if (!quoted) {
        res.status(400).json({ error: "The message you are replying to is not in this conversation" });
        return;
      }
    }

    if (!conversation.channelAccount) {
      res.status(400).json({ error: "Channel not configured for this tenant" }); return;
    }

    // Browser-delivered channels: there is no external API to call. The
    // message row IS the delivery - the widget receives it over the
    // visitor socket and re-reads it on reconnect. Enqueuing an outbound
    // send here would only produce a no-op job and a misleading PENDING.
    if (channel === "WEBCHAT" || channel === "SHOPIFY_LIVE_CHAT") {
      const message = await messageService.create({
        tenantId: req.tenantId!,
        conversationId,
        direction: "OUTBOUND",
        body,
        messageType,
        channel,
        senderName: req.user!.email,
        replyToMessageId: quoted?.id,
      });

      await prisma.conversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: new Date(), updatedAt: new Date() },
      });

      const io = (req as any).io;
      if (io) {
        io.to(`tenant:${req.tenantId}`).emit("message:new", {
          conversationId,
          message,
        });
      }

      res.status(201).json({ data: message });
      return;
    }

    const rawCreds = conversation.channelAccount.credentials;
    const creds = typeof rawCreds === "string" ? decryptCredentials(rawCreds) : (rawCreds as any);
    if (!creds?.accessToken) {
      res.status(400).json({ error: "Channel not configured for this tenant" }); return;
    }

    // ── Email threading ──
    //
    // The route carries the agent's CHOICE; the outgoing worker does the
    // resolution. Keeping it there means the bot, flows, approvals and
    // scheduled sends thread correctly too, without every producer having to
    // learn what a References header is.
    //
    // A deliberately new thread is the only case that needs anything here: its
    // subject is the agent's, and it must carry no In-Reply-To, no References
    // and no thread id, because those are exactly what would drag it back into
    // the conversation they chose to leave.
    const isEmail = EMAIL_CHANNELS.has(channel);
    const startsNewThread = isEmail && emailReplyMode === "new";
    const emailThread: EmailThreadContext | undefined =
      startsNewThread && subject ? { subject } : undefined;

    const message = await messageService.create({
      tenantId: req.tenantId!,
      conversationId,
      direction: "OUTBOUND",
      body,
      messageType,
      senderName: req.user!.email,
      replyToMessageId: quoted?.id,
      // Recorded on our side too, so the NEXT reply can chain onto this one
      // even if the customer never writes back in between.
      // A new thread's subject is recorded now so the NEXT reply chains onto
      // it. Everything else is stamped by the worker once the provider answers.
      metadata: emailThread ? { email: { subject: emailThread.subject } } : undefined,
    });

    await outgoingMessageQueue.add("send", {
      tenantId: req.tenantId!,
      conversationId,
      channel,
      channelAccountId: conversation.channelAccountId!,
      recipientExternalId: recipientId,
      body,
      messageType: messageType || "text",
      senderName: req.user!.email,
      messageId: message.id,
      // The PROVIDER's id, not ours. This is what the channel needs to render
      // the quote on the customer's phone.
      replyToExternalId: quoted?.externalMessageId ?? undefined,
      emailThread,
      emailReplyMode: isEmail ? (emailReplyMode || "reply") : undefined,
    }, { attempts: 3, backoff: { type: "exponential", delay: 1000 } });

    res.status(201).json({ data: message });
  } catch (err) {
    console.error("Send message error:", err);
    res.status(500).json({ error: "Failed to send message" });
  }
});

// ─── Send Media Message (file upload) ────────────────────────
router.post("/:conversationId/messages/media", async (req: Request, res: Response) => {
  try {
    const conversationId = req.params.conversationId as string;

    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, tenantId: req.tenantId! },
      include: { channelAccount: true },
    });
    if (!conversation) { res.status(404).json({ error: "Conversation not found" }); return; }
    if (!conversation.channelAccount) { res.status(400).json({ error: "Channel not configured" }); return; }

    const rawCreds = conversation.channelAccount.credentials;
    const creds = typeof rawCreds === "string" ? decryptCredentials(rawCreds) : (rawCreds as any);
    if (!creds?.accessToken) { res.status(400).json({ error: "Channel not configured" }); return; }

    // Parse multipart form data manually using built-in approach
    const contentType = req.headers["content-type"] || "";
    if (!contentType.includes("multipart/form-data")) {
      res.status(400).json({ error: "Expected multipart/form-data" }); return;
    }

    // Use busboy for multipart parsing
    const busboy = (await import("busboy")).default;
    const bb = busboy({ headers: req.headers, limits: { fileSize: MAX_FILE_SIZE, files: 1 } });

    let fileBuffer: Buffer | null = null;
    let originalName = "";
    let mimeType = "";
    let caption = "";

    await new Promise<void>((resolve, reject) => {
      bb.on("file", (_fieldname: string, file: any, info: { filename: string; mimeType: string }) => {
        originalName = info.filename;
        mimeType = info.mimeType;
        const chunks: Buffer[] = [];
        file.on("data", (chunk: Buffer) => chunks.push(chunk));
        file.on("end", () => { fileBuffer = Buffer.concat(chunks); });
      });
      bb.on("field", (fieldname: string, val: string) => {
        if (fieldname === "body" || fieldname === "caption") caption = val;
      });
      bb.on("finish", resolve);
      bb.on("error", reject);
      req.pipe(bb);
    });

    if (!fileBuffer || !originalName) {
      res.status(400).json({ error: "No file uploaded" }); return;
    }

    // Determine message type from mime
    let messageType = "document";
    if (mimeType.startsWith("image/")) messageType = "image";
    else if (mimeType.startsWith("video/")) messageType = "video";

    // Save file to uploads directory
    const ext = path.extname(originalName) || getExtFromMime(mimeType);
    const savedName = `${crypto.randomUUID()}${ext}`;
    const filePath = path.join(UPLOADS_DIR, savedName);
    fs.writeFileSync(filePath, fileBuffer);

    const mediaUrl = `${UPLOADS_BASE_URL}/${savedName}`;
    const channel = conversation.channel || "WHATSAPP";

    // Build a public URL for the outgoing message (channels need a publicly accessible URL)
    const baseUrl = process.env.PUBLIC_URL || process.env.NEXT_PUBLIC_API_URL || "";
    const publicMediaUrl = baseUrl ? `${baseUrl}${mediaUrl}` : mediaUrl;

    const message = await messageService.create({
      tenantId: req.tenantId!,
      conversationId,
      direction: "OUTBOUND",
      body: caption || "",
      messageType,
      senderName: req.user!.email,
      mediaUrl,
      fileName: originalName,
    });

    await outgoingMessageQueue.add("send", {
      tenantId: req.tenantId!,
      conversationId,
      channel,
      channelAccountId: conversation.channelAccountId!,
      recipientExternalId: conversation.customerExternalId,
      body: caption || "",
      messageType,
      senderName: req.user!.email,
      messageId: message.id,
      mediaUrl: publicMediaUrl,
      fileName: originalName,
    }, { attempts: 3, backoff: { type: "exponential", delay: 1000 } });

    res.status(201).json({ data: message });
  } catch (err) {
    console.error("Send media message error:", err);
    res.status(500).json({ error: "Failed to send media message" });
  }
});

function getExtFromMime(mime: string): string {
  const map: Record<string, string> = {
    "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp",
    "video/mp4": ".mp4", "video/webm": ".webm",
    "application/pdf": ".pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/zip": ".zip",
  };
  return map[mime] || ".bin";
}

// ─── Delete Message ──────────────────────────────────────────
router.delete("/:conversationId/messages/:messageId", async (req: Request, res: Response) => {
  try {
    const userRole = (req as any).user?.role;

    if (userRole !== "ADMIN" && userRole !== "SYSTEM_ADMIN") {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    const message = await prisma.message.findFirst({
      where: {
        id: req.params.messageId as string,
        tenantId: req.tenantId!,
        conversationId: req.params.conversationId as string,
      },
    });

    if (!message) {
      res.status(404).json({ error: "Message not found" });
      return;
    }

    await prisma.message.delete({ where: { id: message.id } });

    res.json({ data: { deleted: true, messageId: message.id } });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to delete message" });
  }
});

export default router;
