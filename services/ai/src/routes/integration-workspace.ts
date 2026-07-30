/**
 * The Integrations & Tools workspace API.
 *
 * GET /api/integration-workspace          → the sidebar (classified entries)
 * GET /api/integration-workspace/:id      → one integration's tools + policy
 *
 * Composition, not unification. Three separate models feed the sidebar because
 * three separate screens own them:
 *
 *   integration_catalog + tenant_integrations → business systems (this screen)
 *   channel_accounts                          → channels (Channels owns them)
 *   knowledge_integrations                    → knowledge (Knowledge Manager)
 *
 * Only the first can carry executable tools and therefore policy. The other two
 * appear as status-only entries so an admin can see a dependency is healthy
 * without this screen pretending to manage it. Classification itself is a pure
 * function in @chatcenter/shared so it is testable and cannot drift per page.
 */

import { Router, Request, Response } from "express";
import {
  prisma,
  authenticate,
  resolveTenant,
  requireActiveTenant,
  requirePermissionOrRole,
  classifyCatalogIntegration,
  classifyChannel,
  classifyKnowledgeSource,
  gotchaEntry,
  buildWorkspaceSidebar,
  resolveToolAvailability,
  summarizeTools,
  groupByRisk,
  riskGroupFor,
  GOTCHA_ENTRY_ID,
  toolDisplayName,
  type CatalogIntegrationInput,
} from "@chatcenter/shared";
import {
  TOOL_REGISTRY,
  getGovernableIntegrationTools,
  getExecutableToolCountsBySlug,
  type GovernableTool,
} from "../services/tool-registry";
import {
  capabilityStateFromConfig,
  capabilityStateIsFresh,
  missingScopesFromConfig,
} from "../services/connectors/integration-framework";

const router = Router();

router.use(
  authenticate,
  resolveTenant,
  requireActiveTenant(),
  requirePermissionOrRole("ai:tools:read", "ADMIN"),
);

/** "he" when the caller asked for Hebrew, else "en". Tool labels are localized. */
function localeOf(req: Request): "en" | "he" {
  const q = typeof req.query.locale === "string" ? req.query.locale : undefined;
  const h = req.headers["accept-language"] as string | undefined;
  return String(q || h || "en").toLowerCase().startsWith("he") ? "he" : "en";
}

/** Internal GOTCHA tools an admin can set policy on: the mutating ones plus reads. */
function internalTools() {
  return TOOL_REGISTRY.filter((t) => t.kind === "action" || t.kind === "system");
}

// ─── Sidebar ────────────────────────────────────────────────

