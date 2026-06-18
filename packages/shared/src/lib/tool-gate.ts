/**
 * Unified tool policy gate - `evaluatePolicies()`.
 *
 * The single entry point every tool invocation flows through. HITL is a
 * TENANT-LEVEL concern: the tenant toggle is authoritative.
 *
 *   1. CatalogTool.hitlPolicy / SYSTEM_TOOL_POLICIES - the SEED for new tenants
 *   2. TenantTool.configOverrides.hitlPolicy / TenantToolPermission - AUTHORITATIVE
 *   3. AgentToolPermission.isAllowed - controls *access* to the tool (not HITL)
 *
 * When a tenant override is set (a row exists or `configOverrides.hitlPolicy`
 * is populated), that override DECIDES the gate - it can both loosen and
 * tighten the catalog default. When no override is set, the catalog default
 * applies.
 *
 * Per-agent `requireApproval` is intentionally NOT consulted here - HITL is
 * not a per-agent decision. The agent-level permission row is read only to
 * confirm the agent has access (`isAllowed`).
 *
 * `evaluateToolGate()` is kept as a thin back-compat shim. New call sites
 * should use `evaluatePolicies()`.
 */
import { prisma } from "./prisma";

// ─── Types ──────────────────────────────────────────────────

export type HitlMode = "never" | "always" | "on_condition";

export interface HitlPolicy {
  mode: HitlMode;
  condition?: string;
  approverRole?: string | null;
  notifyChannels?: string[];
  expiresAfterMin?: number;
  allowModification?: boolean;
}

export type ToolGateDecision = "ALLOW" | "DENY" | "REQUIRE_APPROVAL";

export interface PolicySnapshot {
  catalog?: HitlPolicy;
  tenant?: HitlPolicy;
  agent?: { requireApproval?: boolean; approverRole?: string | null };
}

export interface PolicyResult {
  decision: ToolGateDecision;
  reason: string;
  effective: HitlPolicy;
  snapshot: PolicySnapshot;
  approvalConfig?: {
    approverRole: string | null;
    notifyChannels: string[];
    expiresAfterMin: number;
    allowModification: boolean;
  };
}

// ─── Static tool policies ────────────────────────────────────
// Tools defined in the TOOL_REGISTRY (send_message, escalate_to_human, …) have
// no CatalogTool row. Their floor policy lives here. Tenants can still tighten
// via TenantToolPermission rows.

const SYSTEM_TOOL_POLICIES: Record<string, HitlPolicy> = {
  // Low-risk / context tools - always allowed.
  link_customer_identifier:    { mode: "never" },
  escalate_to_human:           { mode: "never" },
  close_conversation:          { mode: "never" },
  tag_contact:                 { mode: "never" },
  generate_followup:           { mode: "never" },

  // Write-side / external-facing - require approval by default.
  send_message:                { mode: "always" },
  create_broadcast:            { mode: "always" },
  schedule_broadcast:          { mode: "always" },
  schedule_followup:           { mode: "always" },
  schedule_followup_template:  { mode: "always" },
  // Risk-based, not blanket HITL: a booking is reversible (cancel_event) and is
  // a core autonomous action, so short meetings auto-book and only longer ones
  // need a human nod. Tune per tenant via TenantToolPermission, or widen the
  // condition (e.g. contains(args.meeting_type, 'enterprise')).
  schedule_meeting:            { mode: "on_condition", condition: "args.duration_minutes > 60" },
  // Financial actions - approval is MANDATORY per CLAUDE.md §9 (refunds,
  // discounts). Floored to `always`; do NOT relax to a threshold that would
  // auto-execute small amounts. Tenants may only tighten, never loosen, via
  // TenantToolPermission. The on_condition pattern (see schedule_meeting) is
  // reserved for REVERSIBLE actions only.
  issue_refund:                { mode: "always" },
  refund:                      { mode: "always" },
  apply_discount:              { mode: "always" },
  merge_contacts:              { mode: "always" },
  update_contact:              { mode: "always" },
  update_crm:                  { mode: "always" },
  create_ticket:               { mode: "always" },
  create_task:                 { mode: "always" },
  create_workflow:             { mode: "always" },
};

