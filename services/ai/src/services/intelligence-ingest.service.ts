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
  /** Verbatim snippet from the conversation that justifies this value. */
  evidence?: string | null;
}

export interface FactSnapshotEntry {
  value: unknown;
  confidence: number;
  source: FactSourceName;
  observedAt: string;       // ISO
  conversationId?: string | null;
  evidence?: string | null;
}

export interface IngestResult {
  ok: boolean;
  reason?: string;
  profileId?: string;
  opportunityId?: string | null;
  written: number;          // facts that landed (snapshot changed)
  logged: number;           // IntelligenceFact rows appended
  reviewed: number;         // routed to the human-review queue
  skipped: number;          // empty/unknown-key/scope-rejected
}

// ── Conflict-resolution policy constants ──
// Default minimum confidence to auto-apply a value when a field declares no
// threshold of its own. Below this → human review.
const GLOBAL_CONFIDENCE_FLOOR = 0.6;
// A NEW, DIFFERENT value must beat the current confidence by this margin to
// overwrite automatically; otherwise the conflict goes to human review.
const CONFLICT_MARGIN = 0.15;

type MergeDecision =
  | { action: "apply"; entry: FactSnapshotEntry }
  | { action: "review"; reason: "low_confidence" | "conflict" }
  | { action: "ignore" };

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
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
 * Conflict-resolution decision for one snapshot slot. Documented policy:
 *
 *   1. Manual supremacy   - a human-entered value always wins and is never sent
 *                           to review; a non-manual source never overwrites it.
 *   2. Low confidence     - a value below the field's threshold NEVER auto-writes;
 *                           it is queued for human review (reason=low_confidence).
 *   3. First value        - no current value + above threshold → apply.
 *   4. Agreement          - same value as current → refresh confidence/recency.
 *   5. Conflict           - a DIFFERENT value:
 *        • overwrite ONLY if clearly more confident (≥ current + CONFLICT_MARGIN);
 *        • otherwise keep the current value and queue the new one for review
 *          (reason=conflict) - the "keep both, let a human decide" path.
 *
 * History/provenance is preserved regardless: every applied value appends an
 * IntelligenceFact row, so the full timeline is reconstructable per field.
 */
