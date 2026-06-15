/**
 * Customer Snapshot — Customer Intelligence V2, Phase 3.
 *
 * The primary read projection over the three-domain model: WHO (CustomerProfile
 * + signals), WHAT (open Opportunities + their facts), NOW (last conversation),
 * MISSING (the gap engine), NEXT (opportunity.nextAction), NARRATIVE (the
 * behavioral brief prose). It is a generated fold of CustomerProfile /
 * Opportunity / ConversationIntelligence / FieldDefinition — never a source of
 * truth (docs/customer-intelligence-domain-model.md §7, v2 §7).
 *
 * The Missing-Information engine (v2 §5): a field is "missing" when it's
 * expected (required, or stage-relevant to the open opportunity's stage) but
 * not known (no fact, or confidence below τ). Gaps are ranked by importance.
 */

import { prisma } from "@chatcenter/shared";
import { resolveIdentity, type ResolvedIdentity } from "./intelligence-ingest.service";
import { getCustomerBrief } from "./customer-brief.service";

const TAU_KNOWN = 0.5; // confidence floor for a fact to count as "known"

type FieldScope = "customer" | "opportunity" | "conversation";

interface FieldDef {
  key: string;
  label: string;
  type: string;
  scope: FieldScope;
  required: boolean;
  options: string[];
  stageRelevance: string[];
}

interface FactSnapshotEntry {
  value: unknown;
  confidence: number;
  source: string;
  observedAt: string;
  conversationId?: string | null;
}

export interface SnapshotFact {
  key: string;
  label: string;
  value: unknown;
  type: string;
  confidence: number;
  source: string;
  /** uncertain = below τ_high (0.75) but above the known floor. */
  uncertain: boolean;
}

export interface SnapshotGap {
  key: string;
  label: string;
  scope: FieldScope;
  required: boolean;
  importance: "high" | "medium" | "low";
}

export interface SnapshotOpportunity {
  id: string;
  type: string;
  title: string | null;
  stage: string | null;
  status: string;
  estimatedValue: number | null;
  nextAction: string | null;
  facts: SnapshotFact[];
  missing: SnapshotGap[];
  openedAt: string;
  lastActivityAt: string | null;
}

export interface CustomerSnapshot {
  ok: boolean;
  reason?: string;
  who: {
    identityKey: string | null;
    displayName: string | null;
    phone: string | null;
    email: string | null;
    language: string | null;
    vipTier: string | null;
    sentiment: string | null;
    signals: Record<string, unknown>;
  };
  customerFacts: SnapshotFact[];
  opportunities: SnapshotOpportunity[];
  now: {
    conversationId: string | null;
    channel: string | null;
    lastAt: string | null;
    intent: string | null;
    sentiment: string | null;
    summary: string | null;
  } | null;
  missing: SnapshotGap[];        // top-ranked gaps across customer + active opp
  next: string | null;           // the single next action (active opportunity)
  narrative: string | null;      // behavioral brief prose (projection)
  generatedAt: string;
}

const TAU_HIGH = 0.75;

function toFact(def: FieldDef, entry: FactSnapshotEntry): SnapshotFact {
  return {
    key: def.key,
    label: def.label,
    value: entry.value,
    type: def.type ? String(def.type).toLowerCase() : "text",
    confidence: entry.confidence ?? 1,
    source: entry.source ? String(entry.source).toLowerCase() : "derived",
    uncertain: (entry.confidence ?? 1) < TAU_HIGH,
  };
}

function isKnown(snapshot: Record<string, FactSnapshotEntry>, key: string): boolean {
  const e = snapshot[key];
  return !!e && !(e.value === null || e.value === undefined || e.value === "") && (e.confidence ?? 1) >= TAU_KNOWN;
}

/** Gap = expected − known. A field is expected when required, or relevant to
 *  the current stage. */
function computeGaps(defs: FieldDef[], snapshot: Record<string, FactSnapshotEntry>, stage: string | null): SnapshotGap[] {
  const gaps: SnapshotGap[] = [];
  for (const d of defs) {
    const stageRelevant = stage ? (d.stageRelevance ?? []).includes(stage) : false;
    const expected = d.required || stageRelevant;
    if (!expected) continue;
    if (isKnown(snapshot, d.key)) continue;
    gaps.push({
      key: d.key,
      label: d.label,
      scope: d.scope,
      required: d.required,
      importance: d.required ? "high" : stageRelevant ? "medium" : "low",
    });
  }
  return gaps;
}

const IMPORTANCE_RANK = { high: 0, medium: 1, low: 2 } as const;

