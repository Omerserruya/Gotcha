/**
 * Is this integration actually usable by the assistant?
 *
 * Every health signal the product had answered a different question, and all of
 * them said yes while the answer to this one was no:
 *
 *   connection status   CONNECTED
 *   capability probe    green
 *   granted scopes      all present
 *   assistant           42 read tools, zero write, zero action
 *
 * A merchant reconnected to grant scopes. The reconnect deleted the tool rows by
 * cascade and re-provisioned only reads, and nothing anywhere noticed, because
 * every check asked about the CONNECTION and none asked what the assistant could
 * do. The reads even answered each diagnostic convincingly - you can look up any
 * order right up until you try to cancel one.
 *
 * So this checks the layers separately and reports where the chain breaks. The
 * distinction that matters most is between a tool that is UNAVAILABLE (scope
 * missing, provider unreachable) and one that is DISABLED (the tenant decided),
 * because they look identical from the assistant's side and mean opposite things
 * to whoever is fixing it.
 *
 * Nothing here reads or returns credential material. Decryptability is reported
 * as a boolean, which is the only part of it anyone diagnosing this needs.
 */

import { prisma, decryptCredentials } from "@chatcenter/shared";

/**
 * Scope and capability state, read straight off the connection config.
 *
 * Deliberately local and defensive rather than importing a helper: these fields
 * are written by the capability-probe work and may simply be absent, and health
 * reporting must degrade to "we do not know" rather than fail. Absent is a
 * legitimate state, not an error.
 */
function grantedScopesFrom(config: any): string[] {
  const v = config?.capabilityState?.grantedScopes;
  return Array.isArray(v) ? v.filter((s: unknown): s is string => typeof s === "string") : [];
}
function missingScopesFrom(config: any): string[] {
  const v = config?.missingScopes;
  return Array.isArray(v) ? v.filter((s: unknown): s is string => typeof s === "string") : [];
}
function probeStateFrom(config: any): { status: string | null; lastCheckedAt: string | null } {
  const cs = config?.capabilityState;
  return {
    status: typeof cs?.status === "string" ? cs.status : null,
    lastCheckedAt: typeof cs?.lastCheckedAt === "string" ? cs.lastCheckedAt : null,
  };
}

export type IntegrationHealthStatus =
  | "HEALTHY"
  | "CONNECTED_BUT_UNPROVISIONED"
  | "MISSING_SCOPES"
  | "POLICY_MISSING"
  | "PARTIALLY_AVAILABLE"
  | "CREDENTIAL_ERROR"
  | "REAUTH_REQUIRED"
  | "DISCONNECTED"
  | "NOT_CONNECTED";

export interface ToolCounts {
  expected: number;
  provisioned: number;
  availableUnderScopes: number;
  enabledByPolicy: number;
  explicitlyDisabled: number;
  missing: number;
}

export interface IntegrationHealth {
  slug: string;
  status: IntegrationHealthStatus;
  /** One line a human can act on. Never contains credentials or provider errors verbatim. */
  summary: string;
  connection: {
    exists: boolean;
    status: string | null;
    connectedAt: string | null;
    disconnectedAt: string | null;
  };
  credentials: {
    present: boolean;
    /** Whether the stored blob could be decrypted. Never the contents. */
    decryptable: boolean;
  };
  scopes: { granted: number; missing: string[] };
  capabilityProbe: { status: string | null; lastCheckedAt: string | null };
  tools: {
    total: ToolCounts;
    byCategory: Record<string, ToolCounts>;
  };
  /** Tools the tenant turned off. Named, because "missing" and "off" are different problems. */
  disabledTools: string[];
  /** Tools carrying an explicit HITL policy. */
  hitlTools: string[];
  /** What an admin can do about it, if anything. */
  remediation: Array<"reprovision_missing_tools" | "reconnect_for_scopes" | "reconnect_for_credentials" | "inspect_disabled_tools">;
}

function emptyCounts(): ToolCounts {
  return { expected: 0, provisioned: 0, availableUnderScopes: 0, enabledByPolicy: 0, explicitlyDisabled: 0, missing: 0 };
}

