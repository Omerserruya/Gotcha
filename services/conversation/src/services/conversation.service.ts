import { prisma, publishEvent, outgoingMessageQueue } from "@chatcenter/shared";
import { getIO } from "../lib/socket";
import * as messageService from "./message.service";

export interface ConversationFilters {
  status?: string;
  assignedAgentId?: string;
  search?: string;
  page?: number;
  limit?: number;
}

export async function list(tenantId: string, filters: ConversationFilters) {
  const { status, assignedAgentId, search, page = 1, limit = 50 } = filters;
  const where: any = { tenantId };
  if (status) where.status = status;
  if (assignedAgentId) where.assignedAgentId = assignedAgentId;
  if (search) {
    where.OR = [
      { customerPhone: { contains: search, mode: "insensitive" } },
      { customerName: { contains: search, mode: "insensitive" } },
    ];
  }
  const skip = (page - 1) * limit;
  const [conversations, total] = await Promise.all([
    prisma.conversation.findMany({
      where,
      include: {
        assignedAgent: { select: { id: true, name: true, email: true } },
        _count: { select: { messages: true } },
        messages: { orderBy: { createdAt: "desc" }, take: 1, select: { direction: true, body: true, createdAt: true } },
      },
      orderBy: { lastMessageAt: { sort: "desc", nulls: "last" } },
      skip, take: limit,
    }),
    prisma.conversation.count({ where }),
  ]);

  // Flatten last message info
  const data = conversations.map((c) => {
    const lastMsg = c.messages[0] || null;
    const { messages, ...rest } = c;
    return { ...rest, lastMessageDirection: lastMsg?.direction || null, lastMessageBody: lastMsg?.body || null };
  });

  return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
}

export async function getById(tenantId: string, id: string) {
  return prisma.conversation.findFirst({
    where: { id, tenantId },
    include: {
      assignedAgent: { select: { id: true, name: true, email: true } },
      messages: { orderBy: { createdAt: "asc" } },
    },
  });
}

export async function claim(tenantId: string, conversationId: string, agentId: string) {
  const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId } });
  if (!conversation) throw Object.assign(new Error("Conversation not found"), { status: 404 });
  if (conversation.assignedAgentId) throw Object.assign(new Error("Conversation already assigned"), { status: 409 });

  const updated = await prisma.conversation.update({
    where: { id: conversationId },
    data: { assignedAgentId: agentId, isHandedOver: true },
    include: { assignedAgent: { select: { id: true, name: true, email: true } } },
  });

  // System divider: agent claimed
  const agentName = updated.assignedAgent?.name || "Agent";
  await createSystemMessage(tenantId, conversationId, "agent_claimed", { agentName });

  emitToTenant(tenantId, "conversation:updated", updated);

  // Auto-greeting
  await sendAutoGreeting(tenantId, conversationId, agentId, conversation.customerPhone);

  return updated;
}

export async function release(tenantId: string, conversationId: string) {
  const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId } });
  if (!conversation) throw Object.assign(new Error("Conversation not found"), { status: 404 });

  const updated = await prisma.conversation.update({
    where: { id: conversationId },
    data: { assignedAgentId: null, status: "OPEN" },
    include: { assignedAgent: { select: { id: true, name: true, email: true } } },
  });

  emitToTenant(tenantId, "conversation:updated", updated);
  return updated;
}

export async function reassign(tenantId: string, conversationId: string, newAgentId: string) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, tenantId },
    include: { assignedAgent: { select: { name: true } } },
  });
  if (!conversation) throw Object.assign(new Error("Conversation not found"), { status: 404 });
  const newAgent = await prisma.user.findFirst({ where: { id: newAgentId, tenantId } });
  if (!newAgent) throw Object.assign(new Error("Agent not found"), { status: 404 });

  const fromAgentName = (conversation as any).assignedAgent?.name || "Unknown";
  const toAgentName = newAgent.name;

  const updated = await prisma.conversation.update({
    where: { id: conversationId },
    data: { assignedAgentId: newAgentId, isHandedOver: true },
    include: { assignedAgent: { select: { id: true, name: true, email: true } } },
  });

  // System divider: conversation transferred
  await createSystemMessage(tenantId, conversationId, "agent_transferred", { fromAgentName, toAgentName });

  emitToTenant(tenantId, "conversation:updated", updated);

  // Auto-greeting from the new agent
  await sendAutoGreeting(tenantId, conversationId, newAgentId, conversation.customerPhone);

  return updated;
}

