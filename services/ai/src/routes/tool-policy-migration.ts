/**
 * Migrating stored tool policy onto the canonical three-state model.
 *
 * GET  /api/tool-policy-migration          → the report. Changes nothing.
 * POST /api/tool-policy-migration/apply    → performs the safe writes.
 *
 * Policy lives in two stores because two kinds of tool exist:
 *
 *   TenantToolPermission  GOTCHA's own system actions, keyed by tool name
 *   TenantTool            catalog tools, keyed by catalog row, with the HITL
 *                         mode inside configOverrides.hitlPolicy
 *
 * Both express the same idea with different shapes, and the workspace now
 * presents them identically (Autonomous / HITL / Disabled). This reconciles
 * what is stored with what can actually be enforced, and - importantly - says
 * out loud what it will NOT touch.
 *
 * The decision rules live in @chatcenter/shared/tool-policy-migration and are
 * deliberately conservative: disabled stays disabled, HITL never silently
 * becomes autonomous, and anything impossible or unexecutable is reported for
 * a human rather than guessed at. Idempotent by construction - migrationWrites
 * only emits rows whose target differs from their current state, so a second
 * run writes nothing.
 *
 * WHAT THIS ACTUALLY DOES TODAY, stated plainly: both stores always have an
 * enabled value, so every collected policy maps to one of the three states,
 * and each of those maps to ITSELF (or to null, for orphans, conflicts and
 * scope-blocked tools, which are never written). appliedCount is therefore
 * normally 0, and that is the correct result, not a failure - it means the
 * stored policy already expresses the canonical model and nothing needs
 * rewriting.
 *
 * The value here is the REPORT: policy rows for tools nothing can execute any
 * more, stored states the new model does not permit, and tools held back by a
 * missing provider scope. Those are the things an admin has to decide about,
 * and before this they were invisible. `apply` exists so that a decision that
 * DOES differ gets written through one audited, idempotent path rather than by
 * hand - not because there is a backlog of rewrites waiting.
 */

import { Router, Request, Response } from "express";
import {
  prisma,
  authenticate,
  resolveTenant,
  requireActiveTenant,
  requirePermissionOrRole,
  writeAudit,
  AuditAction,
  buildMigrationReport,
  migrationWrites,
  type LegacyPolicy,
} from "@chatcenter/shared";
import { TOOL_REGISTRY, getGovernableIntegrationTools } from "../services/tool-registry";
import { missingScopesFromConfig } from "../services/connectors/integration-framework";

const router = Router();

router.use(
  authenticate,
  resolveTenant,
  requireActiveTenant(),
  requirePermissionOrRole("ai:tools:read", "ADMIN"),
);

interface Collected {
  policies: LegacyPolicy[];
  /** Where each tool's policy lives, so apply writes to the right store. */
  store: Map<string, { kind: "internal" } | { kind: "catalog"; tenantToolId: string }>;
}

/**
 * Read both stores and describe every stored policy in the shared vocabulary.
 *
 * A tool with no stored row is NOT collected: it has no legacy policy to
 * migrate, and inventing one would turn "never configured" into an explicit
 * decision the tenant never made.
 */