/**
 * Assess one integration for one tenant.
 *
 * Read-only and side-effect free: this is a diagnostic, and a diagnostic that
 * repairs things hides the very state somebody is trying to understand.
 * Remediation is offered as a list of actions, never performed.
 */
export async function assessIntegrationHealth(
  tenantId: string,
  slug: string,
): Promise<IntegrationHealth> {
  const base: IntegrationHealth = {
    slug,
    status: "NOT_CONNECTED",
    summary: `${slug} is not connected for this tenant.`,
    connection: { exists: false, status: null, connectedAt: null, disconnectedAt: null },
    credentials: { present: false, decryptable: false },
    scopes: { granted: 0, missing: [] },
    capabilityProbe: { status: null, lastCheckedAt: null },
    tools: { total: emptyCounts(), byCategory: {} },
    disabledTools: [],
    hitlTools: [],
    remediation: [],
  };

  const catalog: any = await (prisma as any).integrationCatalog.findUnique({ where: { slug } });
  if (!catalog) return { ...base, summary: `${slug} is not in the integration catalogue.` };

  const ti: any = await (prisma as any).tenantIntegration.findUnique({
    where: { tenantId_integrationId: { tenantId, integrationId: catalog.id } },
  });
  if (!ti) return base;

  base.connection = {
    exists: true,
    status: ti.status ?? null,
    connectedAt: ti.connectedAt ? new Date(ti.connectedAt).toISOString() : null,
    disconnectedAt: ti.disconnectedAt ? new Date(ti.disconnectedAt).toISOString() : null,
  };

  // Credentials: presence and decryptability only. The contents are never read
  // into the result, and never logged.
  const rawCreds = ti.credentials;
  const present = typeof rawCreds === "string" ? rawCreds.length > 0 : !!rawCreds && Object.keys(rawCreds).length > 0;
  let decryptable = false;
  if (present) {
    try {
      const c = typeof rawCreds === "string" ? decryptCredentials(rawCreds) : rawCreds;
      decryptable = !!c && typeof c === "object";
    } catch {
      decryptable = false;
    }
  }
  base.credentials = { present, decryptable };

  base.scopes = { granted: grantedScopesFrom(ti.config).length, missing: missingScopesFrom(ti.config) };
  base.capabilityProbe = probeStateFrom(ti.config);

  // ── The layer nothing used to check: what does the assistant actually hold ──
  const catalogTools: any[] = await (prisma as any).catalogTool.findMany({
    where: { integrationId: catalog.id },
    select: { id: true, slug: true, category: true },
  });
  const tenantTools: any[] = await (prisma as any).tenantTool.findMany({
    where: { tenantId, tenantIntegrationId: ti.id },
    select: { id: true, catalogToolId: true, isEnabled: true, configOverrides: true },
  });
  const byCatalogId = new Map(tenantTools.map((t) => [t.catalogToolId, t]));

  // Scope availability is assessed at the CONNECTION level, because that is the
  // granularity this codebase currently records it at: `config.missingScopes`
  // is a flat list, and tool definitions do not yet declare what they need. So
  // a provisioned tool counts as available unless the connection is known to be
  // missing scopes at all. Reporting a per-tool number we cannot actually
  // derive would be worse than reporting a coarse one honestly.
  const scopesKnownMissing = base.scopes.missing.length > 0;

  const counts: Record<string, ToolCounts> = {};
  const total = emptyCounts();
  for (const ct of catalogTools) {
    const cat = String(ct.category ?? "UNKNOWN");
    counts[cat] ??= emptyCounts();
    counts[cat].expected += 1;
    total.expected += 1;

    const tt = byCatalogId.get(ct.id);
    if (!tt) {
      counts[cat].missing += 1;
      total.missing += 1;
      continue;
    }
    counts[cat].provisioned += 1;
    total.provisioned += 1;

    // A tool the shop cannot execute is UNAVAILABLE. A tool the tenant turned
    // off is DISABLED. Reporting them as one number is how "the assistant has
    // no write tools" reads as a scope problem when it is a policy decision, or
    // the reverse.
    if (!scopesKnownMissing) {
      counts[cat].availableUnderScopes += 1;
      total.availableUnderScopes += 1;
    }

    if (tt.isEnabled) {
      counts[cat].enabledByPolicy += 1;
      total.enabledByPolicy += 1;
    } else {
      counts[cat].explicitlyDisabled += 1;
      total.explicitlyDisabled += 1;
      base.disabledTools.push(ct.slug);
    }

    const hitl = (tt.configOverrides as any)?.hitlPolicy;
    if (hitl?.mode === "always") base.hitlTools.push(ct.slug);
  }
  base.tools = { total, byCategory: counts };

  return { ...base, ...verdict(base) };
}

