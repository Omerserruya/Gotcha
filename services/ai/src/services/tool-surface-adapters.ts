/**
 * The adapter-framework tools a tenant's employee may be offered: only for an
 * integration that is CONNECTED (and funded, for Shopify), only tools enabled
 * for the tenant AND allowed for this employee, and never one the provider
 * cannot execute. Moved out of ai-bot.service unchanged so the legacy turn and
 * reply engine v2 build the same surface.
 */
import { prisma, getShopifyAuthorization, shopifyCapabilityForTool, allowedIntegrationToolKeys } from "@chatcenter/shared";
import {
  listAdapters,
  missingScopesFromConfig,
  toolBlockedByMissingScopes,
  toolCannotExecute,
  capabilityStateIsFresh,
  refreshCapabilityState,
} from "./connectors/integration-framework";
import { SHIPMENT_TRACKING_TOOL, shipmentTrackingVisible } from "./connectors/woo-shipment-tracking";

export async function buildAdapterToolSurface(tenantId: string, aiAgentId: string): Promise<any[]> {
  const tools: any[] = [];
  // ── Adapter framework tools ── (only for tenants with the integration CONNECTED)
  try {
    const connectedSlugs = new Set<string>();
    const configBySlug = new Map<string, any>();
    const tiRows: any[] = await prisma.tenantIntegration.findMany({
      where: { tenantId: tenantId, status: "CONNECTED" },
      include: { integration: true },
    });
    // A Shopify connection that nobody is paying Shopify for is not a
    // connection the model may see.
    //
    // Dropping it from `connectedSlugs` removes its tools from the SURFACE, not
    // merely from dispatch. Offering a tool that will refuse is a mistake this
    // codebase has already paid for once: the model picks the tool it was
    // shown, spends a turn on it, and reports a failure to the customer. The
    // dispatch path is gated too (loadConnection), but the model should never
    // be told the option exists.
    const shopifyConnected = tiRows.some((ti) => ti.integration?.slug === "shopify");
    // The SET of Shopify capabilities Shopify has actually funded, not a
    // boolean. A merchant funded only for catalogue sync must be offered the
    // catalogue tools and none of the order or refund tools, so the surface is
    // filtered per tool below rather than per provider here.
    const shopifyCaps = new Set<string>(
      shopifyConnected ? (await getShopifyAuthorization(tenantId)).capabilities : [],
    );
    for (const ti of tiRows) {
      const s = ti.integration?.slug;
      if (!s) continue;
      if (s === "shopify" && shopifyCaps.size === 0) continue;
      connectedSlugs.add(s);
      configBySlug.set(s, ti.config || {});
    }
    // Governance set for adapter tools. Key: `${integrationSlug}:${catalogToolSlug}`.
    // Built from the SAME guest-list the governed `integration_<slug>` path uses
    // (AgentToolPermission.isAllowed + TenantTool.isEnabled + CONNECTED +
    // allowedModes), so the autonomous bot never surfaces an adapter tool the
    // operator hasn't enabled for THIS agent. Without this, every tool of every
    // connected integration would leak in regardless of the marketplace toggle.
    // The one shared query (grants + enabled + CONNECTED + the employee's
    // allowlist), AUTO surface only.
    let allowedAdapterTools = new Set<string>();
    try {
      allowedAdapterTools = await allowedIntegrationToolKeys(tenantId, aiAgentId, { mode: "AUTO" });
    } catch (err: any) {
      console.warn("[ai-bot] adapter tool permission load failed:", err?.message);
    }

    // Slugs whose adapter tools accept a `table`/`collection` arg and benefit
    // from a tenant-curated table list with per-table notes appended to the
    // tool description (so the AI knows what each table is and when to use it).
    const DB_SLUGS = new Set(["postgresql", "mongodb", "aws_rds"]);
    for (const adapter of listAdapters()) {
      // Adapter slug IS the catalog slug. A translation map used to live here
      // for postgres/postgresql, which papered over the mismatch on the tool
      // SURFACE while executeAdapterTool - which has no such map - still failed
      // every call with not_connected. The adapter was renamed instead.
      const catalogSlug = adapter.slug;
      if (!connectedSlugs.has(catalogSlug)) continue;
      const cfg = configBySlug.get(catalogSlug) || {};
      const reads: string[] = Array.isArray(cfg.allowReads) ? cfg.allowReads : [];
      const writes: string[] = Array.isArray(cfg.allowWrites) ? cfg.allowWrites : [];
      const enabled = Array.from(new Set([...reads, ...writes]));
      const tableNotes: Record<string, { description?: string; whenToUse?: string }> =
        (cfg.tableNotes && typeof cfg.tableNotes === "object") ? cfg.tableNotes : {};
      const tablesBlock =
        DB_SLUGS.has(adapter.slug) && enabled.length > 0
          ? "\n\nTABLES AVAILABLE:\n" +
            enabled.map((q) => {
              const n = tableNotes[q] || {};
              const parts: string[] = [`- ${q}`];
              if (reads.includes(q) && writes.includes(q)) parts.push("(read+write)");
              else if (writes.includes(q)) parts.push("(write)");
              else parts.push("(read-only)");
              if (n.description) parts.push(`- ${n.description}`);
              if (n.whenToUse) parts.push(`[USE WHEN: ${n.whenToUse}]`);
              return parts.join(" ");
            }).join("\n")
          : "";
      // Capability freshness: the surface is built from VERIFIED capabilities.
      // If this connection's capability snapshot is stale (or was never
      // taken - pre-existing connections), re-probe in the background so the
      // next turn gates on current provider truth instead of data that could
      // have drifted since connect. Non-blocking on purpose: this turn still
      // uses the last KNOWN state, which the OAuth-callback probe seeds at
      // connect time for new stores.
      if (typeof adapter.validate === "function" && !capabilityStateIsFresh(cfg)) {
        void refreshCapabilityState({
          tenantId: tenantId,
          slug: catalogSlug,
        }).catch((err: any) =>
          console.warn(`[ai-bot] capability refresh failed for ${catalogSlug}:`, err?.message));
      }
      for (const def of adapter.tools()) {
        // Governance gate (parity with the governed `integration_<slug>` path):
        // surface this tool ONLY if it is enabled for the tenant AND allowed for
        // THIS agent. `def.name` is `<provider>.<toolSlug>`; the catalog tool
        // slug is the part after the dot.
        const toolSlug = def.name.includes(".") ? def.name.slice(def.name.indexOf(".") + 1) : def.name;
        if (!allowedAdapterTools.has(`${catalogSlug}:${toolSlug}`)) continue;
        // Capability gate: never offer a tool the shop cannot execute. When a
        // provider proved a scope missing ("requires merchant approval"), the
        // framework persists it on config.missingScopes - offering the tool
        // anyway would let the model open an approval that can never run
        // (exactly the Matan coupon HITL). State self-heals on re-connect or
        // a passing integration test.
        if (toolBlockedByMissingScopes(def, missingScopesFromConfig(cfg))) continue;
        // Capability gate, part two: the provider's OWN verdict. A tool
        // declared `unsupported` throws the moment it is called, so offering it
        // buys nothing and costs a real conversation - the model picks it,
        // promises the customer, and is refused at dispatch. This was live on
        // 2026-08-26: shopify.edit_order was offered, chosen for a colour swap,
        // denied, and the customer was escalated to a human for something the
        // store could actually do.
        if (toolCannotExecute(def)) {
          console.log(`[ai-bot][tool-surface] hiding ${def.name}: provider declares it unsupported`);
          continue;
        }
        // Capability gate, part three: a tool that needs a store extension is
        // offered only where the extension was seen (cached per store; an
        // unknown store is probed in the background and the tool waits).
        if (def.name === SHIPMENT_TRACKING_TOOL && !(await shipmentTrackingVisible(String(cfg.storeUrl ?? "")))) {
          console.log(`[ai-bot][tool-surface] hiding ${def.name}: the store has no Shipment Tracking extension (or it is not known yet)`);
          continue;
        }
        // Entitlement gate, per TOOL. Which Shopify entitlement a tool needs is
        // policy (shopify-capability-map), and a merchant funded for one group
        // must not be offered another: catalogue sync does not buy order
        // history, and neither buys refunds. An unclassified Shopify tool maps
        // to null and is hidden, so a tool added later cannot ride in on an
        // unrelated entitlement.
        if (catalogSlug === "shopify") {
          const need = shopifyCapabilityForTool(def.name);
          if (!need || !shopifyCaps.has(need)) {
            console.log(
              `[ai-bot][tool-surface] hiding ${def.name}: ${need ?? "unclassified"} not funded by Shopify`,
            );
            continue;
          }
        }
        tools.push({
          type: "function",
          function: {
            name: def.name,
            description:
              `${def.description}\n\nWHEN TO USE: ${def.whenToUse}` +
              (def.whenNotToUse ? `\n\nDO NOT USE: ${def.whenNotToUse}` : "") +
              (def.sideEffects ? `\n\nSIDE EFFECTS: ${def.sideEffects}` : "") +
              (def.idempotencyNotes ? `\n\nIDEMPOTENCY: ${def.idempotencyNotes}` : "") +
              tablesBlock,
            parameters: def.parameters,
          },
        });
      }
    }
  } catch (err: any) {
    console.warn("[ai-bot] adapter tool surface failed:", err?.message);
  }

  return tools;
}