export function decideMerge(
  current: FactSnapshotEntry | undefined,
  next: FactSnapshotEntry,
  threshold: number,
): MergeDecision {
  // (1) Manual edits are sacred.
  if (next.source === "manual") return { action: "apply", entry: next };
  if (current?.source === "manual") return { action: "ignore" };

  // (2) Low-confidence guess never auto-writes.
  if (next.confidence < threshold) return { action: "review", reason: "low_confidence" };

  // (3) First confident value.
  if (!current) return { action: "apply", entry: next };

  // (4) Agreement - strengthen recency/confidence, no conflict.
  if (valuesEqual(current.value, next.value)) {
    if (next.confidence > current.confidence || next.observedAt >= current.observedAt) {
      return { action: "apply", entry: next };
    }
    return { action: "ignore" };
  }

  // (5) Conflict - overwrite only when clearly more confident, else review.
  if (next.confidence >= current.confidence + CONFLICT_MARGIN) {
    return { action: "apply", entry: next };
  }
  return { action: "review", reason: "conflict" };
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

  if (!fields?.length) return { ok: true, written: 0, logged: 0, reviewed: 0, skipped: 0 };

  const identity = await resolveIdentity(tenantId, conversationId);
  if (!identity) return { ok: false, reason: "no-identity", written: 0, logged: 0, reviewed: 0, skipped: fields.length };

  // Load the tenant's field registry (key → scope/type/threshold).
  const defs = await (prisma as any).fieldDefinition.findMany({
    where: { tenantId },
    select: { key: true, scope: true, type: true, confidenceThreshold: true },
  });
  const defByKey = new Map<string, { scope: string; type: string; threshold: number }>(
    defs.map((d: any) => [
      d.key,
      {
        scope: String(d.scope).toLowerCase(),
        type: d.type,
        threshold: typeof d.confidenceThreshold === "number" ? d.confidenceThreshold : GLOBAL_CONFIDENCE_FLOOR,
      },
    ]),
  );

  const profile = await upsertCustomerProfile(tenantId, identity);

  // Partition incoming fields by scope (skip unknown keys + empty values).
  // A REVIEW_REQUIRED (or any non-routable) scope is parked: we never guess
  // where its value belongs, so it is skipped until a human assigns a real
  // scope in the Fields Builder.
  type ScopedItem = { key: string; value: unknown; confidence: number; type: string; threshold: number; evidence: string | null };
  const byScope: Record<FieldScope, ScopedItem[]> = { customer: [], opportunity: [], conversation: [] };
  let skipped = 0;
  for (const f of fields) {
    const def = defByKey.get(f.key);
    if (!def) { skipped++; continue; }                 // unknown key → Discovery's job (P6)
    if (def.scope !== "customer" && def.scope !== "opportunity" && def.scope !== "conversation") {
      skipped++; continue;                              // REVIEW_REQUIRED / unroutable → park
    }
    const value = coerceValue(f.value, def.type);
    if (isEmpty(value)) { skipped++; continue; }        // absence ≠ deletion
    byScope[def.scope as FieldScope].push({
      key: f.key, value, confidence: f.confidence ?? defConf, type: def.type,
      threshold: def.threshold, evidence: f.evidence ?? null,
    });
  }

  const observedAt = new Date();
  const observedIso = observedAt.toISOString();
  let written = 0;
  let logged = 0;
  let reviewed = 0;

  // Resolve an opportunity only if we have opportunity-scoped facts to write.
  let opportunity: any = null;
  if (byScope.opportunity.length > 0) {
    const bp = await prisma.businessProfile.findUnique({
      where: { tenantId }, select: { packSlug: true },
    }).catch(() => null);
    const type = (bp as any)?.packSlug || "general";
    opportunity = await resolveOpenOpportunity(tenantId, profile.id, type);
  }

  // Helper: route each item via the conflict-resolution policy. Applied values
  // append an IntelligenceFact (the accepted-value timeline / history) and fold
  // the snapshot; uncertain or conflicting values are queued for human review
  // instead of touching the snapshot.
  async function applyScope(
    entityType: "CUSTOMER" | "OPPORTUNITY" | "CONVERSATION",
    entityId: string,
    snapshot: Record<string, FactSnapshotEntry>,
    items: ScopedItem[],
  ): Promise<Record<string, FactSnapshotEntry>> {
    const next = { ...snapshot };
    for (const it of items) {
      const candidate: FactSnapshotEntry = {
        value: it.value, confidence: it.confidence, source,
        observedAt: observedIso, conversationId, evidence: it.evidence,
      };
      const decision = decideMerge(next[it.key], candidate, it.threshold);

      if (decision.action === "apply") {
        // Append-only log = accepted-value history with full provenance.
        await (prisma as any).intelligenceFact.create({
          data: {
            tenantId, entityType, entityId, fieldKey: it.key,
            value: it.value as any, confidence: it.confidence,
            source: SOURCE_TO_PRISMA[source] as any,
            evidence: it.evidence, observedAt, conversationId,
          },
        });
        logged++;
        next[it.key] = decision.entry;
        written++;
      } else if (decision.action === "review") {
        await queueReview({
          entityType, entityId, fieldKey: it.key,
          proposedValue: it.value, currentValue: next[it.key]?.value ?? null,
          confidence: it.confidence, evidence: it.evidence,
          reason: decision.reason,
        });
        reviewed++;
      }
      // action === "ignore" → nothing.
    }
    return next;
  }

  // Create (or refresh) a PENDING review row for an uncertain/conflicting value.
  // De-dupes on (entity, field): the newest proposal replaces an older pending
  // one so the queue never stacks duplicates for the same slot.
  async function queueReview(r: {
    entityType: "CUSTOMER" | "OPPORTUNITY" | "CONVERSATION";
    entityId: string;
    fieldKey: string;
    proposedValue: unknown;
    currentValue: unknown;
    confidence: number;
    evidence: string | null;
    reason: "low_confidence" | "conflict";
  }): Promise<void> {
    const existing = await (prisma as any).intelligenceReview.findFirst({
      where: { tenantId, entityType: r.entityType, entityId: r.entityId, fieldKey: r.fieldKey, status: "PENDING" },
      select: { id: true },
    }).catch(() => null);
    const data = {
      proposedValue: r.proposedValue as any,
      currentValue: (r.currentValue ?? null) as any,
      confidence: r.confidence,
      evidence: r.evidence,
      reason: r.reason,
      source: SOURCE_TO_PRISMA[source] as any,
      conversationId,
    };
    if (existing) {
      await (prisma as any).intelligenceReview.update({ where: { id: existing.id }, data }).catch(() => {});
    } else {
      await (prisma as any).intelligenceReview.create({
        data: { tenantId, entityType: r.entityType, entityId: r.entityId, fieldKey: r.fieldKey, status: "PENDING", ...data },
      }).catch(() => {});
    }
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
    written, logged, reviewed, skipped,
  };
}
