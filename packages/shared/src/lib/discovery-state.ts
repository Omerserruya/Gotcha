/**
 * Discovery State domain logic - authoritative, tenant- + conversation-scoped
 * structured conversational memory.
 *
 * Design contract:
 *  - Keys are derived from TRUSTED SERVER CONTEXT (tenantId, conversationId,
 *    goalKey). Never from model-controlled tool arguments.
 *  - The model PROPOSES fact values (via extraction); this module validates,
 *    normalizes, authorizes by source precedence, and persists.
 *  - model_inference can NEVER silently replace an explicit customer or
 *    provider fact.
 *  - Readiness is computed HERE, deterministically, against a DiscoveryProfile
 *    - not decided by the LLM. Optional facts never block a ready action.
 *  - Writes CAS on the session `version` so concurrent inbound messages can't
 *    clobber newer state.
 */
import { prisma } from "./prisma";
import {
  type DiscoveryProfile,
  type FactSpec,
  normalizeFactKey,
} from "./discovery-profiles";

export type FactSource =
  | "customer_explicit"
  | "customer_correction"
  | "provider"
  | "tenant_configuration"
  | "knowledge_base"
  | "model_inference";

// Higher wins. A new fact may supersede an active one ONLY if its source rank
// is >= the incumbent's (with corrections treated as customer authority).
const SOURCE_RANK: Record<FactSource, number> = {
  provider: 100,
  customer_correction: 90,
  customer_explicit: 80,
  tenant_configuration: 60,
  knowledge_base: 40,
  model_inference: 10,
};

export interface ProposedFact {
  /** Raw/aliased key as proposed; normalized against the profile. */
  key: string;
  value: unknown;
  source: FactSource;
  confidence?: number;
  sourceMessageId?: string | null;
  /** The customer signalled this is a change to a previous value. */
  isCorrection?: boolean;
}

export interface ReadinessResult {
  goal: string;
  ready: boolean;
  missingRequired: string[];
  missingOptional: string[];
  nextAction: DiscoveryProfile["readyAction"] | null;
}

type AnyFact = {
  id: string;
  normalizedKey: string;
  valueJson: unknown;
  source: string;
  status: string;
  explicitlyConfirmed: boolean;
};

/** The single ACTIVE session for (tenant, conversation, goal), or create one. */
export async function getOrCreateActiveSession(opts: {
  tenantId: string;
  conversationId: string;
  goalKey: string;
  aiAgentId?: string | null;
}): Promise<any> {
  const existing = await (prisma as any).discoverySession.findFirst({
    where: {
      tenantId: opts.tenantId,
      conversationId: opts.conversationId,
      goalKey: opts.goalKey,
      status: { in: ["active", "ready_for_action", "awaiting_customer", "action_in_progress"] },
    },
    orderBy: { startedAt: "desc" },
  });
  if (existing) return existing;
  return (prisma as any).discoverySession.create({
    data: {
      tenantId: opts.tenantId,
      conversationId: opts.conversationId,
      goalKey: opts.goalKey,
      aiAgentId: opts.aiAgentId ?? null,
      status: "active",
    },
  });
}

/** Active facts for a session, keyed by normalizedKey (latest active wins). */
export async function activeFacts(sessionId: string): Promise<Map<string, AnyFact>> {
  const rows: AnyFact[] = await (prisma as any).discoveryFact.findMany({
    where: { sessionId, status: "active" },
    orderBy: { createdAt: "asc" },
  });
  const m = new Map<string, AnyFact>();
  for (const r of rows) m.set(r.normalizedKey, r);
  return m;
}

function valueType(spec: FactSpec | undefined, value: unknown): string {
  if (spec) return spec.type;
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "string";
}

/**
 * Apply proposed facts to a session. Returns the keys actually written.
 * Enforces source precedence + supersede history. CAS-bumps the session
 * version so a stale concurrent write is detectable by the caller.
 */
