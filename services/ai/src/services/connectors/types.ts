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

// ─── Default stub connectors (no-op, always OK) ─────────────
// These let the action-executor run end-to-end in dev without real creds.

const stubCrm: CrmConnector = {
  name: "stub",
  async updateContact() {
    return { ok: true, externalId: "stub" };
  },
  async createTicket() {
    return { ok: true, externalId: "stub" };
  },
};
const stubMessaging: MessagingConnector = {
  name: "stub",
  async send() {
    return { ok: true, messageId: "stub" };
  },
};
registerCrmConnector(stubCrm);
registerMessagingConnector(stubMessaging);
