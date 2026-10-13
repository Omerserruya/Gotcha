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
import { getAvailableTools, getGovernableIntegrationTools, TOOL_REGISTRY } from "../services/tool-registry";
import {
  riskGroupFor,
  mayBeAlwaysAllowed,
  isHighRiskGroup,
  highRiskAutoRunPermitted,
  type RiskGroup,
} from "@chatcenter/shared";
import {
  capabilityStateFromConfig,
  missingScopesFromConfig,
  toolBlockedByMissingScopes,
} from "../services/connectors/integration-framework";

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

/** A tool's approval setting as a person reads it, for the audit's before and after. */
type ApprovalMode = "ask" | "execute" | "conditional";
function approvalModeOf(hitlMode: string): ApprovalMode {
  return hitlMode === "always" ? "ask" : hitlMode === "on_condition" ? "conditional" : "execute";
}

router.use(
  authenticate,
  resolveTenant,
  requireActiveTenant(),
  requirePermissionOrRole("ai:tools:read", "ADMIN"),
);

export interface MergedToolRow {
  toolName: string;
  kind: "system" | "action" | "integration";
  /** Static tools: the registry category. Integration tools: the catalogue ToolCategory, or null. */
  category: string | null;
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
   * May this row be set to run without approval? The PUT's own answer, so the
   * screen offers exactly what the server accepts (false only for delete,
   * financial and administrative tools while HIGH_RISK_AUTORUN=off).
   */
  autoRunAllowed: boolean;
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
  /**
   * Integration rows only. `not_provisioned` is a catalogue action with no
   * TenantTool row yet: it is settable (the PUT provisions it on a CONNECTED
   * integration), it just has nothing stored.
   */
  state?: "enabled" | "disabled" | "not_provisioned";
  /** TenantIntegration.status - an ERROR connection still lists its tools. */
  integrationStatus?: string;
  catalogToolId?: string;
  /** Catalogue risk level (LOW/MEDIUM/HIGH). */
  riskLevel?: string | null;
}

/**
 * Every tool this workspace has, with its workspace level and what blocks it.
 * The list route's rows, and the source of each tool's workspace level for an
 * AI employee's own levels (ai-agents GET /:id/tools).
 */
