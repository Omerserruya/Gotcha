import { getInternalServiceKey, readDurableSetting } from "@chatcenter/shared";
import { prisma, publishEvent, outgoingMessageQueue } from "@chatcenter/shared";
import { getIO } from "../lib/socket";
import * as messageService from "./message.service";

export interface ConversationFilters {
  status?: string;
  assignedAgentId?: string;
  channel?: string;
  departmentId?: string;
  search?: string;
  page?: number;
  limit?: number;
  includeAutomated?: boolean;
  // User context for scoping
  userRole?: string;
  userId?: string;
  userDepartmentId?: string;
}

export async function list(tenantId: string, filters: ConversationFilters) {
  const { status, assignedAgentId, channel, departmentId, search, page = 1, limit = 50, includeAutomated = false, userRole, userId, userDepartmentId } = filters;
  const where: any = { tenantId };
  if (status) where.status = status;
  // By default, exclude AI/flow-handled conversations unless explicitly requested or handed over
  if (!includeAutomated) {
    where.AND = where.AND || [];
    where.AND.push({
      OR: [
        { handledBy: null },
        { handledBy: "human" },
        { isHandedOver: true },
      ],
    });
  }
  if (assignedAgentId) where.assignedAgentId = assignedAgentId;
  if (channel) where.channel = channel;
  if (departmentId) where.departmentId = departmentId;

  // Scope: ADMIN sees all, agents see only unassigned + assigned to them
  if (userRole && userRole !== "ADMIN" && userDepartmentId) {
    where.OR = [
      { departmentId: userDepartmentId, assignedAgentId: null },
      { departmentId: null, assignedAgentId: null },
      { assignedAgentId: userId },
    ];
  }

  if (search) {
    where.AND = where.AND || [];
    where.AND.push({
      OR: [
        { customerExternalId: { contains: search, mode: "insensitive" } },
        { customerName: { contains: search, mode: "insensitive" } },
      ],
    });
  }
  const skip = (page - 1) * limit;
  const [conversations, total] = await Promise.all([
    prisma.conversation.findMany({
      where,
      include: {
        assignedAgent: { select: { id: true, name: true, email: true } },
        department: { select: { id: true, name: true } },
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
      department: { select: { id: true, name: true } },
      channelAccount: { select: { id: true, channel: true, displayName: true, externalId: true } },
      messages: { orderBy: { createdAt: "asc" } },
    },
  });
}

export async function transferToDepartment(tenantId: string, conversationId: string, departmentId: string) {
  const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId } });
  if (!conversation) throw Object.assign(new Error("Conversation not found"), { status: 404 });

  const department = await prisma.department.findFirst({
    where: { id: departmentId, tenantId, isActive: true },
    include: { members: { include: { user: { select: { id: true, name: true, isActive: true, _count: { select: { conversations: { where: { status: { not: "CLOSED" } } } } } } } } } },
  });
  if (!department) throw Object.assign(new Error("Department not found"), { status: 404 });

  let assignedAgentId: string | null = null;

  // If round-robin, assign to the agent with fewest active conversations
  if (department.queueMode === "ROUND_ROBIN") {
    const activeMembers = department.members.filter((m) => m.user.isActive);
    if (activeMembers.length > 0) {
      activeMembers.sort((a, b) => a.user._count.conversations - b.user._count.conversations);
      assignedAgentId = activeMembers[0].userId;
    }
  }

  const updated = await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      departmentId,
      assignedAgentId,
      isHandedOver: true,
      status: assignedAgentId ? "OPEN" : "WAITING",
    },
    include: {
      assignedAgent: { select: { id: true, name: true, email: true } },
      department: { select: { id: true, name: true } },
    },
  });

  const agentName = updated.assignedAgent?.name;
  await createSystemMessage(tenantId, conversationId, "department_transferred", {
    departmentName: department.name,
    ...(agentName ? { agentName } : {}),
  });

  emitToTenant(tenantId, "conversation:updated", updated);

  // Auto-greeting if agent was auto-assigned via round-robin
  if (assignedAgentId) {
    await sendAutoGreeting(tenantId, conversationId, assignedAgentId, conversation);
  }

  return updated;
}