export async function applyExtractedFacts(opts: {
  session: any;
  profile: DiscoveryProfile;
  facts: ProposedFact[];
}): Promise<{ written: string[]; superseded: string[] }> {
  const { session, profile } = opts;
  const current = await activeFacts(session.id);
  const specByKey = new Map(profile.facts.map((f) => [f.key, f]));
  const written: string[] = [];
  const superseded: string[] = [];

  for (const p of opts.facts) {
    const nk = normalizeFactKey(profile, p.key);
    if (!nk) continue; // unknown/foreign key - reject (no model-invented envelope)
    const spec = specByKey.get(nk);
    const incoming = p.isCorrection ? "customer_correction" : p.source;
    const incomingRank = SOURCE_RANK[incoming as FactSource] ?? 0;
    const existing = current.get(nk);

    if (existing) {
      // Identical value + not a correction → no-op (dedupe).
      if (!p.isCorrection && JSON.stringify(existing.valueJson) === JSON.stringify(p.value)) continue;
      const existingRank = SOURCE_RANK[existing.source as FactSource] ?? 0;
      // model_inference can NEVER override an explicit/provider fact; general
      // rule: incoming must be >= incumbent to supersede.
      if (incomingRank < existingRank) continue;
      // Supersede: retire the old, insert the new pointing back at it.
      await (prisma as any).discoveryFact.update({
        where: { id: existing.id },
        data: { status: "superseded" },
      });
      superseded.push(nk);
      await (prisma as any).discoveryFact.create({
        data: factData(session, nk, p, spec, existing.id),
      });
      written.push(nk);
    } else {
      await (prisma as any).discoveryFact.create({
        data: factData(session, nk, p, spec, null),
      });
      written.push(nk);
    }
  }

  if (written.length) {
    await (prisma as any).discoverySession.update({
      where: { id: session.id },
      data: { version: { increment: 1 } },
    });
  }
  return { written, superseded };
}

function factData(session: any, nk: string, p: ProposedFact, spec: FactSpec | undefined, supersedesFactId: string | null) {
  const source = p.isCorrection ? "customer_correction" : p.source;
  return {
    sessionId: session.id,
    tenantId: session.tenantId,
    key: p.key,
    normalizedKey: nk,
    valueType: valueType(spec, p.value),
    valueJson: p.value as any,
    source,
    confidence: p.confidence ?? (source === "model_inference" ? 0.5 : 0.9),
    status: "active",
    sourceMessageId: p.sourceMessageId ?? null,
    explicitlyConfirmed: source === "customer_explicit" || source === "customer_correction",
    sensitivity: spec?.sensitivity ?? "normal",
    supersedesFactId,
  };
}

/** Record that a question for `requirementKey` was asked this turn. */
export async function recordQuestionAsked(opts: {
  session: any;
  requirementKey: string;
  askedMessageId?: string | null;
}): Promise<void> {
  const nk = opts.requirementKey;
  const existing = await (prisma as any).discoveryQuestion.findFirst({
    where: { sessionId: opts.session.id, normalizedQuestionKey: nk },
  });
  if (existing) {
    await (prisma as any).discoveryQuestion.update({
      where: { id: existing.id },
      data: { status: "asked", askedMessageId: opts.askedMessageId ?? existing.askedMessageId, askedAt: new Date(), attemptCount: { increment: 1 } },
    });
  } else {
    await (prisma as any).discoveryQuestion.create({
      data: {
        sessionId: opts.session.id, tenantId: opts.session.tenantId,
        requirementKey: nk, normalizedQuestionKey: nk,
        status: "asked", askedMessageId: opts.askedMessageId ?? null, askedAt: new Date(), attemptCount: 1,
      },
    });
  }
}

/** Mark questions answered for any keys that just received an active fact. */
export async function markAnswered(opts: {
  session: any;
  answeredKeys: string[];
  answeredMessageId?: string | null;
}): Promise<void> {
  if (!opts.answeredKeys.length) return;
  await (prisma as any).discoveryQuestion.updateMany({
    where: { sessionId: opts.session.id, normalizedQuestionKey: { in: opts.answeredKeys }, status: { in: ["planned", "asked"] } },
    data: { status: "answered", answeredMessageId: opts.answeredMessageId ?? null, answeredAt: new Date() },
  });
}

/** Deterministic readiness against the profile. Optional facts NEVER block. */
export async function computeReadiness(session: any, profile: DiscoveryProfile): Promise<ReadinessResult> {
  const have = await activeFacts(session.id);
  const missingRequired = profile.facts.filter((f) => f.required && !have.has(f.key)).map((f) => f.key);
  const missingOptional = profile.facts.filter((f) => !f.required && !have.has(f.key)).map((f) => f.key);
  const ready = missingRequired.length === 0;
  return {
    goal: profile.goalKey,
    ready,
    missingRequired,
    missingOptional,
    nextAction: ready ? profile.readyAction : null,
  };
}

