import { Router, Request, Response } from "express";
import {
  prisma,
  authenticate,
  resolveTenant,
  requireActiveTenant,
  requireRole,
  getDefaultHighRiskTools,
} from "@chatcenter/shared";
import { getAvailableTools, TOOL_REGISTRY } from "../services/tool-registry";

/**
 * F4/F8 — Per-tenant tool permissions (HITL + enable/disable).
 *
 * GET  /api/tool-permissions            → list every tool visible to this
 *                                         tenant (internal registry +
 *                                         integration tools) merged with
 *                                         the explicit TenantToolPermission
 *                                         row if any.
 * PUT  /api/tool-permissions/:toolName  → upsert the tenant override.
 *
 * Defaults: tools with no row fall back to tool-gate's
 * INTERNAL_HIGH_RISK_DEFAULTS set (requiresApproval=true, enabled=true)
 * for destructive operations. The UI renders this merged view so the
 * admin always sees the effective gate.
 */

const router = Router();

router.use(
  authenticate,
  resolveTenant,
  requireActiveTenant(),
  requireRole("ADMIN"),
);

interface MergedToolRow {
  toolName: string;
  kind: "system" | "action" | "integration";
  category: string;
  description: string;
  enabled: boolean;
  requiresApproval: boolean;
  isDefault: boolean; // true when no explicit row exists
  approverRole: string | null;
  expiresAfterMin: number;
  allowModification: boolean;
  updatedAt: string | null;
}

router.get("/", async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;

    const [available, permissions] = await Promise.all([
      getAvailableTools(tenantId),
      (prisma as any).tenantToolPermission.findMany({
        where: { tenantId },
      }),
    ]);

    const permByName = new Map<string, any>();
    for (const p of permissions) permByName.set(p.toolName, p);

    const defaultHighRisk = new Set(getDefaultHighRiskTools());

    const merged: MergedToolRow[] = [];

    const push = (spec: {
      name: string;
      kind: "system" | "action" | "integration";
      category: string;
      description: string;
    }) => {
      const row = permByName.get(spec.name);
      merged.push({
        toolName: spec.name,
        kind: spec.kind,
        category: spec.category,
        description: spec.description,
        enabled: row ? row.enabled : true,
        requiresApproval: row
          ? row.requiresApproval
          : defaultHighRisk.has(spec.name),
        isDefault: !row,
        approverRole: row?.approverRole ?? null,
        expiresAfterMin: row?.expiresAfterMin ?? 30,
        allowModification: row?.allowModification ?? false,
        updatedAt: row?.updatedAt?.toISOString?.() ?? null,
      });
    };

    for (const spec of available.systemTools) push(spec);
    for (const spec of available.actionTools) push(spec);
    for (const spec of available.integrationTools) push(spec);

    // Sort: action first (most important), then integration, then system.
    const kindOrder = { action: 0, integration: 1, system: 2 } as const;
    merged.sort((a, b) => {
      if (kindOrder[a.kind] !== kindOrder[b.kind]) {
        return kindOrder[a.kind] - kindOrder[b.kind];
      }
      return a.toolName.localeCompare(b.toolName);
    });

    res.json({ data: merged });
  } catch (err: any) {
    console.error("List tool permissions error:", err);
    res.status(500).json({ error: "Failed to list tool permissions" });
  }
});

router.put("/:toolName", async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const toolName = req.params.toolName as string;

    // Validate tool exists in the effective registry. Prevents typo-induced
    // permission rows that never gate anything.
    const knownInternal = TOOL_REGISTRY.some((t) => t.name === toolName);
    const isIntegration = toolName.startsWith("integration.");
    if (!knownInternal && !isIntegration) {
      res.status(400).json({ error: `unknown tool "${toolName}"` });
      return;
    }

    const { enabled, requiresApproval, approverRole, expiresAfterMin, allowModification } =
      req.body ?? {};

    const patch: Record<string, unknown> = {};
    if (typeof enabled === "boolean") patch.enabled = enabled;
    if (typeof requiresApproval === "boolean") patch.requiresApproval = requiresApproval;
    if (approverRole === null || typeof approverRole === "string")
      patch.approverRole = approverRole;
    if (typeof expiresAfterMin === "number") patch.expiresAfterMin = expiresAfterMin;
    if (typeof allowModification === "boolean") patch.allowModification = allowModification;

    const actorId = (req as any).userId ?? null;
    patch.updatedBy = actorId;

    const row = await (prisma as any).tenantToolPermission.upsert({
      where: { tenantId_toolName: { tenantId, toolName } },
      update: patch,
      create: {
        tenantId,
        toolName,
        enabled: typeof enabled === "boolean" ? enabled : true,
        requiresApproval:
          typeof requiresApproval === "boolean" ? requiresApproval : false,
        approverRole: typeof approverRole === "string" ? approverRole : null,
        expiresAfterMin: typeof expiresAfterMin === "number" ? expiresAfterMin : 30,
        allowModification:
          typeof allowModification === "boolean" ? allowModification : false,
        updatedBy: actorId,
      },
    });

    res.json({ data: row });
  } catch (err: any) {
    console.error("Upsert tool permission error:", err);
    res.status(500).json({ error: "Failed to save tool permission" });
  }
});

export default router;
