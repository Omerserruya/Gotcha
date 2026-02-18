import { prisma, publishEvent } from "@chatcenter/shared";
import { getIO } from "../lib/socket";

interface CreateMessageData {
  tenantId: string;
  conversationId: string;
  direction: "INBOUND" | "OUTBOUND";
  body: string;
  messageType?: string;
  senderName?: string;
  waMessageId?: string;
  externalMessageId?: string;
  channel?: "WHATSAPP" | "MESSENGER";
  metadata?: any;
}

export async function listByConversation(tenantId: string, conversationId: string, options: { page?: number; limit?: number } = {}) {
  const page = Math.max(options.page ?? 1, 1);
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const skip = (page - 1) * limit;
  const [messages, total] = await Promise.all([
    prisma.message.findMany({ where: { tenantId, conversationId }, orderBy: { createdAt: "asc" }, skip, take: limit }),
    prisma.message.count({ where: { tenantId, conversationId } }),
  ]);
  return { data: messages, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

export async function create(data: CreateMessageData) {
  const message = await prisma.$transaction(async (tx) => {
    const msg = await tx.message.create({
      data: {
        tenantId: data.tenantId, conversationId: data.conversationId, direction: data.direction,
        body: data.body, messageType: data.messageType ?? "text", senderName: data.senderName,
        channel: data.channel ?? undefined,
        externalMessageId: data.externalMessageId,
        waMessageId: data.waMessageId, metadata: data.metadata ?? undefined,
        status: data.direction === "OUTBOUND" ? "PENDING" : "DELIVERED",
      },
    });
    await tx.conversation.update({ where: { id: data.conversationId }, data: { lastMessageAt: msg.createdAt } });
    return msg;
  });

  const eventData = { message, conversationId: data.conversationId };
  try { getIO().to(`tenant:${data.tenantId}`).emit("message:new", eventData); } catch {}
  publishEvent({ event: "message:new", tenantId: data.tenantId, data: eventData }).catch(() => {});
  return message;
}

export async function updateStatus(messageId: string, status: "SENT" | "DELIVERED" | "READ" | "FAILED") {
  // Try finding by externalMessageId first, then waMessageId (legacy)
  const message = await prisma.message.findFirst({
    where: {
      OR: [
        { externalMessageId: messageId },
        { waMessageId: messageId },
      ],
    },
  });
  if (!message) return null;
  const statusOrder = ["PENDING", "SENT", "DELIVERED", "READ"] as const;
  const currentIdx = statusOrder.indexOf(message.status as any);
  const newIdx = statusOrder.indexOf(status as any);
  if (status !== "FAILED" && newIdx <= currentIdx) return message;

  const updated = await prisma.message.update({ where: { id: message.id }, data: { status } });
  const eventData = { messageId: updated.id, conversationId: updated.conversationId, status: updated.status };
  try { getIO().to(`tenant:${message.tenantId}`).emit("message:status", eventData); } catch {}
  publishEvent({ event: "message:status", tenantId: message.tenantId, data: eventData }).catch(() => {});
  return updated;
}