router.get("/", async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;

    const [catalog, connections, channels, knowledgeSources, governable, executableBySlug] = await Promise.all([
      prisma.integrationCatalog.findMany({
        select: {
          id: true, slug: true, name: true, category: true, description: true,
          logoUrl: true, isPublished: true,
          _count: { select: { catalogTools: true } },
        },
      }).catch(() => [] as any[]),
      prisma.tenantIntegration.findMany({
        where: { tenantId },
        select: { status: true, config: true, integration: { select: { slug: true } } },
      }).catch(() => [] as any[]),
      prisma.channelAccount.findMany({
        where: { tenantId },
        select: { channel: true, connectionStatus: true },
      }).catch(() => [] as any[]),
      prisma.knowledgeIntegration.findMany({
        where: { tenantId },
        select: { provider: true, isActive: true },
      }).catch(() => [] as any[]),
      // Loud on failure. A silent catch here would render as "Shopify has no
      // tools", which is a different and false statement.
      getGovernableIntegrationTools(tenantId).catch((err: any) => {
        console.error("[integration-workspace] governable tools failed:", err?.message, err?.stack?.split("\n")[1]?.trim());
        return [] as GovernableTool[];
      }),
      getExecutableToolCountsBySlug().catch((err: any) => {
        console.error("[integration-workspace] executable counts failed:", err?.message);
        return new Map<string, number>();
      }),
    ]);

    // Governable tool count per integration. Deliberately NOT the raw
    // catalog_tools count: a seeded stub that nothing can execute must not
    // inflate the number an admin sees.
    const governableBySlug = new Map<string, number>();
    for (const t of governable) {
      governableBySlug.set(t.integrationSlug, (governableBySlug.get(t.integrationSlug) ?? 0) + 1);
    }

    // One connection per slug. The dev estate has three Shopify rows for one
    // tenant; keying by slug keeps the sidebar from listing it three times.
    const connBySlug = new Map<string, any>();
    for (const c of connections as any[]) {
      const slug = c.integration?.slug;
      if (!slug || connBySlug.has(slug)) continue;
      connBySlug.set(slug, c);
    }

    const entries = [
      gotchaEntry({ toolCount: internalTools().length }),
      ...(catalog as any[]).map((row) => {
        const conn = connBySlug.get(row.slug);
        const cfg = (conn?.config && typeof conn.config === "object" ? conn.config : {}) as Record<string, any>;
        const input: CatalogIntegrationInput = {
          slug: row.slug,
          name: row.name,
          category: row.category ?? null,
          description: row.description ?? null,
          logoUrl: row.logoUrl ?? null,
          isPublished: row.isPublished !== false,
          // Connected: what is actually governable right now. Not connected:
          // what connecting WOULD bring. Using the governable count for both
          // filed every unconnected integration as a status-only external
          // connection, because governable is connected-only by construction.
          // A provider whose tools are all dead seeds still counts 0 and is
          // classified as external - that part was right.
          toolCount: conn
            ? governableBySlug.get(row.slug) ?? 0
            : executableBySlug.get(row.slug) ?? 0,
          ...(conn
            ? {
                connection: {
                  status: conn.status,
                  missingScopes: missingScopesFromConfig(cfg),
                  capabilityStatus: capabilityStateFromConfig(cfg).status,
                  capabilityFresh: capabilityStateIsFresh(cfg),
                },
              }
            : {}),
        };
        return classifyCatalogIntegration(input);
      }),
      ...(channels as any[]).map((c) => classifyChannel({ channel: c.channel, connectionStatus: c.connectionStatus })),
      ...(knowledgeSources as any[]).map((k) => classifyKnowledgeSource({ provider: k.provider, isActive: k.isActive })),
    ];

    res.json({ data: buildWorkspaceSidebar(entries) });
  } catch (err: any) {
    console.error("[integration-workspace] sidebar failed:", err?.message);
    // A 500 must stay a 500. Returning an empty sidebar would render as "you
    // have no integrations", which is a different and false statement.
    res.status(500).json({ error: "Failed to load integrations" });
  }
});

// ─── One integration's tools ────────────────────────────────

