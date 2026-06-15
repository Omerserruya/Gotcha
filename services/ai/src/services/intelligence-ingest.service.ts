/**
 * Intelligence Ingest - Customer Intelligence V2, Phase 2.
 *
 * The write path that turns extracted conversation fields into the V2 model:
 * routes each (key, value) by its `FieldDefinition.scope` into the right
 * entity (CustomerProfile / Opportunity / Conversation), appends an
 * `IntelligenceFact` (append-only provenance log), and folds the entity's
 * denormalized `facts` snapshot under the merge policy.
 *
 * Merge policy (the anti-overwrite contract, docs/customer-intelligence-domain-model.md §5):
 *   - Scope gate: a fact only targets a field whose scope matches the entity.
 *   - Manual supremacy: a `manual` snapshot value is never overwritten by an
 *     LLM/derived source.
 *   - Confidence + recency: among non-manual sources, higher confidence wins;
 *     ties broken by newer observedAt.
 *   - Absence ≠ deletion: a null/empty value produces NO fact, so it can never
 *     clear an existing value.
 *
 * The entity `facts` snapshot is stored as a rich map
 *   { [fieldKey]: { value, confidence, source, observedAt, conversationId } }
 * so the merge decision is O(1) and the card can show provenance / "unconfirmed"
 * without re-folding the whole log. The IntelligenceFact table remains the
 * append-only source of truth for history/analytics.
 *
 * This is ADDITIVE in Phase 2: the legacy summaryFields → crm_patch → CRM path
 * is unchanged; ingest runs alongside it (see ADR 0001 / the migration note).
 */

import { prisma } from "@chatcenter/shared";
import { deriveIdentityKey } from "./customer-brief.service";

export type FactSourceName = "manual" | "crm_inbound" | "llm_close" | "llm_live" | "rule" | "derived";
type FieldScope = "customer" | "opportunity" | "conversation";

const SOURCE_TO_PRISMA: Record<FactSourceName, string> = {
  manual: "MANUAL", crm_inbound: "CRM_INBOUND", llm_close: "LLM_CLOSE",
  llm_live: "LLM_LIVE", rule: "RULE", derived: "DERIVED",
};

export interface ExtractedField {
  key: string;
  value: unknown;
  confidence?: number;
}

export interface FactSnapshotEntry {
  value: unknown;
  confidence: number;
  source: FactSourceName;
  observedAt: string;       // ISO
  conversationId?: string | null;
}

export interface IngestResult {
  ok: boolean;
  reason?: string;
  profileId?: string;
  opportunityId?: string | null;
  written: number;          // facts that landed (snapshot changed)
  logged: number;           // IntelligenceFact rows appended
  skipped: number;          // empty/unknown-key/scope-rejected
}

// ── Value coercion by field type ──
function coerceValue(value: unknown, type?: string): unknown {
  if (value === null || value === undefined) return value;
  switch (type) {
    case "NUMBER": {
      if (typeof value === "number") return value;
      const n = Number(String(value).replace(/[^0-9.\-]/g, ""));
      return Number.isFinite(n) ? n : null;
    }
    case "BOOLEAN": {
      if (typeof value === "boolean") return value;
      const s = String(value).trim().toLowerCase();
      if (["true", "yes", "1", "כן"].includes(s)) return true;
      if (["false", "no", "0", "לא"].includes(s)) return false;
      return null;
    }
    default:
      return value;
  }
}

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

// ── Identity resolution (conversation → cross-channel anchors) ──
export interface ResolvedIdentity {
  identityKey: string;
  personId: string | null;
  contactId: string | null;
  crmContactId: string | null;
  crmObjectKind: string | null;
  displayName: string | null;
  phone: string | null;
  email: string | null;
}