export async function claim(tenantId: string, conversationId: string, agentId: string) {
  const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId } });
  if (!conversation) throw Object.assign(new Error("Conversation not found"), { status: 404 });

  // Allow reclaim if already assigned to the same agent (e.g. after transfer)
  if (conversation.assignedAgentId && conversation.assignedAgentId !== agentId) {
    throw Object.assign(new Error("Conversation already assigned"), { status: 409 });
  }

  const alreadyAssigned = conversation.assignedAgentId === agentId;

  const updated = alreadyAssigned
    ? await prisma.conversation.findFirst({
        where: { id: conversationId, tenantId },
        include: { assignedAgent: { select: { id: true, name: true, email: true } } },
      })
    : await prisma.conversation.update({
        where: { id: conversationId },
        data: { assignedAgentId: agentId, isHandedOver: true },
        include: { assignedAgent: { select: { id: true, name: true, email: true } } },
      });

  if (!updated) throw Object.assign(new Error("Conversation not found"), { status: 404 });

  if (!alreadyAssigned) {
    // System divider: agent claimed
    const agentName = updated.assignedAgent?.name || "Agent";
    await createSystemMessage(tenantId, conversationId, "agent_claimed", { agentName });
  }

  emitToTenant(tenantId, "conversation:updated", updated);

  // Auto-greeting (send on both claim and reclaim)
  await sendAutoGreeting(tenantId, conversationId, agentId, conversation);

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

/**
 * Hand a human-owned conversation BACK to the AI employee. The inverse of
 * escalation/claim: clears the human assignment AND the isHandedOver latch
 * (which nothing else in the system ever clears), so the bot resumes on the
 * next inbound. Requires an AI employee to actually be bound to the
 * conversation - otherwise there is nobody to hand back to.
 */
export async function returnToAi(tenantId: string, conversationId: string) {
  const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId } });
  if (!conversation) throw Object.assign(new Error("Conversation not found"), { status: 404 });
  if (!(conversation as any).assignedAiAgentId) {
    throw Object.assign(new Error("No AI employee is bound to this conversation"), { status: 409 });
  }

  const updated = await prisma.conversation.update({
    where: { id: conversationId },
    data: { assignedAgentId: null, isHandedOver: false, handledBy: "ai_agent", status: "OPEN" },
    include: { assignedAgent: { select: { id: true, name: true, email: true } } },
  });

  await createSystemMessage(tenantId, conversationId, "returned_to_ai", {});
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
  await sendAutoGreeting(tenantId, conversationId, newAgentId, conversation);

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

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || "http://ai:4006";
const INTERNAL_SERVICE_KEY = getInternalServiceKey();

/**
 * Ask the AI service for the CRM-side identifiers (phone, email, every
 * GOTCHA-prefixed channel id custom field - gotcha_psid_instagram,
 * gotcha_wa_id, etc.) tied to this conversation's linked Lead/Contact. The
 * CRM is authoritative - local Contact rows can be sparse or missing for
 * some channels - so the History walk uses these to find every
 * conversation across every channel for the same person.
 *
 * Returns null on any failure; the caller falls back to local-only matching.
 */
async function fetchCrmIdentifiersForConversation(
  tenantId: string,
  conversationId: string,
): Promise<{ phone: string | null; email: string | null; channelExternalIds: Record<string, string> } | null> {
  try {
    const url = `${AI_SERVICE_URL.replace(/\/$/, "")}/api/crm/resolve-identifiers`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-key": INTERNAL_SERVICE_KEY,
      },
      body: JSON.stringify({ tenantId, conversationId }),
    });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as any;
    if (!data) return null;
    return {
      phone: data.phone ?? null,
      email: data.email ?? null,
      channelExternalIds: (data.channelExternalIds ?? {}) as Record<string, string>,
    };
  } catch {
    return null;
  }
}