router.get("/:id", async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const id = String(req.params.id);

    // GOTCHA: the platform's own tools. No connection, no scopes, no plan gate
    // beyond the tenant being active - it is always available.
    if (id === GOTCHA_ENTRY_ID) {
      const perms = await prisma.tenantToolPermission
        .findMany({ where: { tenantId } })
        .catch(() => [] as any[]);
      const permByName = new Map((perms as any[]).map((p) => [p.toolName, p]));

      const rows = internalTools().map((t) => {
        const row = permByName.get(t.name);
        const availability = resolveToolAvailability({
          toolName: t.name,
          enabled: row ? row.enabled : true,
          requiresApproval: row ? row.requiresApproval : riskGroupFor(t.name) !== "read_only",
        });
        return {
          name: t.name,
          displayName: toolDisplayName(t.name, null, localeOf(req)),
          description: t.description ?? "",
          riskGroup: availability.riskGroup,
          availability,
          provisioned: !!row,
          requiredScopes: [] as string[],
          isDefault: !row,
        };
      });

      res.json({
        data: {
          id: GOTCHA_ENTRY_ID,
          name: "GOTCHA",
          internal: true,
          category: "SYSTEM",
          description: "Internal GOTCHA platform tools and actions.",
          connected: true,
          counts: summarizeTools(rows.map((r) => r.availability)),
          groups: groupByRisk(rows).map(([riskGroup, tools]) => ({ riskGroup, tools })),
        },
      });
      return;
    }

    // A catalog integration.
    const connection = await prisma.tenantIntegration.findFirst({
      where: { tenantId, integration: { slug: id } },
      select: {
        status: true, config: true,
        integration: { select: { slug: true, name: true, category: true, description: true, logoUrl: true } },
      },
    });

    const governable = (await getGovernableIntegrationTools(tenantId)).filter((t) => t.integrationSlug === id);
    if (!connection && governable.length === 0) {
      // Not connected is not the same as not real. The sidebar lists available
      // integrations, so selecting one must describe it and say how to connect
      // it - a 404 here would render as "this integration does not exist".
      const catalogRow = await prisma.integrationCatalog.findUnique({
        where: { slug: id },
        select: {
          slug: true, name: true, description: true, logoUrl: true, isPublished: true,
          // The catalog already declares how each provider connects. Returning
          // it lets the workspace start the REAL flow instead of shipping the
          // reader off to another screen - and without a second OAuth
          // implementation, since the frontend calls the same init endpoint.
          authType: true, authSchema: true,
        },
      });
      if (!catalogRow || catalogRow.isPublished === false) {
        res.status(404).json({ error: "Integration not found" });
        return;
      }
      const catalogToolCount = await prisma.catalogTool.count({
        where: { integration: { slug: id } },
      });
      res.json({
        data: {
          id,
          name: catalogRow.name,
          internal: false,
          connected: false,
          connectable: true,
          description: catalogRow.description ?? null,
          logoUrl: catalogRow.logoUrl ?? null,
          // What it WOULD bring, stated as such. Not a policy surface: there is
          // nothing to enforce until the tenant connects it.
          catalogToolCount,
          authType: catalogRow.authType,
          authSchema: catalogRow.authSchema ?? {},
          counts: { total: 0, enabled: 0, alwaysAllow: 0, requireApproval: 0, disabled: 0, unavailable: 0 },
          groups: [],
        },
      });
      return;
    }

    const cfg = (connection?.config && typeof connection.config === "object" ? connection.config : {}) as Record<string, any>;
    const connected = String(connection?.status || "").toUpperCase() === "CONNECTED";
    const missing = missingScopesFromConfig(cfg);
    const granted = capabilityStateFromConfig(cfg).grantedScopes;

    const rows = governable.map((t) => {
      // The runtime's own scope rule, applied here so the row and the tool
      // surface agree: blocked when any REQUIRED scope is known-missing.
      const scopeBlocked = t.requiredScopes.length > 0 && t.requiredScopes.some((s) => missing.includes(s));
      const availability = resolveToolAvailability({
        toolName: t.name,
        // An unprovisioned tool has no stored preference. It is reported as
        // disabled, which is true - nothing can call it yet - and picking any
        // other state provisions it.
        enabled: t.provisioned ? t.isEnabled : false,
        requiresApproval: (t.overrideHitlMode ?? t.catalogHitlMode) === "always",
        integrationConnected: connection ? connected : undefined,
        requiredScopes: t.requiredScopes.length ? t.requiredScopes : undefined,
        grantedScopes: granted.length ? granted : undefined,
        scopeBlocked: t.requiredScopes.length ? scopeBlocked : undefined,
        missingScopes: t.requiredScopes.filter((s) => missing.includes(s)),
      });
      return {
        name: t.name,
        displayName: toolDisplayName(t.name, t.displayName, localeOf(req)),
        description: t.description,
        riskGroup: availability.riskGroup,
        availability,
        provisioned: t.provisioned,
        requiredScopes: t.requiredScopes,
        execution: t.execution,
        isDefault: !t.provisioned || t.overrideHitlMode == null,
      };
    });

    res.json({
      data: {
        id,
        name: connection?.integration?.name ?? id,
        internal: false,
        category: connection?.integration?.category ?? null,
        description: connection?.integration?.description ?? null,
        logoUrl: connection?.integration?.logoUrl ?? null,
        connected,
        missingScopes: missing,
        grantedScopes: granted,
        capabilityStatus: capabilityStateFromConfig(cfg).status,
        capabilityFresh: capabilityStateIsFresh(cfg),
        counts: summarizeTools(rows.map((r) => r.availability)),
        groups: groupByRisk(rows).map(([riskGroup, tools]) => ({ riskGroup, tools })),
      },
    });
  } catch (err: any) {
    console.error("[integration-workspace] detail failed:", err?.message);
    res.status(500).json({ error: "Failed to load integration" });
  }
});

export default router;
