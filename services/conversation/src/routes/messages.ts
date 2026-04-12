import { Router, Request, Response } from "express";
import { z } from "zod";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { prisma, authenticate, resolveTenant, validate, outgoingMessageQueue, decryptCredentials, requireActiveTenant } from "@chatcenter/shared";
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
});

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
    const { body, messageType } = req.body;

    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, tenantId: req.tenantId! },
      include: { channelAccount: true },
    });
    if (!conversation) { res.status(404).json({ error: "Conversation not found" }); return; }

    const channel = conversation.channel || "WHATSAPP";
    const recipientId = conversation.customerExternalId;

    if (!conversation.channelAccount) {
      res.status(400).json({ error: "Channel not configured for this tenant" }); return;
    }

    // WEBCHAT: just save the message — the widget polls for new messages
    if (channel === "WEBCHAT") {
      const message = await messageService.create({
        tenantId: req.tenantId!,
        conversationId,
        direction: "OUTBOUND",
        body,
        messageType,
        senderName: req.user!.email,
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

    const message = await messageService.create({
      tenantId: req.tenantId!,
      conversationId,
      direction: "OUTBOUND",
      body,
      messageType,
      senderName: req.user!.email,
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