/**
 * State-backed re-ask gate. Returns a block verdict for asking `requirementKey`
 * again. Blocks when: an active explicit answer exists; OR the key is optional
 * and the action is already ready; OR the question was already answered.
 */
export async function shouldBlockQuestion(opts: {
  session: any;
  profile: DiscoveryProfile;
  requirementKey: string;
}): Promise<{ block: boolean; reason?: string }> {
  const nk = normalizeFactKey(opts.profile, opts.requirementKey) ?? opts.requirementKey;
  const have = await activeFacts(opts.session.id);
  const fact = have.get(nk);
  if (fact && (fact.explicitlyConfirmed || fact.source === "provider")) {
    return { block: true, reason: "active_explicit_answer_exists" };
  }
  const readiness = await computeReadiness(opts.session, opts.profile);
  const spec = opts.profile.facts.find((f) => f.key === nk);
  if (spec && !spec.required && readiness.ready) {
    return { block: true, reason: "optional_and_action_ready" };
  }
  const answered = await (prisma as any).discoveryQuestion.findFirst({
    where: { sessionId: opts.session.id, normalizedQuestionKey: nk, status: "answered" },
  });
  if (answered) return { block: true, reason: "question_already_answered" };
  return { block: false };
}

/** Record a provider-action attempt (search/etc.) for reproducibility + reshow dedupe. */
export async function recordActionAttempt(opts: {
  session: any;
  actionKey: string;
  criteria: unknown;
  toolName?: string;
  executionId?: string;
  resultStatus: "pending" | "succeeded" | "failed" | "no_results" | "blocked";
  resultRefs?: unknown;
  shownResourceIds?: string[];
}): Promise<void> {
  await (prisma as any).discoveryActionAttempt.create({
    data: {
      sessionId: opts.session.id, tenantId: opts.session.tenantId,
      actionKey: opts.actionKey, criteriaJson: opts.criteria as any,
      toolName: opts.toolName ?? null, executionId: opts.executionId ?? null,
      resultStatus: opts.resultStatus,
      resultRefs: (opts.resultRefs ?? null) as any,
      shownResourceIds: (opts.shownResourceIds ?? null) as any,
    },
  });
}

/**
 * Compact, model-facing snapshot for Prompt BLOCK 5. Deterministic, redacted
 * (no internal ids / DB shape). Tells the model exactly what is known, what is
 * still needed, and the next action - so it stops re-asking and executes.
 */
export async function buildDiscoverySnapshot(session: any, profile: DiscoveryProfile): Promise<string> {
  const have = await activeFacts(session.id);
  const readiness = await computeReadiness(session, profile);
  const known: string[] = [];
  for (const f of profile.facts) {
    const fact = have.get(f.key);
    if (fact) known.push(`- ${labelFor(f.key)}: ${renderValue(fact.valueJson)}`);
  }
  const unknown = readiness.missingRequired.concat(readiness.missingOptional).map((k) => `- ${labelFor(k)}`);
  const lines = [
    "DISCOVERY STATE",
    `Goal: ${profile.goalKey}`,
    "",
    "Known:",
    ...(known.length ? known : ["- (nothing yet)"]),
    "",
    "Unknown:",
    ...(unknown.length ? unknown : ["- (all collected)"]),
    "",
    "Rules:",
    "- Do NOT ask again about anything under Known - it is already answered.",
    "- Optional unknowns must NOT block the action; ask at most ONE required unknown per turn.",
    readiness.ready
      ? `- Enough info exists. The next action is a REAL tool call: ${readiness.nextAction?.tool}. Do not narrate a search - execute it.`
      : `- Still missing required: ${readiness.missingRequired.map(labelFor).join(", ")}. Ask ONE of these, nothing else.`,
  ];
  return lines.join("\n");
}

const LABELS: Record<string, string> = {
  product_category: "Product", budget: "Budget", riding_style: "Riding style",
  height_cm: "Height (cm)", weight_kg: "Weight (kg)", preferred_length_cm: "Preferred length (cm)",
  flex: "Flex", boot_size: "Boot size", include_bindings: "Bindings", availability: "Availability",
};
function labelFor(k: string): string { return LABELS[k] ?? k; }
function renderValue(v: unknown): string {
  if (v && typeof v === "object") return JSON.stringify(v);
  return String(v);
}