// ─── Core evaluator ─────────────────────────────────────────

export async function evaluatePolicies(opts: {
  tenantId: string;
  toolName: string;
  aiAgentId?: string;
  args?: unknown;
}): Promise<PolicyResult> {
  if (!opts.toolName) {
    return denyResult("missing tool name", {});
  }

  const snapshot: PolicySnapshot = {};

  // Layer 1: catalog floor
  //   Integration tools → CatalogTool.hitlPolicy
  //   Static tools → SYSTEM_TOOL_POLICIES map
  let catalog: HitlPolicy;
  let tenantToolId: string | null = null;
  let tenantToolEnabled = true;

  if (opts.toolName.startsWith("integration_") || opts.toolName.includes(".")) {
    // Dynamic integration tool. Resolve via CatalogTool.
    //
    // Two name shapes flow through here:
    //   - "integration_<slug>"  / "integration.<slug>"  (legacy catalog-tool dispatch)
    //   - "<provider>.<tool>"                            (adapter-framework dispatch,
    //                                                     e.g. "stripe.refund_payment")
    //
    // Adapter names MUST be disambiguated by integration.slug - multiple
    // integrations expose the same tool slug (refund_payment, get_order,
    // search_customers, …). A slug-only lookup picks the first match and
    // applies the wrong HITL policy → unsafe gate decisions.
    let toolSlugLookup: string;
    let integrationSlugLookup: string | undefined;
    if (/^integration[_.]/.test(opts.toolName)) {
      toolSlugLookup = opts.toolName.replace(/^integration[_.]/, "");
    } else {
      const dot = opts.toolName.indexOf(".");
      integrationSlugLookup = opts.toolName.slice(0, dot);
      toolSlugLookup = opts.toolName.slice(dot + 1);
    }

    const tenantTool = await (prisma as any).tenantTool?.findFirst?.({
      where: {
        tenantId: opts.tenantId,
        catalogTool: integrationSlugLookup
          ? { slug: toolSlugLookup, integration: { slug: integrationSlugLookup } }
          : { slug: toolSlugLookup },
      },
      include: { catalogTool: true },
    });

    if (!tenantTool) {
      const ref = integrationSlugLookup
        ? `${integrationSlugLookup}.${toolSlugLookup}`
        : toolSlugLookup;
      return denyResult(`no tenant tool for "${ref}"`, {});
    }
    tenantToolId = tenantTool.id;
    tenantToolEnabled = tenantTool.isEnabled;

    catalog = (tenantTool.catalogTool?.hitlPolicy as HitlPolicy) ?? { mode: "never" };
  } else {
    // Static / system tool.
    catalog = SYSTEM_TOOL_POLICIES[opts.toolName] ?? { mode: "never" };
  }
  snapshot.catalog = catalog;

  // Layer 2: tenant override (AUTHORITATIVE)
  //   Integration tools → TenantTool.configOverrides.hitlPolicy
  //   Static tools → TenantToolPermission row
  //
  // The tenant toggle decides the gate in BOTH directions: a row that exists
  // and is set to requiresApproval=false explicitly opts the tool OUT of
  // approval, even if the catalog default is "always". Absence of a row means
  // "no explicit override" - fall through to catalog default.
  let tenant: HitlPolicy | null = null;
  if (tenantToolId) {
    const overrides = await (prisma as any).tenantTool?.findUnique?.({
      where: { id: tenantToolId },
      select: { configOverrides: true, isEnabled: true },
    });
    tenantToolEnabled = overrides?.isEnabled ?? true;
    const overrideHitl = (overrides?.configOverrides as any)?.hitlPolicy as HitlPolicy | undefined;
    if (overrideHitl) tenant = overrideHitl;
  } else {
    // Static tool - TenantToolPermission row is the explicit override.
    const row = await (prisma as any).tenantToolPermission?.findUnique?.({
      where: { tenantId_toolName: { tenantId: opts.tenantId, toolName: opts.toolName } },
    }).catch(() => null);

    if (row) {
      if (!row.enabled) return denyResult(`tool "${opts.toolName}" disabled at tenant level`, { ...snapshot, tenant: { mode: "always" } });
      // Row exists ⇒ tenant has explicitly set a policy. Honour it both ways.
      tenant = row.requiresApproval
        ? {
            mode: "always",
            approverRole: row.approverRole ?? null,
            notifyChannels: row.notifyChannels ?? ["in_app"],
            expiresAfterMin: row.expiresAfterMin ?? 30,
            allowModification: row.allowModification ?? false,
          }
        : { mode: "never" };
    }
  }
  if (tenant) snapshot.tenant = tenant;

  if (!tenantToolEnabled) {
    return denyResult(`tool "${opts.toolName}" disabled at tenant level`, snapshot);
  }

  // Layer 3: agent access (NOT a HITL decision).
  // Per-agent rows govern WHICH tools an agent may call. They do NOT influence
  // approval gating - HITL lives at the tenant level only.
  if (opts.aiAgentId && tenantToolId) {
    const grant = await (prisma as any).agentToolPermission?.findFirst?.({
      where: { tenantId: opts.tenantId, aiAgentId: opts.aiAgentId, tenantToolId },
    });
    if (!grant || !grant.isAllowed) {
      return denyResult(`tool not granted to agent "${opts.aiAgentId}"`, snapshot);
    }
  }

  // Compose: tenant authoritative when set, else catalog default.
  const effective = composeAuthoritative(catalog, tenant);

  // Materialise the decision
  if (effective.mode === "never") {
    return {
      decision: "ALLOW",
      reason: `policy allows (catalog=${catalog.mode}${tenant ? `, tenant=${tenant.mode}` : ""})`,
      effective,
      snapshot,
    };
  }
  if (effective.mode === "always") {
    return {
      decision: "REQUIRE_APPROVAL",
      reason: `policy requires approval (catalog=${catalog.mode}${tenant ? `, tenant=${tenant.mode}` : ""})`,
      effective,
      snapshot,
      approvalConfig: {
        approverRole: effective.approverRole ?? null,
        notifyChannels: effective.notifyChannels ?? ["in_app"],
        expiresAfterMin: effective.expiresAfterMin ?? 30,
        allowModification: effective.allowModification ?? false,
      },
    };
  }
  // on_condition - evaluate against args
  const hit = evaluateCondition(effective.condition, opts.args);
  if (hit) {
    return {
      decision: "REQUIRE_APPROVAL",
      reason: `condition matched: ${effective.condition}`,
      effective,
      snapshot,
      approvalConfig: {
        approverRole: effective.approverRole ?? null,
        notifyChannels: effective.notifyChannels ?? ["in_app"],
        expiresAfterMin: effective.expiresAfterMin ?? 30,
        allowModification: effective.allowModification ?? false,
      },
    };
  }
  return { decision: "ALLOW", reason: "condition not matched", effective, snapshot };
}