export async function getHistoryByCustomerExternalId(
  tenantId: string,
  customerExternalId: string,
  conversationId?: string,
) {
  // Cross-platform history walk. The bare (tenantId, customerExternalId) lookup
  // only finds same-channel conversations (Instagram PSID matches the PSID,
  // phone matches the phone, etc.). To surface ALL prior conversations for
  // this person - WhatsApp + Instagram + Messenger + voice + … - we follow
  // two unification keys:
  //   1. Contact.personId    - populated by unifyContact when rows share an
  //                            email/phone, so platform contacts on different
  //                            channels collapse to a single person.
  //   2. Contact.metadata.crmContactId - the auto-link pointer that bridges
  //                            inbound conversations to the same CRM Lead/
  //                            Contact across every channel.
  //
  // We start from any Contact row matching the inbound externalId, gather
  // the union of all externalIds that share its personId or crmContactId,
  // then pull every conversation for those externalIds. The original
  // externalId is included so conversations without a Contact pointer still
  // appear.

  const seedContacts = await prisma.contact.findMany({
    where: { tenantId, externalId: customerExternalId },
    select: { id: true, personId: true, metadata: true, phone: true, email: true },
  });

  const externalIds = new Set<string>([customerExternalId]);
  const personIds = new Set<string>();
  const crmContactIds = new Set<string>();
  const phones = new Set<string>();
  const emails = new Set<string>();
  for (const c of seedContacts) {
    if (c.personId) personIds.add(c.personId);
    if (c.phone) phones.add(c.phone);
    if (c.email) emails.add(c.email.toLowerCase());
    const meta = (c.metadata as Record<string, unknown> | null) ?? {};
    const crmId = typeof meta.crmContactId === "string" ? meta.crmContactId : null;
    if (crmId) crmContactIds.add(crmId);
  }

  // Pull the CRM-side identifiers - the CRM is the source of truth for
  // phone/email and gotcha_psid_* custom fields. Local Contact rows can be
  // sparse or missing on some channels; this fills the gaps.
  if (conversationId) {
    const crmIdent = await fetchCrmIdentifiersForConversation(tenantId, conversationId);
    if (crmIdent) {
      if (crmIdent.phone) phones.add(crmIdent.phone);
      if (crmIdent.email) emails.add(crmIdent.email.toLowerCase());
      // Every channel custom field is a candidate externalId for that channel's
      // conversations (PSID for IG, page-id for Messenger, WA id for WhatsApp, etc.)
      for (const id of Object.values(crmIdent.channelExternalIds)) {
        if (id) externalIds.add(id);
      }
    }
  }

  if (personIds.size > 0 || crmContactIds.size > 0 || phones.size > 0 || emails.size > 0) {
    const siblingFilters: any[] = [];
    if (personIds.size > 0) siblingFilters.push({ personId: { in: Array.from(personIds) } });
    if (phones.size > 0) siblingFilters.push({ phone: { in: Array.from(phones) } });
    if (emails.size > 0) {
      // Email matches are normalized lowercase. Contact.email is stored as
      // the user provided it; case-insensitive `in` via Prisma needs `mode`,
      // but our writers already lowercase, so an `in` against lowered set
      // matches in practice. Also add a raw exact match as a safety net.
      siblingFilters.push({ email: { in: Array.from(emails) } });
    }
    // Prisma's path filter on Json works for Postgres - `path: ["crmContactId"]`
    // matches the same key our auto-link writes.
    for (const id of crmContactIds) {
      siblingFilters.push({ metadata: { path: ["crmContactId"], equals: id } });
    }
    // Also pull externalIds that LITERALLY match the phone (Meta WhatsApp
    // stores the customerExternalId AS the phone digits - no `+`). Trying
    // both formats covers tenants that normalize to E.164 and tenants on
    // legacy local format.
    for (const p of phones) {
      const digits = p.replace(/\D/g, "");
      externalIds.add(p);
      if (digits) externalIds.add(digits);
    }
    const siblings = await prisma.contact.findMany({
      where: { tenantId, OR: siblingFilters },
      select: { externalId: true },
    });
    for (const s of siblings) {
      if (s.externalId) externalIds.add(s.externalId);
    }
  }

  const conversations = await prisma.conversation.findMany({
    where: {
      tenantId,
      customerExternalId: { in: Array.from(externalIds) },
    },
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

// ─── Auto-greeting helper (channel-aware) ───────────────────

async function sendAutoGreeting(
  tenantId: string,
  conversationId: string,
  agentId: string,
  conversation: any,
) {
  try {
    const { getRedis } = await import("@chatcenter/shared");
    const redis = getRedis();
    const template = await readDurableSetting(tenantId, "autoGreeting");
    if (!template) return;

    const agent = await prisma.user.findUnique({ where: { id: agentId }, select: { name: true } });
    const greeting = template.replace(/\{agentName\}/g, agent?.name || "Agent");

    const channel = conversation.channel || "WHATSAPP";
    const recipientId = conversation.customerExternalId;
    let channelAccountId: string | null = conversation.channelAccountId;

    // If no channelAccountId on conversation, try to find one for this tenant+channel
    if (!channelAccountId) {
      const fallbackAccount = await prisma.channelAccount.findFirst({
        where: { tenantId, channel, isActive: true },
        select: { id: true },
      });
      if (fallbackAccount) channelAccountId = fallbackAccount.id;
    }

    if (!channelAccountId) return;

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
      channel,
      channelAccountId,
      recipientExternalId: recipientId,
      body: greeting,
      messageType: "text",
      senderName: agent?.name || "System",
      messageId: message.id,
    }, { attempts: 3, backoff: { type: "exponential", delay: 1000 } });
  } catch (err) {
    console.error("Auto-greeting error (non-fatal):", err);
  }
}