/**
 * Turn the layers into one status and one actionable sentence.
 *
 * Ordered by what a person should fix first. `CONNECTED_BUT_UNPROVISIONED` is
 * deliberately its own status rather than a flavour of unhealthy: it is the
 * exact state that was invisible before, and naming it is the point.
 */
function verdict(h: IntegrationHealth): Pick<IntegrationHealth, "status" | "summary" | "remediation"> {
  const t = h.tools.total;
  const remediation: IntegrationHealth["remediation"] = [];

  if (h.connection.status === "DISCONNECTED") {
    // Policy surviving a disconnect is the fixed behaviour, so say so - somebody
    // seeing configuration on a disconnected integration should know it is
    // intentional and will be honoured when they reconnect.
    return {
      status: "DISCONNECTED",
      summary:
        `${h.slug} is disconnected. ${t.provisioned} tool policy row(s) are preserved and will be restored on reconnect` +
        (t.explicitlyDisabled ? `, including ${t.explicitlyDisabled} the tenant turned off.` : "."),
      remediation: ["reconnect_for_credentials"],
    };
  }
  if (!h.credentials.present || !h.credentials.decryptable) {
    return {
      status: h.credentials.present ? "CREDENTIAL_ERROR" : "REAUTH_REQUIRED",
      summary: h.credentials.present
        ? `${h.slug} has stored credentials that cannot be decrypted. Re-connect to replace them.`
        : `${h.slug} is marked ${h.connection.status} but holds no credentials. Re-connect.`,
      remediation: ["reconnect_for_credentials"],
    };
  }
  if (t.expected > 0 && t.provisioned === 0) {
    return {
      status: "CONNECTED_BUT_UNPROVISIONED",
      summary:
        `${h.slug} is connected and the assistant has NO tools: 0 of ${t.expected} provisioned. ` +
        `A green connection is not evidence the assistant can do anything.`,
      remediation: ["reprovision_missing_tools"],
    };
  }
  if (t.missing > 0) {
    // The exact live shape: reads present, writes and actions absent.
    const missingByCat = Object.entries(h.tools.byCategory)
      .filter(([, c]) => c.missing > 0)
      .map(([cat, c]) => `${cat} ${c.missing}`)
      .join(", ");
    return {
      status: "CONNECTED_BUT_UNPROVISIONED",
      summary: `${h.slug} is connected but ${t.missing} of ${t.expected} tools are not provisioned (${missingByCat}).`,
      remediation: ["reprovision_missing_tools"],
    };
  }
  if (h.scopes.missing.length) {
    return {
      status: "MISSING_SCOPES",
      summary:
        `${h.slug} is missing ${h.scopes.missing.length} scope(s), so ${t.expected - t.availableUnderScopes} tool(s) ` +
        `cannot execute. Their policy is intact and returns automatically when the scope is granted.`,
      remediation: ["reconnect_for_scopes"],
    };
  }
  if (t.enabledByPolicy === 0 && t.expected > 0) {
    return {
      status: "POLICY_MISSING",
      summary: `${h.slug} is connected and fully provisioned, but every tool is disabled by tenant policy.`,
      remediation: ["inspect_disabled_tools"],
    };
  }
  if (t.explicitlyDisabled > 0) {
    if (remediation.length === 0) remediation.push("inspect_disabled_tools");
    return {
      status: "PARTIALLY_AVAILABLE",
      summary:
        `${h.slug} is healthy. ${t.enabledByPolicy} of ${t.expected} tools are enabled; ` +
        `${t.explicitlyDisabled} are switched off by tenant policy, which is a decision, not a fault.`,
      remediation,
    };
  }
  return {
    status: "HEALTHY",
    summary: `${h.slug} is connected, fully provisioned and fully enabled (${t.enabledByPolicy}/${t.expected}).`,
    remediation: [],
  };
}