// ─── Composition: tenant authoritative when set ─────────────
//
// HITL is a tenant-level decision. When the tenant has set an explicit policy
// (a TenantToolPermission row exists, or TenantTool.configOverrides.hitlPolicy
// is populated), that policy decides the gate - including loosening a catalog
// "always" floor down to "never". Without an explicit tenant override, we
// fall back to the catalog default, which seeds new tenants with safe values.

function composeAuthoritative(
  catalog: HitlPolicy,
  tenant: HitlPolicy | null,
): HitlPolicy {
  if (tenant) {
    return {
      mode: tenant.mode,
      condition: tenant.condition ?? catalog.condition,
      approverRole: tenant.approverRole ?? catalog.approverRole ?? null,
      notifyChannels: tenant.notifyChannels ?? catalog.notifyChannels ?? ["in_app"],
      expiresAfterMin: tenant.expiresAfterMin ?? catalog.expiresAfterMin ?? 30,
      allowModification: tenant.allowModification ?? catalog.allowModification ?? false,
    };
  }
  return {
    mode: catalog.mode,
    condition: catalog.condition,
    approverRole: catalog.approverRole ?? null,
    notifyChannels: catalog.notifyChannels ?? ["in_app"],
    expiresAfterMin: catalog.expiresAfterMin ?? 30,
    allowModification: catalog.allowModification ?? false,
  };
}