export async function close(tenantId: string, conversationId: string) {
  const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId } });
  if (!conversation) throw Object.assign(new Error("Conversation not found"), { status: 404 });

  const updated = await prisma.conversation.update({
    where: { id: conversationId },
    data: { status: "CLOSED", closedAt: new Date() },
    include: { assignedAgent: { select: { id: true, name: true, email: true } } },
  });

  emitToTenant(tenantId, "conversation:closed", updated);
  return updated;
}

export async function getAgentWorkload(tenantId: string) {
  const agents = await prisma.user.findMany({
    where: { tenantId, role: "AGENT", isActive: true },
    select: {
      id: true, name: true, email: true,
      _count: { select: { conversations: { where: { status: { not: "CLOSED" } } } } },
    },
  });
  return agents.map((a) => ({ agentId: a.id, name: a.name, email: a.email, activeCount: a._count.conversations }));
}

export async function getHistoryByPhone(tenantId: string, customerPhone: string) {
  const conversations = await prisma.conversation.findMany({
    where: { tenantId, customerPhone },
    include: {
      assignedAgent: { select: { id: true, name: true } },
      _count: { select: { messages: true } },
      messages: { orderBy: { createdAt: "desc" }, take: 1, select: { direction: true, body: true, createdAt: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return conversations.map((c) => {
    const lastMsg = c.messages[0] || null;
    const { messages, ...rest } = c;
    return { ...rest, lastMessageBody: lastMsg?.body || null, lastMessageDirection: lastMsg?.direction || null };
  });
}

function emitToTenant(tenantId: string, event: string, data: any) {
  try { getIO().to(`tenant:${tenantId}`).emit(event, data); } catch {}
  publishEvent({ event, tenantId, data }).catch(() => {});
}

// ─── System divider messages ────────────────────────────────

async function createSystemMessage(
  tenantId: string,
  conversationId: string,
  systemEvent: string,
  eventData: Record<string, string>,
) {
  try {
    await messageService.create({
      tenantId,
      conversationId,
      direction: "INBOUND",
      body: "",
      messageType: "system",
      senderName: "System",
      metadata: { systemEvent, ...eventData },
    });
  } catch (err) {
    console.error("System message error (non-fatal):", err);
  }
}

// ─── Auto-greeting helper ───────────────────────────────────

async function sendAutoGreeting(
  tenantId: string,
  conversationId: string,
  agentId: string,
  customerPhone: string,
) {
  try {
    const { getRedis } = await import("@chatcenter/shared");
    const redis = getRedis();
    const template = await redis.get(`tenant:${tenantId}:autoGreeting`);
    if (!template) return;

    const agent = await prisma.user.findUnique({ where: { id: agentId }, select: { name: true } });
    const greeting = template.replace(/\{agentName\}/g, agent?.name || "Agent");

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant?.waPhoneNumberId || !tenant?.waAccessToken) return;

    const message = await messageService.create({
      tenantId,
      conversationId,
      direction: "OUTBOUND",
      body: greeting,
      senderName: agent?.name || "System",
    });

    await outgoingMessageQueue.add("send", {
      tenantId,
      conversationId,
      customerPhone,
      phoneNumberId: tenant.waPhoneNumberId,
      accessToken: tenant.waAccessToken,
      body: greeting,
      messageType: "text",
      senderName: agent?.name || "System",
      messageId: message.id,
    }, { attempts: 3, backoff: { type: "exponential", delay: 1000 } });
  } catch (err) {
    console.error("Auto-greeting error (non-fatal):", err);
  }
}
