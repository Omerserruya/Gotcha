/**
 * Writing a tenant's integration connection.
 *
 * Extracted verbatim from routes/connectors-admin.ts so that more than one
 * entry point can create the SAME connection with the same side effects.
 * Shopify now has two: the OAuth callback (the merchant was signed in when
 * they started) and the deferred claim (the install began on Shopify, so the
 * workspace was only known after sign-in). Those two paths must produce an
 * identical connection - a second copy of this logic is how they would stop
 * doing that, and the difference would show up as a tenant whose tools were
 * never provisioned.
 *
 * The behaviour below is unchanged; only its address is new.
 */

import { prisma } from "@chatcenter/shared";
import { provisionIntegrationTools } from "./integration-provisioning.service";

export async function findCatalog(slug: string | string[] | undefined) {
  const s = Array.isArray(slug) ? slug[0] : slug;
  if (!s) return null;
  return await (prisma as any).integrationCatalog.findUnique({ where: { slug: String(s) } });
}


export async function upsertConnection(opts: {
  tenantId: string;
  catalogId: string;
  status: "CONNECTED" | "ERROR";
  credentialsBlob?: string;
  config?: Record<string, any>;
  connectedBy?: string;
  /** Why the connection is not usable. Persisted so the UI can show an
   *  actionable reason instead of a bare ERROR chip. Cleared on success. */
  lastError?: string;
}) {
  const data: any = {
    status: opts.status,
    connectedAt: new Date(),
    lastTestedAt: new Date(),
    lastTestResult: opts.status === "CONNECTED",
    lastError: opts.status === "CONNECTED" ? null : (opts.lastError ?? null),
  };
  if (opts.credentialsBlob !== undefined) data.credentials = opts.credentialsBlob;
  if (opts.connectedBy !== undefined) data.connectedBy = opts.connectedBy;
  // MERGE config on re-connect, never replace: config carries settings set
  // OUTSIDE the OAuth flow (useAsCrm, sync toggles) - a re-connect passing
  // only { shopDomain } used to wipe them (this is how Urban Supply lost
  // useAsCrm and CRM writeback silently stopped resolving).
  if (opts.config !== undefined) {
    const existing = await (prisma as any).tenantIntegration.findUnique({
      where: { tenantId_integrationId: { tenantId: opts.tenantId, integrationId: opts.catalogId } },
      select: { config: true },
    });
    data.config = { ...(existing?.config ?? {}), ...opts.config };
  }

  const create: any = {
    tenantId: opts.tenantId,
    integrationId: opts.catalogId,
    status: opts.status,
    connectedAt: data.connectedAt,
    lastTestedAt: data.lastTestedAt,
    lastTestResult: data.lastTestResult,
    credentials: opts.credentialsBlob ?? "",
    config: opts.config ?? {},
    connectedBy: opts.connectedBy ?? null,
  };
  const row = await (prisma as any).tenantIntegration.upsert({
    where: { tenantId_integrationId: { tenantId: opts.tenantId, integrationId: opts.catalogId } },
    update: data,
    create,
  });

  // A CONNECTED integration whose tools nobody granted is a connection that
  // does nothing. The AI's tool surface is built from AgentToolPermission
  // rows, and those were only ever created by one UI toggle - so Urban Supply
  // Dev reconnected to grant fulfillment scopes and silently lost every
  // Shopify tool. The connection stayed CONNECTED, the capability probe stayed
  // green, and the assistant answered a size question by asking which colour
  // and escalated a cancellation saying the tooling was unavailable. It was
  // right, and nothing anywhere said so.
  //
  // The FULL surface, not reads only.
  //
  // "Writes stay an explicit decision" is a reasonable sentence about a first
  // connect and a false one about a reconnect: disconnect deletes tenant tools
  // by cascade, so nobody decided anything - a cascade did. Part 6 caught this
  // live, on the day it mattered: an operator reconnected to grant the scopes
  // this round needed, and the reconnect left 42 of 68 tools present with every
  // single missing one a WRITE or an ACTION. Healthy store, green probe, and an
  // assistant that could look up any order and act on none.
  //
  // That is worse than having no tools, because the reads answer every
  // diagnostic anyone thinks to run - and reconnecting is the ONLY way to grant
  // a scope, so the operation that makes an assistant more capable is the one
  // that quietly disarms it.
  //
  // What keeps writes safe is where it always was: hitl_policy holds every
  // money-moving tool behind a human. Never a downgrade either - a row an
  // operator switched off is skipped, not re-enabled.
  //
  // Best-effort - a provisioning hiccup must not fail an otherwise good
  // connection, and the next connect retries it.
  if (opts.status === "CONNECTED") {
    try {
      const r = await provisionIntegrationTools(opts.tenantId, row.id, opts.catalogId, { reason: "connect" });
      if (r.granted > 0 || r.preserved > 0) {
        console.log(
          `[connectors] provisioned ${r.granted} tool permission(s) on connect for tenant=${opts.tenantId} ` +
            `(${JSON.stringify(r.byCategory)}, ${r.preserved} left as the operator set them)`,
        );
      }
    } catch (err: any) {
      console.error("[connectors] tool provisioning failed on connect:", err?.message);
    }
  }
  return row;
}