async function collect(tenantId: string): Promise<Collected> {
  const knownInternal = new Set(TOOL_REGISTRY.map((t) => t.name));

  const [perms, tenantTools, governable, connections] = await Promise.all([
    prisma.tenantToolPermission.findMany({ where: { tenantId } }),
    prisma.tenantTool.findMany({
      where: { tenantId },
      select: {
        id: true, isEnabled: true, configOverrides: true,
        catalogTool: { select: { slug: true, integration: { select: { slug: true } } } },
      },
    }),
    getGovernableIntegrationTools(tenantId),
    prisma.tenantIntegration.findMany({
      where: { tenantId },
      select: { config: true, integration: { select: { slug: true } } },
    }),
  ]);

  // Which provider scopes are known-missing, per integration.
  const missingBySlug = new Map<string, string[]>();
  for (const c of connections as any[]) {
    const slug = c.integration?.slug;
    if (!slug || missingBySlug.has(slug)) continue;
    const cfg = (c.config && typeof c.config === "object" ? c.config : {}) as Record<string, any>;
    missingBySlug.set(slug, missingScopesFromConfig(cfg));
  }

  const governableByName = new Map(governable.map((g) => [g.name, g]));
  const policies: LegacyPolicy[] = [];
  const store: Collected["store"] = new Map();

  for (const p of perms as any[]) {
    policies.push({
      toolName: p.toolName,
      enabled: p.enabled,
      requiresApproval: p.requiresApproval,
      // A policy row for a system action that no longer exists in the registry
      // gates nothing. Reported, never rewritten.
      orphaned: !knownInternal.has(p.toolName),
    });
    store.set(p.toolName, { kind: "internal" });
  }

  for (const tt of tenantTools as any[]) {
    const providerSlug = tt.catalogTool?.integration?.slug;
    const toolSlug = tt.catalogTool?.slug;
    if (!providerSlug || !toolSlug) continue;
    const name = `${providerSlug}.${toolSlug}`;

    const overrides = (tt.configOverrides ?? {}) as Record<string, any>;
    const mode = overrides?.hitlPolicy?.mode;
    const governableRow = governableByName.get(name);
    const missing = missingBySlug.get(providerSlug) ?? [];
    const required = governableRow?.requiredScopes ?? [];

    policies.push({
      toolName: name,
      enabled: tt.isEnabled,
      // No override means the CATALOG SEED rules, and that is what the runtime
      // enforces - so that is what must be reported. Passing undefined here
      // read as "autonomous", which would have claimed the tenant chose
      // auto-run for every tool that merely inherited an approval default.
      requiresApproval:
        mode === undefined
          ? (governableRow?.catalogHitlMode ?? "never") === "always"
          : mode === "always",
      // Not governable means nothing can execute it: no adapter, no endpoint,
      // or the integration is no longer connected.
      orphaned: !governableRow,
      scopeBlocked: required.length > 0 && required.some((s) => missing.includes(s)),
    });
    store.set(name, { kind: "catalog", tenantToolId: tt.id });
  }

  return { policies, store };
}

router.get("/", async (req: Request, res: Response) => {
  try {
    const { policies } = await collect(req.tenantId!);
    const report = buildMigrationReport(policies);
    res.json({ data: { ...report, pendingWrites: migrationWrites(report).length, applied: false } });
  } catch (err: any) {
    console.error("[tool-policy-migration] report failed:", err?.message);
    res.status(500).json({ error: "Failed to build the migration report" });
  }
});

router.post("/apply", requirePermissionOrRole("ai:tools:manage", "ADMIN"), async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const { policies, store } = await collect(tenantId);
    const report = buildMigrationReport(policies);
    const writes = migrationWrites(report);

    let applied = 0;
    const failures: Array<{ toolName: string; error: string }> = [];

    for (const w of writes) {
      const target = store.get(w.toolName);
      if (!target) continue;
      const enabled = w.state !== "disabled";
      const requiresApproval = w.state === "hitl";
      try {
        if (target.kind === "internal") {
          await prisma.tenantToolPermission.updateMany({
            where: { tenantId, toolName: w.toolName },
            data: { enabled, requiresApproval },
          });
        } else {
          const row = await prisma.tenantTool.findFirst({
            where: { tenantId, id: target.tenantToolId },
            select: { configOverrides: true },
          });
          const overrides = ((row?.configOverrides ?? {}) as Record<string, unknown>);
          await prisma.tenantTool.updateMany({
            where: { tenantId, id: target.tenantToolId },
            data: {
              isEnabled: enabled,
              configOverrides: {
                ...overrides,
                hitlPolicy: { ...(overrides.hitlPolicy as object ?? {}), mode: requiresApproval ? "always" : "never" },
              },
            },
          });
        }
        applied += 1;
      } catch (e: any) {
        // One tool failing must not silently truncate the rest, and must not
        // be reported as success.
        failures.push({ toolName: w.toolName, error: e?.message || "write failed" });
      }
    }

    void writeAudit({
      tenantId,
      actorType: "user",
      actorId: (req as any).user?.userId,
      action: AuditAction.PERMISSION_CHANGED,
      targetType: "tool_policy_migration",
      targetId: tenantId,
      metadata: {
        planned: writes.length,
        applied,
        failed: failures.length,
        needsReview: report.needsReview.length,
      },
    });

    res.json({
      data: {
        ...report,
        applied: true,
        appliedCount: applied,
        // Stated, not swallowed: a partial run is not a successful one.
        failures,
        // What a human still has to decide. The migration never guesses these.
        needsReview: report.needsReview,
      },
    });
  } catch (err: any) {
    console.error("[tool-policy-migration] apply failed:", err?.message);
    res.status(500).json({ error: "Failed to apply the migration" });
  }
});

export default router;