export async function buildCustomerSnapshot(params: {
  tenantId: string;
  conversationId?: string;
  identityKey?: string;
}): Promise<CustomerSnapshot> {
  const { tenantId } = params;
  const empty = (reason: string): CustomerSnapshot => ({
    ok: false, reason,
    who: { identityKey: params.identityKey ?? null, displayName: null, phone: null, email: null, language: null, vipTier: null, sentiment: null, signals: {} },
    customerFacts: [], opportunities: [], now: null, missing: [], next: null, narrative: null,
    generatedAt: new Date().toISOString(),
  });

  // Resolve identity → CustomerProfile.
  let identity: ResolvedIdentity | null = null;
  let identityKey = params.identityKey ?? null;
  if (params.conversationId) {
    identity = await resolveIdentity(tenantId, params.conversationId);
    if (identity) identityKey = identity.identityKey;
  }
  if (!identityKey) return empty("no-identity");

  const profile = await (prisma as any).customerProfile.findUnique({
    where: { tenantId_identityKey: { tenantId, identityKey } },
  });

  // Field registry (key → def), for labels + scope + gap expectations.
  const rawDefs = await (prisma as any).fieldDefinition.findMany({ where: { tenantId } });
  const defs: FieldDef[] = rawDefs.map((d: any) => ({
    key: d.key, label: d.label, type: d.type,
    scope: String(d.scope).toLowerCase() as FieldScope,
    required: !!d.required,
    options: Array.isArray(d.options) ? d.options : [],
    stageRelevance: Array.isArray(d.stageRelevance) ? d.stageRelevance : [],
  }));
  const defByKey = new Map(defs.map((d) => [d.key, d]));
  const customerDefs = defs.filter((d) => d.scope === "customer");

  // ── Customer facts + WHO ──
  const customerSnap: Record<string, FactSnapshotEntry> = (profile?.facts ?? {}) as any;
  const customerFacts: SnapshotFact[] = Object.entries(customerSnap)
    .map(([k, e]) => { const d = defByKey.get(k); return d ? toFact(d, e as FactSnapshotEntry) : null; })
    .filter(Boolean) as SnapshotFact[];

  const factVal = (key: string): unknown => {
    const e = customerSnap[key]; return e ? e.value : null;
  };

  // ── NOW (last conversation intelligence) ──
  let now: CustomerSnapshot["now"] = null;
  if (params.conversationId) {
    const [ci, conv] = await Promise.all([
      (prisma as any).conversationIntelligence.findUnique({ where: { conversationId: params.conversationId } }),
      prisma.conversation.findUnique({ where: { id: params.conversationId }, select: { channel: true, lastMessageAt: true, updatedAt: true } }),
    ]);
    now = {
      conversationId: params.conversationId,
      channel: (conv?.channel as any) ?? null,
      lastAt: (conv?.lastMessageAt ?? conv?.updatedAt)?.toISOString?.() ?? null,
      intent: ci?.detectedIntent ?? null,
      sentiment: ci?.sentiment ?? null,
      summary: ci?.summary ?? null,
    };
  }

  // ── Opportunities (open first) ──
  const oppRows = profile
    ? await (prisma as any).opportunity.findMany({
        where: { tenantId, customerProfileId: profile.id },
        orderBy: [{ status: "asc" }, { lastActivityAt: "desc" }],
      })
    : [];
  const opportunities: SnapshotOpportunity[] = oppRows.map((o: any) => {
    const snap: Record<string, FactSnapshotEntry> = (o.facts ?? {}) as any;
    const oppDefs = defs.filter((d) => d.scope === "opportunity");
    const facts = Object.entries(snap)
      .map(([k, e]) => { const d = defByKey.get(k); return d ? toFact(d, e as FactSnapshotEntry) : null; })
      .filter(Boolean) as SnapshotFact[];
    const missing = computeGaps(oppDefs, snap, o.stage ?? null)
      .sort((a, b) => IMPORTANCE_RANK[a.importance] - IMPORTANCE_RANK[b.importance]);
    return {
      id: o.id, type: o.type, title: o.title, stage: o.stage, status: o.status,
      estimatedValue: o.estimatedValue, nextAction: o.nextAction,
      facts, missing,
      openedAt: o.openedAt?.toISOString?.() ?? new Date().toISOString(),
      lastActivityAt: o.lastActivityAt?.toISOString?.() ?? null,
    };
  });
  const activeOpp = opportunities.find((o) => o.status === "OPEN") ?? opportunities[0] ?? null;

  // ── MISSING (customer-scope gaps + active opportunity gaps), ranked ──
  const customerGaps = computeGaps(customerDefs, customerSnap, null);
  const missing = [...customerGaps, ...(activeOpp?.missing ?? [])]
    .sort((a, b) => IMPORTANCE_RANK[a.importance] - IMPORTANCE_RANK[b.importance])
    .slice(0, 8);

  // ── NARRATIVE (behavioral brief prose — best-effort projection) ──
  let narrative: string | null = null;
  if (identity) {
    const brief = await getCustomerBrief({
      tenantId,
      hints: { personId: identity.personId, crmContactId: identity.crmContactId, contactId: identity.contactId },
    }).catch(() => null);
    narrative = brief?.brief ?? null;
  }

  return {
    ok: true,
    who: {
      identityKey,
      displayName: profile?.displayName ?? identity?.displayName ?? null,
      phone: profile?.phone ?? identity?.phone ?? null,
      email: profile?.email ?? identity?.email ?? null,
      language: (factVal("language") ?? factVal("preferred_language")) as string | null,
      vipTier: factVal("vip_tier") as string | null,
      sentiment: now?.sentiment ?? null,
      signals: (profile?.behavioralSignals ?? {}) as Record<string, unknown>,
    },
    customerFacts,
    opportunities,
    now,
    missing,
    next: activeOpp?.nextAction ?? null,
    narrative,
    generatedAt: new Date().toISOString(),
  };
}
