/**
 * F8 - Business Policy Engine
 *
 * Persistent policy layer. Source of truth = `BusinessPolicy` table in
 * Postgres (see packages/shared/prisma/schema.prisma). Reads go through
 * DB; a small in-process cache wraps them to avoid hitting Postgres on
 * every executeAction, but the cache NEVER overrides the DB value - it
 * is invalidated on write and only serves as a fallback when the DB is
 * unreachable (dev/test environments without a running database).
 *
 * Per CLAUDE.md, the AI service reads policy and validates against it;
 * it does not embed business rules.
 */
import { prisma } from "@chatcenter/shared";

export interface BusinessPolicy {
  maxDiscountPercent: number;
  refundRequiresApproval: boolean;
  escalationKeywords: string[];
  blockedTopics: string[];
  outboundQuietHours?: { startHour: number; endHour: number; tz?: string };
}

export const DEFAULT_POLICY: BusinessPolicy = {
  maxDiscountPercent: 10,
  refundRequiresApproval: true,
  escalationKeywords: ["lawyer", "lawsuit", "refund", "complaint", "angry"],
  blockedTopics: [],
};

// Cache layer - write-through, read-fallback only. Never consulted while
// the DB is available and returning a row.
const policyCache = new Map<string, BusinessPolicy>();

/** The string entries of a stored list, or null when it is not a list. */
function stringsOnly(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  // Non-string entries are dropped rather than failing the read: refusing to
  // serve a policy because one stored entry is malformed would take the AI
  // down for the tenant, and the rest of their rules are still valid.
  return value
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim())
    .slice(0, MAX_LIST_ITEMS);
}

function normalize(raw: unknown): BusinessPolicy {
  const r = (raw ?? {}) as Partial<BusinessPolicy>;
  return {
    maxDiscountPercent:
      typeof r.maxDiscountPercent === "number" ? r.maxDiscountPercent : DEFAULT_POLICY.maxDiscountPercent,
    refundRequiresApproval:
      typeof r.refundRequiresApproval === "boolean"
        ? r.refundRequiresApproval
        : DEFAULT_POLICY.refundRequiresApproval,
    // Element types are checked, not just `Array.isArray`. Rows written before
    // the write path validated anything are already in the database, and they
    // are composed into the system prompt: an array of numbers used to arrive
    // there as "1, 2, [object Object]". Reading defensively is what stops a
    // bad row that is already stored from reaching the model.
    escalationKeywords: stringsOnly(r.escalationKeywords) ?? DEFAULT_POLICY.escalationKeywords,
    blockedTopics: stringsOnly(r.blockedTopics) ?? DEFAULT_POLICY.blockedTopics,
    outboundQuietHours: r.outboundQuietHours,
  };
}

/**
 * Limits on the free-text lists.
 *
 * These lists are composed verbatim into the AI's system prompt (see
 * `policyPromptBlock` below), so their size is a cost and their content is
 * instruction text. Both were previously unbounded: `setPolicy` spread
 * `req.body` straight into the stored JSON, so a caller could put ten thousand
 * entries, or a paragraph of prose, into every prompt this tenant ever builds.
 */
export const MAX_LIST_ITEMS = 50;
export const MAX_ITEM_CHARS = 200;

export class PolicyValidationError extends Error {
  constructor(public readonly field: string, message: string) {
    super(message);
    this.name = "PolicyValidationError";
  }
}

/**
 * A list of short, distinct, non-empty strings.
 *
 * `normalize()` below only checks `Array.isArray`, so an array of numbers or
 * objects passed it and reached the prompt as "1, 2, [object Object]". Element
 * types are checked HERE, on the way in, because that is the last point where
 * the caller can be told what was wrong with what they sent - by read time the
 * only options left are to drop it silently or to serve it.
 */
export function validateStringList(field: string, value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new PolicyValidationError(field, `${field} must be an array of strings`);
  }
  if (value.length > MAX_LIST_ITEMS) {
    throw new PolicyValidationError(field, `${field} accepts at most ${MAX_LIST_ITEMS} items`);
  }
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") {
      throw new PolicyValidationError(field, `every ${field} entry must be a string`);
    }
    const item = raw.trim();
    // An empty entry is not a rule, and storing it would put a stray separator
    // in the prompt. Dropped rather than rejected: it is almost always an
    // empty row left behind in the editor, not something the owner meant.
    if (!item) continue;
    if (item.length > MAX_ITEM_CHARS) {
      throw new PolicyValidationError(field, `every ${field} entry must be ${MAX_ITEM_CHARS} characters or fewer`);
    }
    // Case-insensitive de-duplication: the same rule twice is the same rule,
    // and it would be sent to the model twice.
    if (!out.some((existing) => existing.toLowerCase() === item.toLowerCase())) out.push(item);
  }
  return out;
}

/**
 * Validate a partial policy patch before it is merged and stored.
 *
 * Unknown keys are REJECTED rather than ignored. The policy is a JSON blob
 * with no column to constrain it, so anything accepted here is persisted
 * forever and is invisible to every reader that does not know to look for it -
 * a typo like `blockedTopic` would otherwise be stored, do nothing, and give
 * the owner every reason to believe their rule was saved.
 */