export async function listWorkspaceTools(tenantId: string): Promise<MergedToolRow[]> {

  const [available, permissions, governable] = await Promise.all([
    getAvailableTools(tenantId),
    (prisma as any).tenantToolPermission.findMany({
      where: { tenantId },
    }),
    // Every catalogue action of every connection, provisioned or not, keyed
    // by catalog row. This used to be TenantTool rows keyed by bare slug,
    // which (a) hid everything behind a non-CONNECTED integration and (b)
    // let two providers sharing a slug (stripe/paypal create_payment_link)
    // overwrite each other's displayed policy.
    getGovernableIntegrationTools(tenantId, { includeDisconnected: true }),
  ]);

  const permByName = new Map<string, any>();
  for (const p of permissions) permByName.set(p.toolName, p);

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
    // Several rows per provider exist (three Shopify rows for one dev
    // tenant); a CONNECTED one must not be shadowed by a broken sibling.
    if (integrationBySlug.get(slug)?.connected) continue;
    const cfg = (ti.config && typeof ti.config === "object" ? ti.config : {}) as Record<string, any>;
    integrationBySlug.set(slug, {
      connected: String(ti.status || "").toUpperCase() === "CONNECTED",
      grantedScopes: capabilityStateFromConfig(cfg).grantedScopes,
      missingScopes: missingScopesFromConfig(cfg),
      name: ti.integration?.name ?? slug,
    });
  }

  const defaultHighRisk = new Set(getDefaultHighRiskTools());
  const highRiskOpen = highRiskAutoRunPermitted();

  const merged: MergedToolRow[] = [];

  const push = (spec: {
    name: string;
    kind: "system" | "action";
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
      riskGroup: riskGroupFor(spec.name),
      autoRunAllowed: mayBeAlwaysAllowed(riskGroupFor(spec.name), highRiskOpen),
      // Internal tools have no provider, so no connection or scope can block
      // them. Left undefined deliberately: absent means "not blocking".
      integration: null,
    });
  };

  // Read-only system tools (get_conversation, list_recent_messages, …) are
  // pre-resolved context gatherers - they never mutate state, so they have
  // no HITL meaning. Exclude them from the settings page.
  for (const spec of available.actionTools) push(spec as any);

  // A bare `integration.<slug>` is ambiguous when two of this tenant's
  // providers share the slug; name those rows `<provider>.<slug>` so the
  // PUT that echoes the name back resolves to exactly one catalog row.
  const httpSlugCount = new Map<string, number>();
  for (const g of governable) {
    if (g.name.startsWith("integration.")) httpSlugCount.set(g.slug, (httpSlugCount.get(g.slug) ?? 0) + 1);
  }
  for (const g of governable) {
    const toolName =
      g.name.startsWith("integration.") && (httpSlugCount.get(g.slug) ?? 0) > 1
        ? `${g.integrationSlug}.${g.slug}`
        : g.name;
    const conn = integrationBySlug.get(g.integrationSlug);
    const missing = conn?.missingScopes ?? [];
    const missingHit = g.requiredScopes.filter((sc) => missing.includes(sc));
    merged.push({
      toolName,
      kind: "integration",
      // The catalogue's own ToolCategory (READ | WRITE | DELETE | ACTION).
      // This was a hard-coded "meta" on every integration row, which a screen
      // grouping by category rendered under the wrong heading. Null when the
      // catalogue row has none - not a borrowed label.
      category: g.catalogCategory,
      description: g.description || g.displayName,
      // Effective state, not a placeholder: an unprovisioned action is off
      // until a policy is chosen for it.
      enabled: g.provisioned && g.isEnabled,
      requiresApproval: (g.overrideHitlMode ?? g.catalogHitlMode) === "always",
      isDefault: g.overrideHitlMode == null,
      approverRole: null,
      expiresAfterMin: 30,
      allowModification: false,
      updatedAt: g.updatedAt,
      riskGroup: riskGroupFor(toolName),
      autoRunAllowed: mayBeAlwaysAllowed(riskGroupFor(toolName), highRiskOpen),
      integration: g.integrationSlug,
      integrationConnected: conn ? conn.connected : undefined,
      requiredScopes: g.requiredScopes.length ? g.requiredScopes : undefined,
      grantedScopes: conn?.grantedScopes,
      scopeBlocked: toolBlockedByMissingScopes({ name: toolName, requiredScopes: g.requiredScopes } as any, missing),
      missingScopes: missingHit.length ? missingHit : undefined,
      hasCatalogEntry: true,
      state: !g.provisioned ? "not_provisioned" : g.isEnabled ? "enabled" : "disabled",
      integrationStatus: g.integrationStatus,
      catalogToolId: g.catalogToolId,
      riskLevel: g.riskLevel,
    });
  }

  // Sort: action first (most important), then integration, then system.
  const kindOrder = { action: 0, integration: 1, system: 2 } as const;
  merged.sort((a, b) => {
    if (kindOrder[a.kind] !== kindOrder[b.kind]) {
      return kindOrder[a.kind] - kindOrder[b.kind];
    }
    return a.toolName.localeCompare(b.toolName);
  });

  return merged;
}

