/**
 * F8 — Business Policy Engine
 *
 * Central policy layer. Every AI call can (and should) inject the active
 * policy into its system prompt via `getPolicyPrompt(tenantId)`. Enforcement
 * happens at two points: prompt injection (soft) and action-executor risk
 * gate (hard — see action-executor.service.ts).
 *
 * Per CLAUDE.md, business rules live in services, not in AI. This file only
 * reads/validates policy; it does not store it — source of truth is either
 * env-based defaults or the tenant-scoped policy document in Tenant.metadata.
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

export async function getPolicy(tenantId: string): Promise<BusinessPolicy> {
  try {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    const raw = (tenant as any)?.metadata?.policy;
    if (raw && typeof raw === "object") {
      return { ...DEFAULT_POLICY, ...raw };
    }
  } catch (err) {
    console.error("policy.getPolicy error:", err);
  }
  return DEFAULT_POLICY;
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