export async function resolveIdentity(tenantId: string, conversationId: string): Promise<ResolvedIdentity | null> {
  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, tenantId },
    select: { channel: true, customerExternalId: true, customerName: true },
  });
  if (!conv) return null;

  let contact: any = null;
  if (conv.channel && conv.customerExternalId) {
    contact = await (prisma as any).contact.findFirst({
      where: { tenantId, channel: conv.channel, externalId: conv.customerExternalId },
      select: { id: true, personId: true, phone: true, email: true, displayName: true, metadata: true },
    });
  }
  const meta = (contact?.metadata ?? {}) as Record<string, any>;
  const hints = {
    personId: contact?.personId ?? null,
    crmContactId: meta?.crmContactId ?? null,
    crmVendor: meta?.crmVendor ?? null,
    contactId: contact?.id ?? null,
  };
  const identityKey = deriveIdentityKey(hints);
  if (!identityKey) return null;

  return {
    identityKey,
    personId: hints.personId,
    contactId: hints.contactId,
    crmContactId: hints.crmContactId,
    crmObjectKind: meta?.crmObjectKind ?? null,
    displayName: contact?.displayName ?? conv.customerName ?? null,
    phone: contact?.phone ?? null,
    email: contact?.email ?? null,
  };
}

async function upsertCustomerProfile(tenantId: string, id: ResolvedIdentity): Promise<any> {
  const now = new Date();
  return (prisma as any).customerProfile.upsert({
    where: { tenantId_identityKey: { tenantId, identityKey: id.identityKey } },
    update: {
      personId: id.personId ?? undefined,
      contactId: id.contactId ?? undefined,
      crmContactId: id.crmContactId ?? undefined,
      crmObjectKind: id.crmObjectKind ?? undefined,
      displayName: id.displayName ?? undefined,
      phone: id.phone ?? undefined,
      email: id.email ?? undefined,
      lastSeenAt: now,
    },
    create: {
      tenantId,
      identityKey: id.identityKey,
      personId: id.personId,
      contactId: id.contactId,
      crmContactId: id.crmContactId,
      crmObjectKind: id.crmObjectKind,
      displayName: id.displayName,
      phone: id.phone,
      email: id.email,
      firstSeenAt: now,
      lastSeenAt: now,
    },
  });
}

/**
 * Resolve the open Opportunity to attach opportunity-scoped facts to, creating
 * one conservatively if none is open (v2 §9). `type` is the tenant's industry
 * pack slug (or "general"). Matching-type open opp → attach; else any open opp
 * → attach; else create.
 */
async function resolveOpenOpportunity(tenantId: string, profileId: string, type: string): Promise<any> {
  const open = await (prisma as any).opportunity.findMany({
    where: { tenantId, customerProfileId: profileId, status: "OPEN" },
    orderBy: { lastActivityAt: "desc" },
  });
  const match = open.find((o: any) => o.type === type) ?? open[0];
  if (match) return match;
  return (prisma as any).opportunity.create({
    data: { tenantId, customerProfileId: profileId, type, status: "OPEN", lastActivityAt: new Date() },
  });
}

/**
 * Apply the merge policy to one snapshot slot. Returns the next entry, or null
 * if the existing value should be kept (no change).
 */
function mergeSlot(current: FactSnapshotEntry | undefined, next: FactSnapshotEntry): FactSnapshotEntry | null {
  if (!current) return next;
  if (current.source === "manual" && next.source !== "manual") return null; // manual supremacy
  if (next.source === "manual") return next;
  // both non-manual: higher confidence wins; tie → newer observedAt
  if (next.confidence > current.confidence) return next;
  if (next.confidence === current.confidence && next.observedAt >= current.observedAt) return next;
  return null;
}

/**
 * Main entry: ingest extracted fields from a conversation into the V2 model.
 * Resolves identity, routes by scope, appends facts, folds snapshots.
 */