// ─── Simple CEL-lite condition evaluator ────────────────────
// Supports: `args.amount > 100`, `args.currency == 'USD'`, `contains(args.tags, 'vip')`.
// Deliberately tiny - no external dependency. Expand later if needed.

function evaluateCondition(condition: string | undefined, args: unknown): boolean {
  if (!condition) return false;
  const expr = condition.trim();
  try {
    // Fallback: empty args → false for any condition that references args
    if (expr.includes("args.") && (!args || typeof args !== "object")) return false;

    // Narrow set of operators. No eval.
    const gtMatch  = expr.match(/^args\.(\w+)\s*(>|>=|<|<=|==|!=)\s*(-?\d+(?:\.\d+)?|'[^']*'|"[^"]*")$/);
    if (gtMatch) {
      const [, field, op, rawValue] = gtMatch;
      const actual = (args as Record<string, unknown>)[field];
      const expected = rawValue.startsWith("'") || rawValue.startsWith('"')
        ? rawValue.slice(1, -1)
        : Number(rawValue);
      const actualNum = Number(actual);
      const expectedNum = typeof expected === "number" ? expected : Number(expected);
      switch (op) {
        case ">":  return actualNum >   expectedNum;
        case ">=": return actualNum >=  expectedNum;
        case "<":  return actualNum <   expectedNum;
        case "<=": return actualNum <=  expectedNum;
        case "==": return actual === expected;
        case "!=": return actual !== expected;
      }
    }
    const containsMatch = expr.match(/^contains\(args\.(\w+),\s*'([^']*)'\)$/);
    if (containsMatch) {
      const [, field, value] = containsMatch;
      const actual = (args as Record<string, unknown>)[field];
      if (Array.isArray(actual)) return actual.includes(value);
      if (typeof actual === "string") return actual.includes(value);
      return false;
    }
  } catch {
    return false;
  }
  return false;
}

// ─── Helpers ────────────────────────────────────────────────

function denyResult(reason: string, snapshot: PolicySnapshot): PolicyResult {
  return {
    decision: "DENY",
    reason,
    effective: { mode: "always" },
    snapshot,
  };
}

// ─── Back-compat shim ───────────────────────────────────────
// Legacy callers (action-executor, agent-tools.dispatchToolCall) use a
// simpler (tenantId, toolName) → ToolGateResult signature. This keeps them
// working until migrated to evaluatePolicies().

export interface ToolGateResult {
  decision: ToolGateDecision;
  reason: string;
  approvalConfig?: PolicyResult["approvalConfig"];
}

export async function evaluateToolGate(
  tenantId: string,
  toolName: string,
  aiAgentId?: string,
): Promise<ToolGateResult> {
  const r = await evaluatePolicies({ tenantId, toolName, aiAgentId });
  return { decision: r.decision, reason: r.reason, approvalConfig: r.approvalConfig };
}

/**
 * List all tool names that default to REQUIRE_APPROVAL (used by onboarding
 * to seed tenant tool permissions + admin UI "which tools are gated by default").
 */
export function getDefaultHighRiskTools(): string[] {
  return Object.entries(SYSTEM_TOOL_POLICIES)
    .filter(([, p]) => p.mode === "always")
    .map(([name]) => name);
}