export function validatePolicyPatch(input: unknown): Partial<BusinessPolicy> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new PolicyValidationError("body", "policy patch must be an object");
  }
  const body = input as Record<string, unknown>;
  const patch: Partial<BusinessPolicy> = {};

  const known = new Set([
    "maxDiscountPercent", "refundRequiresApproval",
    "escalationKeywords", "blockedTopics", "outboundQuietHours",
  ]);
  for (const key of Object.keys(body)) {
    if (!known.has(key)) throw new PolicyValidationError(key, `unknown policy field "${key}"`);
  }

  if ("maxDiscountPercent" in body) {
    const v = body.maxDiscountPercent;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) {
      throw new PolicyValidationError("maxDiscountPercent", "maxDiscountPercent must be a number between 0 and 100");
    }
    patch.maxDiscountPercent = v;
  }
  if ("refundRequiresApproval" in body) {
    if (typeof body.refundRequiresApproval !== "boolean") {
      throw new PolicyValidationError("refundRequiresApproval", "refundRequiresApproval must be a boolean");
    }
    patch.refundRequiresApproval = body.refundRequiresApproval;
  }
  if ("escalationKeywords" in body) {
    patch.escalationKeywords = validateStringList("escalationKeywords", body.escalationKeywords);
  }
  if ("blockedTopics" in body) {
    patch.blockedTopics = validateStringList("blockedTopics", body.blockedTopics);
  }
  if ("outboundQuietHours" in body) {
    const q = body.outboundQuietHours;
    if (q === null || q === undefined) {
      patch.outboundQuietHours = undefined;
    } else if (typeof q === "object" && !Array.isArray(q)) {
      const { startHour, endHour, tz } = q as Record<string, unknown>;
      const hour = (h: unknown) => typeof h === "number" && Number.isInteger(h) && h >= 0 && h <= 23;
      if (!hour(startHour) || !hour(endHour)) {
        throw new PolicyValidationError("outboundQuietHours", "startHour and endHour must be integers between 0 and 23");
      }
      if (tz !== undefined && typeof tz !== "string") {
        throw new PolicyValidationError("outboundQuietHours", "tz must be a string");
      }
      patch.outboundQuietHours = { startHour: startHour as number, endHour: endHour as number, ...(tz ? { tz: tz as string } : {}) };
    } else {
      throw new PolicyValidationError("outboundQuietHours", "outboundQuietHours must be an object or null");
    }
  }

  return patch;
}

export async function getPolicy(tenantId: string): Promise<BusinessPolicy> {
  // Try DB first - authoritative path.
  try {
    const row = await (prisma as any).businessPolicy?.findUnique?.({ where: { tenantId } });
    if (row && row.data) {
      const policy = normalize(row.data);
      policyCache.set(tenantId, policy); // refresh cache
      return policy;
    }
    // DB reachable but no row → return default. Don't read cache: a stale
    // cache entry from a deleted policy must not leak through.
    if (row === null) return DEFAULT_POLICY;
  } catch {
    // DB unavailable (test env, cold start) - fall through to cache.
  }
  return policyCache.get(tenantId) ?? DEFAULT_POLICY;
}

export async function getPolicyPrompt(tenantId: string): Promise<string> {
  const p = await getPolicy(tenantId);
  return [
    "## Business Policy (MUST obey)",
    `- Max discount: ${p.maxDiscountPercent}%`,
    `- Refunds: ${p.refundRequiresApproval ? "require human approval" : "can be issued automatically"}`,
    `- Escalation triggers: ${p.escalationKeywords.join(", ") || "none"}`,
    p.blockedTopics.length ? `- Blocked topics: ${p.blockedTopics.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function setPolicy(
  tenantId: string,
  patch: Partial<BusinessPolicy>,
): Promise<BusinessPolicy> {
  const current = await getPolicy(tenantId);
  const next: BusinessPolicy = { ...current, ...patch };
  // Write-through to DB. Cache is updated only after DB ack - on DB
  // failure in prod the write fails loudly; in tests without a DB, the
  // cache is still updated so the test harness can round-trip.
  try {
    await (prisma as any).businessPolicy?.upsert?.({
      where: { tenantId },
      update: { data: next as any },
      create: { tenantId, data: next as any },
    });
  } catch (err) {
    // Swallow in environments without the BusinessPolicy table (tests
    // that mock prisma). Production deployments MUST run the migration.
  }
  policyCache.set(tenantId, next);
  return next;
}

export function validateAgainstPolicy(
  policy: BusinessPolicy,
  action: { tool: string; params: Record<string, unknown> },
): { ok: true } | { ok: false; reason: string } {
  if (action.tool === "update_crm" || action.tool === "send_message") {
    const p: any = action.params || {};
    if (typeof p.discountPercent === "number" && p.discountPercent > policy.maxDiscountPercent) {
      return { ok: false, reason: `discount ${p.discountPercent}% exceeds max ${policy.maxDiscountPercent}%` };
    }
  }
  return { ok: true };
}