export async function ingestConversationFacts(params: {
  tenantId: string;
  conversationId: string;
  fields: ExtractedField[];
  source: FactSourceName;
  /** Default confidence when a field carries none (close=0.8, live=0.6). */
  defaultConfidence?: number;
}): Promise<IngestResult> {
  const { tenantId, conversationId, fields, source } = params;
  const defConf = params.defaultConfidence ?? (source === "llm_live" ? 0.6 : 0.8);

  if (!fields?.length) return { ok: true, written: 0, logged: 0, skipped: 0 };

  const identity = await resolveIdentity(tenantId, conversationId);
  if (!identity) return { ok: false, reason: "no-identity", written: 0, logged: 0, skipped: fields.length };

  // Load the tenant's field registry (key → scope/type).
  const defs = await (prisma as any).fieldDefinition.findMany({
    where: { tenantId },
    select: { key: true, scope: true, type: true },
  });
  const defByKey = new Map<string, { scope: FieldScope; type: string }>(
    defs.map((d: any) => [d.key, { scope: String(d.scope).toLowerCase() as FieldScope, type: d.type }]),
  );

  const profile = await upsertCustomerProfile(tenantId, identity);

  // Partition incoming fields by scope (skip unknown keys + empty values).
  const byScope: Record<FieldScope, Array<{ key: string; value: unknown; confidence: number; type: string }>> = {
    customer: [], opportunity: [], conversation: [],
  };
  let skipped = 0;
  for (const f of fields) {
    const def = defByKey.get(f.key);
    if (!def) { skipped++; continue; }                 // unknown key → Discovery's job (P6)
    const value = coerceValue(f.value, def.type);
    if (isEmpty(value)) { skipped++; continue; }        // absence ≠ deletion
    byScope[def.scope].push({ key: f.key, value, confidence: f.confidence ?? defConf, type: def.type });
  }

  const observedAt = new Date();
  const observedIso = observedAt.toISOString();
  let written = 0;
  let logged = 0;

  // Resolve an opportunity only if we have opportunity-scoped facts to write.
  let opportunity: any = null;
  if (byScope.opportunity.length > 0) {
    const bp = await prisma.businessProfile.findUnique({
      where: { tenantId }, select: { packSlug: true },
    }).catch(() => null);
    const type = (bp as any)?.packSlug || "general";
    opportunity = await resolveOpenOpportunity(tenantId, profile.id, type);
  }

  // Helper: append fact rows + fold a snapshot map.
  async function applyScope(
    entityType: "CUSTOMER" | "OPPORTUNITY" | "CONVERSATION",
    entityId: string,
    snapshot: Record<string, FactSnapshotEntry>,
    items: Array<{ key: string; value: unknown; confidence: number }>,
  ): Promise<Record<string, FactSnapshotEntry>> {
    const next = { ...snapshot };
    for (const it of items) {
      // Append-only log (always - full history).
      await (prisma as any).intelligenceFact.create({
        data: {
          tenantId, entityType, entityId, fieldKey: it.key,
          value: it.value as any, confidence: it.confidence,
          source: SOURCE_TO_PRISMA[source] as any,
          observedAt, conversationId,
        },
      });
      logged++;
      const candidate: FactSnapshotEntry = {
        value: it.value, confidence: it.confidence, source, observedAt: observedIso, conversationId,
      };
      const merged = mergeSlot(next[it.key], candidate);
      if (merged) { next[it.key] = merged; written++; }
    }
    return next;
  }

  // CUSTOMER scope → CustomerProfile.facts
  if (byScope.customer.length > 0) {
    const nextFacts = await applyScope("CUSTOMER", profile.id, (profile.facts ?? {}) as any, byScope.customer);
    await (prisma as any).customerProfile.update({
      where: { id: profile.id }, data: { facts: nextFacts as any, lastSeenAt: observedAt },
    });
  }

  // OPPORTUNITY scope → Opportunity.facts
  if (byScope.opportunity.length > 0 && opportunity) {
    const nextFacts = await applyScope("OPPORTUNITY", opportunity.id, (opportunity.facts ?? {}) as any, byScope.opportunity);
    await (prisma as any).opportunity.update({
      where: { id: opportunity.id }, data: { facts: nextFacts as any, lastActivityAt: observedAt },
    });
  }

  // CONVERSATION scope → log only (the interaction record owns its own fields).
  if (byScope.conversation.length > 0) {
    await applyScope("CONVERSATION", conversationId, {}, byScope.conversation);
  }

  return {
    ok: true,
    profileId: profile.id,
    opportunityId: opportunity?.id ?? null,
    written, logged, skipped,
  };
}
