/**
 * Who is allowed to decide an approval out-of-band, and may they decide THIS one.
 *
 * Two call sites, deliberately sharing one implementation:
 *   • send time  - pick the recipient to notify;
 *   • decide time - re-authorise the tapper before anything executes.
 *
 * Re-authorising at decision time is the point. A notification is a message
 * sitting on a phone: by the time the button is tapped the person may have
 * been removed from the tenant, demoted, or had the recipient row disabled.
 * The button proves only that *someone holding that phone* tapped it.
 */

import { prisma } from "./prisma";
import { hasPermission } from "./permissions";

export type RecipientRejection =
  | "not_configured"      // no ApprovalRecipient row for this tenant
  | "disabled"            // row exists but switched off
  | "no_phone"            // row exists but the number is unusable
  | "membership_inactive" // user is no longer an active member of the tenant
  | "not_authorized"      // membership lacks the permission to approve
  | "risk_too_high";      // action exceeds what may be decided from a phone

export interface EligibleRecipient {
  userId: string;
  phoneE164: string;
  name: string | null;
  maxRiskLevel: string;
}

const RISK_ORDER: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };

/** The permission a membership must hold to decide an approval. */
const APPROVAL_PERMISSION = "approvals:requests:approve";

/**
 * Resolve the recipient to notify for a tenant, or the reason there isn't one.
 *
 * NEVER falls back to "the owner" or "any admin". An implicit fallback would
 * route a financial approval to whoever happens to be an admin - exactly the
 * person who may not be authorised to make that call.
 */
export async function resolveApprovalRecipient(
  tenantId: string,
  opts: { riskLevel?: string; channel?: string } = {},
): Promise<{ ok: true; recipient: EligibleRecipient } | { ok: false; reason: RecipientRejection }> {
  const channel = opts.channel ?? "whatsapp";
  const row = await (prisma as any).approvalRecipient.findFirst({
    where: { tenantId, channel },
    include: { user: { select: { id: true, name: true, isActive: true, tenantId: true, role: true } } },
  });

  if (!row) return { ok: false, reason: "not_configured" };
  if (!row.enabled) return { ok: false, reason: "disabled" };
  if (!row.phoneE164) return { ok: false, reason: "no_phone" };
  // The membership must still belong to THIS tenant and still be active.
  if (!row.user || !row.user.isActive || row.user.tenantId !== tenantId) {
    return { ok: false, reason: "membership_inactive" };
  }

  const authorized = await userMayApprove(tenantId, row.user.id);
  if (!authorized) return { ok: false, reason: "not_authorized" };

  // High-risk actions can be held back from one-tap approval entirely; the
  // manager is pointed at the web UI instead (see the "Open in GOTCHA" path).
  const requested = RISK_ORDER[String(opts.riskLevel ?? "medium").toLowerCase()] ?? 2;
  const allowed = RISK_ORDER[String(row.maxRiskLevel ?? "medium").toLowerCase()] ?? 2;
  if (requested > allowed) return { ok: false, reason: "risk_too_high" };

  return {
    ok: true,
    recipient: {
      userId: row.user.id,
      phoneE164: row.phoneE164,
      name: row.user.name ?? null,
      maxRiskLevel: row.maxRiskLevel,
    },
  };
}

/**
 * May this membership decide approvals right now?
 *
 * Called again at decision time - see the module header. Falls back to the
 * coarse role when the fine-grained permission is not licensed for the tenant,
 * matching how the rest of the app resolves authority.
 */
export async function userMayApprove(tenantId: string, userId: string): Promise<boolean> {
  const user = await prisma.user.findFirst({
    where: { id: userId, tenantId, isActive: true },
    select: { id: true, role: true, tenantId: true },
  });
  if (!user) return false;

  try {
    const allowed = await hasPermission({ id: user.id, tenantId, role: user.role } as any, APPROVAL_PERMISSION);
    if (allowed) return true;
  } catch {
    /* permission layer unavailable - fall through to the role check */
  }
  // Role fallback: ADMIN/SYSTEM_ADMIN may approve on tenants where the
  // fine-grained permission set is not licensed.
  return user.role === "ADMIN" || user.role === "SYSTEM_ADMIN";
}

/** Operator-facing explanation for a skipped notification. */
export function recipientRejectionMessage(reason: RecipientRejection): string {
  switch (reason) {
    case "not_configured":
      return "No WhatsApp approver is configured for this workspace. Add one in Settings → Approvals to get approval requests on WhatsApp.";
    case "disabled":
      return "WhatsApp approval notifications are turned off for this workspace.";
    case "no_phone":
      return "The configured approver has no valid phone number. Add one in Settings → Approvals.";
    case "membership_inactive":
      return "The configured approver is no longer an active member of this workspace.";
    case "not_authorized":
      return "The configured approver does not have permission to approve actions.";
    case "risk_too_high":
      return "This action is above the risk level allowed for one-tap approval - decide it in GOTCHA.";
  }
}
