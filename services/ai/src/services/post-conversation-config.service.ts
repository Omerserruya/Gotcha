/**
 * Post-Conversation Config — tenant-level schema for the post-conversation
 * summarizer + rule engine.
 *
 * Source of truth: `PostConversationConfig` Prisma model (one row per
 * tenant, JSON `data` column). Mirrors the pattern in policy.service.ts —
 * DB authoritative, in-process cache as fallback only.
 *
 * Three sections:
 *   - summaryFields: extra CRM slots the LLM should try to populate
 *                    (fed into the summarizer as allowedFields).
 *   - taskRules:    "if X then create task Y" — applied by the rule
 *                    engine AFTER the summarizer runs.
 *   - crmRules:     "if X then patch CRM with Y" — same.
 *
 * Sparse-patch semantics (see feedback memory): rules only ADD to the
 * sparse crm_patch and ADD tasks. They never overwrite the prior CRM
 * record except via the explicit patch keys they declare.
 */

import { prisma } from "@chatcenter/shared";

export interface SummaryFieldDef {
  /** Stable key written into crm_patch and mentioned_fields. */
  key: string;
  label: string;
  description?: string;
  /** "text" | "number" | "boolean" | "enum" — extend as needed. */
  type?: string;
  /** Enum-style allowed values, if `type === "enum"`. */
  options?: string[];
}

export interface TaskRule {
  id: string;
  /** Trigger conditions — all listed conditions must match (AND). */
  when: {
    intent?: string;          // e.g. "pricing_objection"
    intents?: string[];        // any-of (OR within this field)
    sentiment?: "positive" | "neutral" | "negative" | "mixed";
    keywords?: string[];       // substring match on the transcript (case-insensitive)
  };
  task: {
    subject: string;
    body?: string;
    priority?: "low" | "normal" | "high" | "urgent";
  };
}

export interface CrmRule {
  id: string;
  when: {
    intent?: string;
    intents?: string[];
    sentiment?: "positive" | "neutral" | "negative" | "mixed";
    keywords?: string[];
  };
  patch: Record<string, unknown>;
}

export interface PostConversationConfig {
  summaryFields: SummaryFieldDef[];
  taskRules: TaskRule[];
  crmRules: CrmRule[];
}

export const DEFAULT_POST_CONVERSATION_CONFIG: PostConversationConfig = {
  summaryFields: [],
  taskRules: [],
  crmRules: [],
};

const cache = new Map<string, PostConversationConfig>();

function isSummaryFieldDef(v: unknown): v is SummaryFieldDef {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.key === "string" && o.key.length > 0
    && typeof o.label === "string" && o.label.length > 0;
}

function isTaskRule(v: unknown): v is TaskRule {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.when || typeof o.when !== "object") return false;
  const t = o.task as Record<string, unknown> | undefined;
  return !!t && typeof t.subject === "string" && t.subject.length > 0;
}

function isCrmRule(v: unknown): v is CrmRule {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.when || typeof o.when !== "object") return false;
  return !!o.patch && typeof o.patch === "object";
}

function normalize(raw: unknown): PostConversationConfig {
  const r = (raw ?? {}) as Partial<PostConversationConfig>;
  return {
    summaryFields: Array.isArray(r.summaryFields)
      ? r.summaryFields.filter(isSummaryFieldDef)
      : [],
    taskRules: Array.isArray(r.taskRules) ? r.taskRules.filter(isTaskRule) : [],
    crmRules: Array.isArray(r.crmRules) ? r.crmRules.filter(isCrmRule) : [],
  };
}

export async function getPostConversationConfig(
  tenantId: string,
): Promise<PostConversationConfig> {
  try {
    const row = await (prisma as any).postConversationConfig?.findUnique?.({
      where: { tenantId },
    });
    if (row && row.data) {
      const cfg = normalize(row.data);
      cache.set(tenantId, cfg);
      return cfg;
    }
    if (row === null) return DEFAULT_POST_CONVERSATION_CONFIG;
  } catch {
    // DB unavailable — fall through to cache.
  }
  return cache.get(tenantId) ?? DEFAULT_POST_CONVERSATION_CONFIG;
}

export async function setPostConversationConfig(
  tenantId: string,
  patch: Partial<PostConversationConfig>,
): Promise<PostConversationConfig> {
  const current = await getPostConversationConfig(tenantId);
  const next: PostConversationConfig = normalize({ ...current, ...patch });
  try {
    await (prisma as any).postConversationConfig?.upsert?.({
      where: { tenantId },
      update: { data: next as any },
      create: { tenantId, data: next as any },
    });
  } catch (err) {
    console.warn("[post-conversation-config.setPostConversationConfig] DB write failed:", err);
  }
  cache.set(tenantId, next);
  return next;
}

/**
 * Convenience: returns the allowed-keys array the summarizer should pass
 * into the LLM prompt. Always includes the canonical fields the
 * built-in summarizer understands, plus whatever custom keys the tenant
 * declared.
 *
 * TODO(ci-phase2): this is the READ site to cut over to the FieldDefinition
 * registry. Customer Intelligence V2 made `FieldDefinition` the canonical,
 * scope-aware field store (see intelligence-registry.service.ts), but Phase 1
 * deliberately left this legacy `summaryFields` read path untouched to avoid a
 * summarizer regression. Until Phase 2 cuts over, `summaryFields` and
 * `FieldDefinition` are two stores — they don't currently fight (packs/Fields
 * Builder write only to FieldDefinition), but this overlap MUST be closed.
 * Migration plan: docs/customer-intelligence-summaryfields-migration.md
 * Rationale: docs/architecture/adr/0001-customer-intelligence-phase1.md
 */
export async function getSummarizerAllowedFields(tenantId: string): Promise<string[]> {
  const cfg = await getPostConversationConfig(tenantId);
  const builtins = [
    "status",          // lead status
    "stage",           // funnel stage
    "budget",
    "timeline",
    "decision_maker",
    "company",
    "role",
  ];
  const custom = cfg.summaryFields.map((f) => f.key);
  return Array.from(new Set([...builtins, ...custom]));
}
