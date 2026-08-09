import { Router, Request, Response } from "express";
import {
  prisma,
  authenticate,
  resolveTenant,
  requireActiveTenant,
  requirePermissionOrRole,
  getDefaultHighRiskTools,
  writeAudit,
  AuditAction,
} from "@chatcenter/shared";
import { getAvailableTools, TOOL_REGISTRY } from "../services/tool-registry";
import { riskGroupFor, type RiskGroup } from "@chatcenter/shared";
import {
  capabilityStateFromConfig,
  missingScopesFromConfig,
  toolBlockedByMissingScopes,
  getAdapter,
} from "../services/connectors/integration-framework";
import { recordOperatorToolIntent } from "../services/tool-policy-intent.service";

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
  requirePermissionOrRole("ai:tools:read", "ADMIN"),
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
  /** Display grouping + policy floor. Computed from the canonical shared table. */
  riskGroup: RiskGroup;
  /**
   * The facts that decide whether the tool can run at all, sent so the UI can
   * name the REAL reason instead of rendering every block as an off switch. All
   * optional: an internal tool has no integration and no scopes, and absent
   * must mean "not blocking" rather than "blocked".
   */
  integration: string | null;
  integrationConnected?: boolean;
  requiredScopes?: string[];
  grantedScopes?: string[];
  /** Authoritative verdict from toolBlockedByMissingScopes - the runtime's own rule. */
  scopeBlocked?: boolean;
  /** Exactly which required scopes are known-missing. */
  missingScopes?: string[];
  hasCatalogEntry?: boolean;
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

    // Connection state and scope facts per integration slug, so the UI can say
    // "the integration is disconnected" or "this scope was never granted"
    // instead of showing an off switch the admin cannot fix.
    //
    // There is no `scopes` COLUMN on TenantIntegration - an earlier version of
    // this code selected one, which threw, was swallowed by the catch below, and
    // left every scope fact permanently undefined. The real sources are on
    // `config`:
    //   config.capabilityState.grantedScopes - what the provider says is granted
    //   config.missingScopes                 - the enforcement source the bot's
    //                                          tool surface already reads
    // Reading the same two the runtime reads is the point: a UI computing its
    // own answer here is how the screen ends up disagreeing with execution.
    const tenantIntegrations = await (prisma as any).tenantIntegration
      .findMany({
        where: { tenantId },
        select: {
          status: true,
          config: true,
          integration: { select: { slug: true, name: true } },
        },
      })
      .catch((err: any) => {
        // Loud, because silence here is what hid the original bug.
        console.error("[tool-permissions] integration lookup failed:", err?.message);
        return [] as any[];
      });

    const integrationBySlug = new Map<
      string,
      { connected: boolean; grantedScopes: string[]; missingScopes: string[]; name: string }
    >();
    for (const ti of tenantIntegrations as any[]) {
      const slug = ti.integration?.slug;
      if (!slug) continue;
      const cfg = (ti.config && typeof ti.config === "object" ? ti.config : {}) as Record<string, any>;
      integrationBySlug.set(slug, {
        connected: String(ti.status || "").toUpperCase() === "CONNECTED",
        grantedScopes: capabilityStateFromConfig(cfg).grantedScopes,
        missingScopes: missingScopesFromConfig(cfg),
        name: ti.integration?.name ?? slug,
      });
    }

    // Per-tool required scopes, from each adapter's own ToolDefinition. These
    // are declared in connector code (not on CatalogTool), and are the same
    // declarations `toolBlockedByMissingScopes` uses at the bot tool surface.
    const requiredScopesByTool = new Map<string, string[]>();
    const toolDefByName = new Map<string, any>();
    for (const slug of integrationBySlug.keys()) {
      const adapter = getAdapter(slug);
      if (!adapter?.tools) continue;
      try {
        for (const def of adapter.tools()) {
          if (!def?.name) continue;
          toolDefByName.set(def.name, def);
          if (def.requiredScopes?.length) requiredScopesByTool.set(def.name, def.requiredScopes);
        }
      } catch (err: any) {
        console.warn(`[tool-permissions] adapter ${slug} tools() failed:`, err?.message);
      }
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
          riskGroup: riskGroupFor(spec.name),
          integration: slug,
          // A tool whose provider we have no record of is not reported as
          // disconnected - we simply do not know, and guessing "broken" is its
          // own false statement.
          integrationConnected: integrationBySlug.has(slug)
            ? integrationBySlug.get(slug)!.connected
            : undefined,
          requiredScopes: requiredScopesByTool.get(spec.name),
          grantedScopes: integrationBySlug.get(slug)?.grantedScopes,
          // The authoritative scope verdict, from the SAME function the bot's
          // tool surface uses. Sent as a decided boolean rather than leaving the
          // UI to re-derive it from two scope lists, because a second derivation
          // is a second chance to disagree with the runtime.
          scopeBlocked: (() => {
            const def = toolDefByName.get(spec.name);
            const missing = integrationBySlug.get(slug)?.missingScopes ?? [];
            return def ? toolBlockedByMissingScopes(def, missing) : undefined;
          })(),
          missingScopes: (() => {
            const def = toolDefByName.get(spec.name);
            const missing = integrationBySlug.get(slug)?.missingScopes ?? [];
            if (!def?.requiredScopes?.length || !missing.length) return undefined;
            const hit = def.requiredScopes.filter((sc: string) => missing.includes(sc));
            return hit.length ? hit : undefined;
          })(),
          hasCatalogEntry: tenantToolBySlug.has(slug),
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
        riskGroup: riskGroupFor(spec.name),
        // Internal tools have no provider, so no connection or scope can block
        // them. Left undefined deliberately: absent means "not blocking".
        integration: null,
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

router.put("/:toolName", requirePermissionOrRole("ai:tools:manage", "ADMIN"), async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const toolName = req.params.toolName as string;

    // Validate tool exists in the effective registry. Prevents typo-induced
    // permission rows that never gate anything.
    const knownInternal = TOOL_REGISTRY.some((t) => t.name === toolName);
    // Two naming shapes reach this writer:
    //   integration.<slug>  - generic HTTP catalog tools
    //   <provider>.<slug>   - adapter-backed tools (shopify.cancel_order, ...)
    // The second was rejected as unknown, which meant every Shopify tool was
    // unsettable. Both resolve to the same CatalogTool by slug.
    const dotted = /^[a-z0-9_]+\.[a-z0-9_]+$/.test(toolName);
    const isIntegration = toolName.startsWith("integration.") || (dotted && !knownInternal);
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
      // `integration.<slug>` and `<provider>.<slug>` both key on the slug.
      const slug = toolName.slice(toolName.indexOf(".") + 1);
      let tenantTool = await (prisma as any).tenantTool.findFirst({
        where: { tenantId, catalogTool: { slug } },
        select: { id: true, configOverrides: true },
      });

      // PROVISION ON FIRST POLICY SET.
      //
      // Connecting an integration only ever provisions its READ tools - writes
      // like cancel_order and process_refund are deliberately never
      // auto-granted. That left them permanently unsettable: no row, so this
      // returned 404, so an admin could not turn them on even deliberately.
      //
      // Creating the row here preserves the invariant that matters (a write is
      // never granted without a human act) while making the act possible. A
      // request that only DISABLES a tool provisions nothing: there is no point
      // writing a row to record "off" when absent already means off.
      if (!tenantTool) {
        const disablingOnly = enabled === false;
        if (disablingOnly) {
          res.json({ data: { toolName, provisioned: false, note: "already disabled - nothing to store" } });
          return;
        }
        const catalogTool = await (prisma as any).catalogTool.findFirst({
          where: { slug },
          select: { id: true, integrationId: true },
        });
        if (!catalogTool) {
          res.status(404).json({ error: `unknown catalog tool "${slug}"` });
          return;
        }
        // Must be a CONNECTED connection for THIS tenant - never provision a
        // tool against a provider the tenant has not connected.
        const conn = await (prisma as any).tenantIntegration.findFirst({
          where: { tenantId, integrationId: catalogTool.integrationId, status: "CONNECTED" },
          select: { id: true },
        });
        if (!conn) {
          res.status(409).json({ error: `integration for "${slug}" is not connected` });
          return;
        }
        const created = await (prisma as any).tenantTool.create({
          data: {
            tenantId,
            tenantIntegrationId: conn.id,
            catalogToolId: catalogTool.id,
            isEnabled: true,
            configOverrides: {},
          },
          select: { id: true, configOverrides: true },
        });
        tenantTool = created;
        void writeAudit({
          tenantId,
          actorType: "user",
          actorId: (req as any).user?.userId,
          action: AuditAction.PERMISSION_CHANGED,
          targetType: "tenant_tool",
          targetId: created.id,
          metadata: { tool: slug, provisionedOnFirstPolicySet: true },
        });
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

      // The same decision, recorded somewhere the connection cannot take with
      // it. The row above is what the gate reads and it hangs off
      // TenantIntegration, so it dies with the connection - which is how an
      // operator who disabled `process_refund`, disconnected to re-grant OAuth
      // scopes and reconnected got the tool back enabled. Their decision was
      // never overridden; the record of it was deleted, and provisioning fell
      // back to a catalogue default nobody chose.
      //
      // Both are written, each for what it is good at: TenantTool is the live
      // policy, TenantToolPermission is the DECISION, and reconnect restores
      // the first from the second.
      await recordOperatorToolIntent({
        tenantId,
        catalogToolSlug: slug,
        actorId: (req as any).userId ?? null,
        enabled: typeof enabled === "boolean" ? enabled : undefined,
        requiresApproval: typeof requiresApproval === "boolean" ? requiresApproval : undefined,
        approverRole: approverRole === null || typeof approverRole === "string" ? approverRole : undefined,
        expiresAfterMin: typeof expiresAfterMin === "number" ? expiresAfterMin : undefined,
        allowModification: typeof allowModification === "boolean" ? allowModification : undefined,
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
