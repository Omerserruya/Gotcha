/**
 * Print the Integrations & Tools sidebar exactly as the route would build it,
 * for one tenant, straight off the live DB and the real adapter registry.
 *
 * Everything below the auth layer is the route's own code path: the same
 * executable-tool counts, the same classifier, the same assembly. Run it to see
 * what a tenant actually gets without minting a token.
 *
 *   docker compose exec ai npx tsx scripts/verify-workspace-sidebar.ts <tenantId>
 */

import "../src/services/connectors";
import {
  prisma,
  classifyCatalogIntegration,
  classifyKnowledgeSource,
  gotchaEntry,
  buildWorkspaceSidebar,
  channelDependencyFor,
  type CatalogIntegrationInput,
  type WorkspaceEntry,
} from "@chatcenter/shared";
import { TOOL_REGISTRY, getGovernableIntegrationTools, getExecutableToolCountsBySlug } from "../src/services/tool-registry";
import {
  capabilityStateFromConfig,
  capabilityStateIsFresh,
  missingScopesFromConfig,
} from "../src/services/connectors/integration-framework";

async function main() {
  const tenantId = process.argv[2];
  if (!tenantId) throw new Error("usage: verify-workspace-sidebar.ts <tenantId>");

  const [catalog, connections, knowledgeSources, governable, executableBySlug, channels] = await Promise.all([
    prisma.integrationCatalog.findMany({
      select: { id: true, slug: true, name: true, category: true, description: true, logoUrl: true, isPublished: true },
    }),
    prisma.tenantIntegration.findMany({
      where: { tenantId },
      select: { status: true, config: true, integration: { select: { slug: true } } },
    }),
    prisma.knowledgeIntegration.findMany({ where: { tenantId }, select: { provider: true, isActive: true } }),
    getGovernableIntegrationTools(tenantId),
    getExecutableToolCountsBySlug(),
    prisma.channelAccount.findMany({ where: { tenantId }, select: { channel: true, connectionStatus: true } }),
  ]);

  const governableBySlug = new Map<string, number>();
  for (const t of governable) governableBySlug.set(t.integrationSlug, (governableBySlug.get(t.integrationSlug) ?? 0) + 1);

  const connBySlug = new Map<string, any>();
  for (const c of connections as any[]) {
    const slug = c.integration?.slug;
    if (!slug || connBySlug.has(slug)) continue;
    connBySlug.set(slug, c);
  }

  const internal = TOOL_REGISTRY.filter((t) => t.kind === "action" || t.kind === "system");
  const entries: WorkspaceEntry[] = [
    gotchaEntry({ toolCount: internal.length }),
    ...(catalog as any[])
      .map((row) => {
        const conn = connBySlug.get(row.slug);
        const cfg = (conn?.config && typeof conn.config === "object" ? conn.config : {}) as Record<string, any>;
        const input: CatalogIntegrationInput = {
          slug: row.slug,
          name: row.name,
          category: row.category ?? null,
          description: row.description ?? null,
          logoUrl: row.logoUrl ?? null,
          isPublished: row.isPublished !== false,
          toolCount: conn ? governableBySlug.get(row.slug) ?? 0 : executableBySlug.get(row.slug) ?? 0,
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
      })
      .filter((e): e is WorkspaceEntry => e !== null),
    ...(knowledgeSources as any[]).map((k) => classifyKnowledgeSource({ provider: k.provider, isActive: k.isActive })),
  ];

  const sidebar = buildWorkspaceSidebar(entries);
  const line = (e: WorkspaceEntry) => `    ${e.name} (${e.id}) — ${e.state}${e.toolCount === null ? "" : ` — ${e.toolCount} tools`}${e.href ? ` → ${e.href}` : ""}`;

  console.log(`\nTenant ${tenantId}\n`);
  console.log("  Connected:");
  sidebar.toolIntegrations.connected.forEach((e) => console.log(line(e)));
  console.log("  Available:");
  [...sidebar.toolIntegrations.available, ...sidebar.toolIntegrations.unavailable].forEach((e) => console.log(line(e)));
  console.log("  Other connected services:");
  if (!sidebar.externalConnections.length) console.log("    (none)");
  sidebar.externalConnections.forEach((e) => console.log(line(e)));

  const dropped = (catalog as any[])
    .map((r) => r.slug)
    .filter((s) => !entries.some((e) => e.id === s));
  console.log(`\n  Not listed at all: ${dropped.join(", ") || "(none)"}`);

  console.log("\n  GOTCHA channel dependency note:");
  console.log("   ", JSON.stringify(channelDependencyFor({
    toolNames: internal.map((t) => t.name),
    channels: (channels as any[]).map((c) => ({ channel: c.channel, connectionStatus: c.connectionStatus })),
  })));
  console.log("    (channels on this tenant:", (channels as any[]).map((c) => `${c.channel}=${c.connectionStatus}`).join(", ") || "none", ")\n");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
