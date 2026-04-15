/**
 * F3.3 / F3.4 — Connector abstraction layer.
 *
 * Thin interfaces the action-executor calls into. Concrete implementations
 * (HubSpot, Salesforce, WhatsApp, Email, etc.) live in the integrations
 * service and register themselves via the registry below. This file only
 * defines contracts — no business logic, no external I/O.
 *
 * Per CLAUDE.md, connectors are the ONLY path from AI to external systems.
 * Action-executor must never bypass them.
 */

export interface CrmUpdate {
  contactId: string;
  fields: Record<string, unknown>;
}

export interface CrmTicket {
  contactId: string;
  subject: string;
  body: string;
  priority?: "low" | "normal" | "high" | "urgent";
}

export interface CrmConnector {
  readonly name: string;
  updateContact(tenantId: string, update: CrmUpdate): Promise<{ ok: boolean; externalId?: string; error?: string }>;
  createTicket(tenantId: string, ticket: CrmTicket): Promise<{ ok: boolean; externalId?: string; error?: string }>;
}

export interface OutboundMessage {
  contactId: string;
  channel: "whatsapp" | "email" | "sms" | "webchat";
  body: string;
  templateId?: string;
}

export interface MessagingConnector {
  readonly name: string;
  send(tenantId: string, msg: OutboundMessage): Promise<{ ok: boolean; messageId?: string; error?: string }>;
}

// ─── Registry ───────────────────────────────────────────────

const crmRegistry = new Map<string, CrmConnector>();
const messagingRegistry = new Map<string, MessagingConnector>();

export function registerCrmConnector(c: CrmConnector) {
  crmRegistry.set(c.name, c);
}
export function registerMessagingConnector(c: MessagingConnector) {
  messagingRegistry.set(c.name, c);
}

export function getCrmConnector(name?: string): CrmConnector | null {
  if (!name) return crmRegistry.values().next().value ?? null;
  return crmRegistry.get(name) ?? null;
}
export function getMessagingConnector(name?: string): MessagingConnector | null {
  if (!name) return messagingRegistry.values().next().value ?? null;
  return messagingRegistry.get(name) ?? null;
}

// ─── Default connectors ────────────────────────────────────
// CRM has no in-repo owner — fail loudly rather than fake success.
// Messaging enqueues to the shared outgoingMessageQueue (same path the
// conversation service uses), so send_message has a REAL side effect.

const failingCrm: CrmConnector = {
  name: "unconfigured",
  async updateContact() {
    return { ok: false, error: "no CRM connector configured — register via registerCrmConnector()" };
  },
  async createTicket() {
    return { ok: false, error: "no CRM connector configured — register via registerCrmConnector()" };
  },
};

const queueMessaging: MessagingConnector = {
  name: "outgoing-queue",
  async send(tenantId, msg) {
    try {
      const { prisma, outgoingMessageQueue } = await import("@chatcenter/shared");
      const contact = await prisma.contact.findFirst({
        where: { id: msg.contactId, tenantId },
        select: { id: true, externalId: true, channel: true },
      });
      if (!contact) return { ok: false, error: "contact not found" };
      // Conversation and Contact are linked by (tenantId, customerExternalId,
      // channel) — not by FK. Find the most recent conversation matching the
      // requested outbound channel, falling back to the contact's primary.
      const convo = await prisma.conversation.findFirst({
        where: {
          tenantId,
          customerExternalId: contact.externalId,
          channel: msg.channel.toUpperCase() as any,
        },
        orderBy: { updatedAt: "desc" },
        select: { id: true },
      });
      if (!convo) return { ok: false, error: "no conversation for contact on requested channel" };
      const message = await prisma.message.create({
        data: {
          tenantId,
          conversationId: convo.id,
          direction: "OUTBOUND" as any,
          body: msg.body,
          channel: msg.channel.toUpperCase() as any,
          status: "PENDING" as any,
          senderName: "AI",
        },
        select: { id: true },
      });
      await outgoingMessageQueue.add("send", {
        tenantId,
        conversationId: convo.id,
        messageId: message.id,
        channel: msg.channel,
        body: msg.body,
        source: "ai-action-executor",
      });
      return { ok: true, messageId: message.id };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? "queue enqueue failed" };
    }
  },
};

registerCrmConnector(failingCrm);
registerMessagingConnector(queueMessaging);