router.get("/", async (req: Request, res: Response) => {
  try {
    const merged = await listWorkspaceTools(req.tenantId!);
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
    // unsettable. Both resolve to ONE CatalogTool via resolveCatalogTool,
    // scoped to the provider - never by bare slug.
    const dotted = /^[a-z0-9_]+\.[a-z0-9_]+$/.test(toolName);
    const isIntegration = toolName.startsWith("integration.") || (dotted && !knownInternal);
    if (!knownInternal && !isIntegration) {
      res.status(400).json({ error: `unknown tool "${toolName}"` });
      return;
    }

    const { enabled, requiresApproval, approverRole, expiresAfterMin, allowModification } =
      req.body ?? {};

    /**
     * ★ THE RISK CEILING, ENFORCED HERE BECAUSE THIS IS WHERE IT IS DECIDED.
     *
     * `mayBeAlwaysAllowed` existed in the shared lib and this write path never
     * called it - so `requiresApproval: false` on `shopify.process_refund` was
     * stored on request. The screen offers the choice only for low-risk actions,
     * but a UI-only guard is one anybody with curl steps over, and this is the
     * endpoint that decides whether money can move with nobody watching.
     *
     * Placed BEFORE the integration/static branch on purpose. There are TWO
     * writers below and the same request body drives both - integration tools
     * write `configOverrides.hitlPolicy.mode = "never"` on TenantTool, static
     * tools write `requiresApproval` on TenantToolPermission. Guarding one would
     * have left the other, and the second is the one nobody remembers.
     *
     * `NEVER_AUTO_APPROVE` is {delete, financial, administrative}, and its own
     * comment is the reason: "the default answer for irreversible and
     * money-moving operations is no: the cost of a wrong always-allow there is a
     * refund nobody authorised."
     *
     * ── Now a choice, not a wall (Omer, 2026-10-12) ──
     *
     * A workspace may set these groups to run without approval too. This PUT
     * is the one explicit, per-tool choice that can do it: the default stays
     * "Ask me", the bulk migration still never removes approval, and every
     * change here is audited with who, tool, before and after.
     * `HIGH_RISK_AUTORUN=off` restores the hard block below.
     */
    const riskGroup = riskGroupFor(toolName);
    if (requiresApproval === false && !mayBeAlwaysAllowed(riskGroup, highRiskAutoRunPermitted())) {
      res.status(422).json({
        error: "approval_cannot_be_removed",
        riskGroup,
        // A reason the screen can render, not a bare refusal.
        message:
          `"${toolName}" is classified ${riskGroup}. Approval cannot be removed for irreversible or money-moving actions.`,
      });
      return;
    }
    const actorId: string | null = (req as any).user?.userId ?? (req as any).userId ?? null;
    /** Who moved a delete, financial or administrative tool, from what to what. */
    const auditApprovalChange = async (before: ApprovalMode, targetType: string, targetId: string) => {
      if (!isHighRiskGroup(riskGroup) || typeof requiresApproval !== "boolean") return;
      const after: ApprovalMode = requiresApproval ? "ask" : "execute";
      if (before === after) return;
      return writeAudit({
        tenantId,
        actorType: "user",
        actorId,
        action: AuditAction.PERMISSION_CHANGED,
        targetType,
        targetId,
        metadata: { change: "approval_policy", tool: toolName, riskGroup, before, after, loosened: after === "execute" },
      });
    };

    // Integration tools store their HITL override on TenantTool.configOverrides.hitlPolicy -
    // that's where the gate reads it from. Writing to TenantToolPermission for an
    // integration tool would silently no-op against the gate.
    if (isIntegration) {
      // Resolve to ONE catalog row, scoped to its provider. Both lookups below
      // used to key on the bare slug, and 20 slugs are shared between
      // providers - a rule for paypal.create_payment_link could land on
      // Stripe's row.
      const resolved = await resolveCatalogTool(tenantId, toolName);
      if ("error" in resolved) {
        res.status(resolved.status).json(resolved.body);
        return;
      }
      const catalogTool = resolved.catalogTool;
      const slug = catalogTool.slug;
      let tenantTool = await (prisma as any).tenantTool.findFirst({
        where: { tenantId, catalogToolId: catalogTool.id },
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
      const approvalBefore = approvalModeOf(
        (existingOverrides.hitlPolicy as any)?.mode ?? (catalogTool.hitlPolicy as any)?.mode ?? "never",
      );
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
      await auditApprovalChange(approvalBefore, "tenant_tool", tenantTool.id);
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

    patch.updatedBy = actorId;

    // An absent row means the gate's own default, and a first write that does
    // not name requiresApproval must keep it: creating the row with `false`
    // silently turned "Ask me" into "Execute" for any tool whose default asks.
    const defaultAsks = getDefaultHighRiskTools().includes(toolName);
    const existingRow = await (prisma as any).tenantToolPermission.findUnique({
      where: { tenantId_toolName: { tenantId, toolName } },
      select: { requiresApproval: true },
    });
    const approvalBefore: ApprovalMode = (existingRow ? existingRow.requiresApproval : defaultAsks) ? "ask" : "execute";

    const row = await (prisma as any).tenantToolPermission.upsert({
      where: { tenantId_toolName: { tenantId, toolName } },
      update: patch,
      create: {
        tenantId,
        toolName,
        enabled: typeof enabled === "boolean" ? enabled : true,
        requiresApproval:
          typeof requiresApproval === "boolean" ? requiresApproval : defaultAsks,
        approverRole: typeof approverRole === "string" ? approverRole : null,
        expiresAfterMin: typeof expiresAfterMin === "number" ? expiresAfterMin : 30,
        allowModification:
          typeof allowModification === "boolean" ? allowModification : false,
        updatedBy: actorId,
      },
    });
    await auditApprovalChange(approvalBefore, "tenant_tool_permission", row.id ?? toolName);

    res.json({ data: row });
  } catch (err: any) {
    console.error("Upsert tool permission error:", err);
    res.status(500).json({ error: "Failed to save tool permission" });
  }
});

/**
 * Resolve a settings tool name to exactly one CatalogTool.
 *
 *   <provider>.<slug>    - the provider is an integration slug: unambiguous.
 *   integration.<slug>   - legacy generic shape. Resolved among the providers
 *                          THIS tenant has a connection to; if two of them
 *                          carry the slug it is refused as ambiguous, with the
 *                          names that would work, rather than guessed.
 *
 * A bare-slug guess is exactly the bug this replaces.
 */
export async function resolveCatalogTool(
  tenantId: string,
  toolName: string,
): Promise<
  | { catalogTool: { id: string; integrationId: string; slug: string; hitlPolicy?: unknown } }
  | { error: true; status: number; body: Record<string, unknown> }
> {
  const dot = toolName.indexOf(".");
  const prefix = toolName.slice(0, dot);
  const slug = toolName.slice(dot + 1);
  const select = { id: true, integrationId: true, slug: true, hitlPolicy: true, integration: { select: { slug: true } } };

  if (prefix !== "integration") {
    const ct = await (prisma as any).catalogTool.findFirst({
      where: { slug, integration: { slug: prefix } },
      select,
    });
    if (!ct) return { error: true, status: 404, body: { error: `unknown catalog tool "${toolName}"` } };
    return { catalogTool: ct };
  }

  const candidates: any[] = await (prisma as any).catalogTool.findMany({ where: { slug }, select });
  if (candidates.length === 0) return { error: true, status: 404, body: { error: `unknown catalog tool "${slug}"` } };
  if (candidates.length === 1) return { catalogTool: candidates[0] };

  const connections: any[] = await (prisma as any).tenantIntegration.findMany({
    where: { tenantId, integrationId: { in: candidates.map((c) => c.integrationId) } },
    select: { integrationId: true },
  });
  const mine = new Set(connections.map((c) => c.integrationId));
  const scoped = candidates.filter((c) => mine.has(c.integrationId));
  if (scoped.length === 1) return { catalogTool: scoped[0] };
  return {
    error: true,
    status: 409,
    body: {
      error: "ambiguous_tool",
      message: `"${toolName}" exists on more than one provider. Name the provider.`,
      candidates: (scoped.length ? scoped : candidates).map((c) => `${c.integration?.slug}.${c.slug}`),
    },
  };
}

export default router;
