import { Router, Request, Response } from "express";
import {
  prisma,
  authenticate,
  resolveTenant,
  requireActiveTenant,
  requirePermissionOrRole,
  evaluateBusinessPolicy,
  type BusinessActionKind,
} from "@chatcenter/shared";

/**
 * Tenant Business Rules for sensitive AI actions (refunds, cancellations,
 * coupons/compensation, customer-data writes).
 *
 * The AI never enforces these - packages/shared/lib/business-policy.ts does,
 * deterministically, at offer / HITL-creation / pre-execution. This surface
 * only lets the business OWNER author them, in business language, without
 * touching prompts or code.
 *
 *   GET  /api/business-policies                 → active version per action kind
 *   PUT  /api/business-policies/:actionKind     → writes a NEW version (immutable history)
 *   POST /api/business-policies/:actionKind/preview → dry-run a sample scenario
 *
 * Versioning: an update never mutates the deciding row of any historical
 * PolicyDecision - it appends version+1 and the engine reads the latest.
 */
// Authorization chain: identity (authenticate, Authentik JWT) → ACTIVE
// membership + tenant (resolveTenant validates the X-Tenant-Id hint against
// the caller's memberships; requireActiveTenant blocks suspended tenants) →
// PERMISSION. Gates are permission-FIRST (settings:business-policies:*) with
// the transitional admin-role fallback shared by all settings surfaces, so a
// tenant can delegate policy management to a finance lead without full admin
// while legacy-licensed tenants keep working. Every query below is scoped by
// req.tenantId - the membership-validated tenant, never a client-supplied id.
const router = Router();
router.use(authenticate, resolveTenant, requireActiveTenant());

const canRead = requirePermissionOrRole("settings:business-policies:read", "ADMIN", "SYSTEM_ADMIN");
const canManage = requirePermissionOrRole("settings:business-policies:manage", "ADMIN", "SYSTEM_ADMIN");
const canPreview = requirePermissionOrRole("settings:business-policies:preview", "ADMIN", "SYSTEM_ADMIN");

const ACTION_KINDS: BusinessActionKind[] = [
  "REFUND", "CANCEL_ORDER", "COUPON", "COMPENSATION", "DISCOUNT", "CUSTOMER_WRITE",
];

const CONFIG_KEYS = new Set([
  "approvedReasons", "requireEvidenceFor", "maxAmount", "maxPercentOfOrder",
  "perCustomerWindowDays", "perCustomerMaxEvents", "preventDuplicatePerIncident",
  "managerApprovalAboveAmount", "prohibitedTypes", "preferredLadder", "allowOverride",
]);

function sanitizeConfig(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!CONFIG_KEYS.has(k)) continue;
    if (["maxAmount", "maxPercentOfOrder", "perCustomerWindowDays", "perCustomerMaxEvents", "managerApprovalAboveAmount"].includes(k)) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) out[k] = n;
    } else if (["preventDuplicatePerIncident", "allowOverride"].includes(k)) {
      out[k] = !!v;
    } else if (Array.isArray(v)) {
      out[k] = v.filter((s) => typeof s === "string" && s.length > 0).slice(0, 50);
    }
  }
  return out;
}

router.get("/", canRead, async (req: Request, res: Response) => {
  try {
    const rows = await (prisma as any).businessActionPolicy.findMany({
      where: { tenantId: req.tenantId! },
      orderBy: [{ actionKind: "asc" }, { version: "desc" }],
    });
    // Latest version per kind only - history stays queryable via the DB.
    const latest = new Map<string, any>();
    for (const r of rows) if (!latest.has(r.actionKind)) latest.set(r.actionKind, r);
    res.json({ data: { actionKinds: ACTION_KINDS, policies: [...latest.values()] } });
  } catch (err: any) {
    console.error("business-policies.list error:", err?.message);
    res.status(500).json({ error: "Failed to load business policies" });
  }
});

router.put("/:actionKind", canManage, async (req: Request, res: Response) => {
  try {
    const actionKind = String(req.params.actionKind).toUpperCase();
    if (!ACTION_KINDS.includes(actionKind as BusinessActionKind)) {
      return res.status(400).json({ error: `unknown action kind "${actionKind}"` });
    }
    const enabled = req.body?.enabled !== false;
    const config = sanitizeConfig(req.body?.config);
    const prev = await (prisma as any).businessActionPolicy.findFirst({
      where: { tenantId: req.tenantId!, actionKind },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    const created = await (prisma as any).businessActionPolicy.create({
      data: {
        tenantId: req.tenantId!,
        actionKind,
        enabled,
        version: (prev?.version ?? 0) + 1,
        config,
        createdBy: (req as any).user?.userId ?? (req as any).user?.id ?? null,
      },
    });
    return res.json({ data: created });
  } catch (err: any) {
    console.error("business-policies.put error:", err?.message);
    return res.status(500).json({ error: "Failed to save business policy" });
  }
});

// Dry-run a sample scenario against the ACTIVE policy - powers the settings
// UI "test this rule" box. Records a PolicyDecision like any evaluation (the
// evaluationPoint makes clear it was a preview via correlationId prefix).
router.post("/:actionKind/preview", canPreview, async (req: Request, res: Response) => {
  try {
    const actionKind = String(req.params.actionKind).toUpperCase();
    if (!ACTION_KINDS.includes(actionKind as BusinessActionKind)) {
      return res.status(400).json({ error: `unknown action kind "${actionKind}"` });
    }
    const f = req.body?.facts ?? {};
    const result = await evaluateBusinessPolicy({
      tenantId: req.tenantId!,
      actionKind: actionKind as BusinessActionKind,
      evaluationPoint: "OFFER",
      correlationId: "preview",
      facts: {
        reasonCode: typeof f.reasonCode === "string" ? f.reasonCode : undefined,
        requestedAmount: Number.isFinite(Number(f.requestedAmount)) ? Number(f.requestedAmount) : undefined,
        orderAmount: Number.isFinite(Number(f.orderAmount)) ? Number(f.orderAmount) : undefined,
        requestedType: typeof f.requestedType === "string" ? f.requestedType : undefined,
        priorCompensationForIncident: Number.isFinite(Number(f.priorCompensationForIncident)) ? Number(f.priorCompensationForIncident) : undefined,
        evidence: f.evidence && typeof f.evidence === "object" ? f.evidence : undefined,
      },
    });
    return res.json({ data: result });
  } catch (err: any) {
    console.error("business-policies.preview error:", err?.message);
    return res.status(500).json({ error: "Failed to preview policy" });
  }
});

export default router;
