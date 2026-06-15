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
 * F4/F8 - Per-tenant tool permissions (HITL + enable/disable).
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

    const [available, permissions, tenantTools] = await Promise.all([
      getAvailableTools(tenantId),
      (prisma as any).tenantToolPermission.findMany({
        where: { tenantId },
      }),
      // Integration tools (CatalogTool-backed) read their HITL state from
      // TenantTool.configOverrides.hitlPolicy and seed from CatalogTool.hitlPolicy.
      (prisma as any).tenantTool.findMany({
        where: { tenantId },
        include: { catalogTool: { select: { slug: true, hitlPolicy: true } } },
      }),
    ]);

    const permByName = new Map<string, any>();
    for (const p of permissions) permByName.set(p.toolName, p);

    // Build slug → { catalog hitl, tenant override hitl, updatedAt } lookup.
    const tenantToolBySlug = new Map<string, { catalogMode: string; overrideMode: string | null; updatedAt: Date | null }>();
    for (const tt of tenantTools as any[]) {
      const slug = tt.catalogTool?.slug;
      if (!slug) continue;
      const catalogMode = (tt.catalogTool?.hitlPolicy as any)?.mode || "never";
      const overrideMode =
        (tt.configOverrides as any)?.hitlPolicy?.mode ?? null;
      tenantToolBySlug.set(slug, {
        catalogMode,
        overrideMode,
        updatedAt: tt.updatedAt ?? null,
      });
    }

    const defaultHighRisk = new Set(getDefaultHighRiskTools());

    const merged: MergedToolRow[] = [];

    const push = (spec: {
      name: string;
      kind: "system" | "action" | "integration";
      category: string;
      description: string;
    }) => {
      // Integration tools (`integration.<slug>`) get their HITL state from
      // TenantTool.configOverrides + CatalogTool seed. Static tools get it
      // from TenantToolPermission + SYSTEM_TOOL_POLICIES seed.
      if (spec.kind === "integration") {
        const slug = spec.name.replace(/^integration\./, "");
        const tt = tenantToolBySlug.get(slug);
        const overrideMode = tt?.overrideMode ?? null;
        const catalogMode = tt?.catalogMode ?? "never";
        const requiresApproval =
          overrideMode != null ? overrideMode === "always" : catalogMode === "always";
        merged.push({
          toolName: spec.name,
          kind: spec.kind,
          category: spec.category,
          description: spec.description,
          enabled: true, // integration tool surface follows TenantTool.isEnabled (already filtered by getAvailableTools)
          requiresApproval,
          isDefault: overrideMode == null,
          approverRole: null,
          expiresAfterMin: 30,
          allowModification: false,
          updatedAt: tt?.updatedAt ? tt.updatedAt.toISOString() : null,
        });
        return;
      }

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

    // Read-only system tools (get_conversation, list_recent_messages, …) are
    // pre-resolved context gatherers - they never mutate state, so they have
    // no HITL meaning. Exclude them from the settings page.
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

    // Integration tools store their HITL override on TenantTool.configOverrides.hitlPolicy -
    // that's where the gate reads it from. Writing to TenantToolPermission for an
    // integration tool would silently no-op against the gate.
    if (isIntegration) {
      const slug = toolName.replace(/^integration\./, "");
      const tenantTool = await (prisma as any).tenantTool.findFirst({
        where: { tenantId, catalogTool: { slug } },
        select: { id: true, configOverrides: true },
      });
      if (!tenantTool) {
        res.status(404).json({ error: `integration tool "${slug}" not configured for tenant` });
        return;
      }
      const existingOverrides =
        (tenantTool.configOverrides as Record<string, unknown> | null) ?? {};
      const nextOverrides: Record<string, unknown> = { ...existingOverrides };
      if (typeof requiresApproval === "boolean") {
        nextOverrides.hitlPolicy = {
          mode: requiresApproval ? "always" : "never",
          ...(typeof approverRole === "string" ? { approverRole } : {}),
          ...(typeof expiresAfterMin === "number" ? { expiresAfterMin } : {}),
          ...(typeof allowModification === "boolean" ? { allowModification } : {}),
        };
      }
      const tenantToolPatch: Record<string, unknown> = { configOverrides: nextOverrides };
      if (typeof enabled === "boolean") tenantToolPatch.isEnabled = enabled;
      const updated = await (prisma as any).tenantTool.update({
        where: { id: tenantTool.id },
        data: tenantToolPatch,
      });
      res.json({ data: updated });
      return;
    }

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
