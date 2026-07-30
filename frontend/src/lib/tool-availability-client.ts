/**
 * Client mirror of packages/shared/src/lib/tool-availability.ts (and the
 * classifier it depends on).
 *
 * The frontend is not an npm workspace and cannot import @chatcenter/shared at
 * runtime, so these rules are deliberately restated here. Restating a rule is
 * only safe if drift is caught: lib/__tests__/tool-availability-parity.test.ts
 * imports BOTH and fails the moment they disagree. Change one, change the other.
 */

export type ToolEffect = "read" | "action";

const KNOWN_READ_TOOLS = new Set<string>([
  "check_availability",
  "get_contact",
  "resolve_identity",
  "list_recent_messages",
  "get_conversation",
  "list_workflows",
  "preview_broadcast",
]);

const KNOWN_ACTION_TOOLS = new Set<string>([
  "schedule_meeting", "reschedule_meeting", "cancel_meeting",
  "integration_create_lead", "integration_create_contact", "integration_create_deal",
  "create_task", "create_ticket", "update_contact", "update_crm", "tag_contact",
  "merge_contacts", "link_customer_identifier", "send_message",
  "schedule_followup", "schedule_followup_template", "generate_followup",
  "create_broadcast", "schedule_broadcast", "create_workflow",
  "issue_refund", "refund", "apply_discount", "close_conversation", "escalate_to_human",
]);

// Verb at a name boundary (`get_x`, `hubspot.search_y`, `x.list`). ACTION is
// checked FIRST: a name that carries any mutating verb is an action even if it
// also reads (e.g. `get_or_create`).
const ACTION_VERB_RE =
  /(^|[._])(create|update|delete|remove|send|schedule|book|reschedule|cancel|refund|issue|charge|pay|merge|close|escalate|tag|link|apply|assign|move|convert|generate|post|set|sync|upsert)([._]|$)/i;
const READ_VERB_RE =
  /(^|[._])(get|list|search|find|lookup|read|fetch|describe|retrieve|check|view|query|resolve|preview|count|history)([._]|$)/i;

/**
 * Classify a tool by execution effect. Pure; never throws. Safe-biased:
 * unknown or ambiguous tools resolve to "action".
 */
export function classifyToolEffect(name: string): ToolEffect {
  // `submit_suggestions` is the Copilot's terminator - it returns output, it
  // does not touch anything - so it is genuinely a read.
  if (name === "submit_suggestions") return "read";
  // An EMPTY or missing name used to fall into that same branch and come back
  // as "read". That was harmless while the only consumer was the Copilot's
  // who-executes decision, but the sandbox write guard now asks the same
  // question to decide whether something may really run, and "unnamed
  // therefore safe" is the wrong default. An unrecognised name is an action,
  // exactly as this module's contract says.
  if (!name) return "action";
  if (KNOWN_ACTION_TOOLS.has(name)) return "action";
  if (KNOWN_READ_TOOLS.has(name)) return "read";
  if (ACTION_VERB_RE.test(name)) return "action";
  if (READ_VERB_RE.test(name)) return "read";
  return "action";
}

// ─── Risk grouping ──────────────────────────────────────────

/**
 * Risk groups, ordered least to most consequential. The UI groups rows by
 * these; the ordering is the display order, so it is part of the contract.
 */
export const RISK_GROUPS = [
  "read_only",
  "create_update",
  "delete",
  "financial",
  "sensitive_data",
  "administrative",
] as const;

export type RiskGroup = (typeof RISK_GROUPS)[number];

const FINANCIAL_RE =
  /(refund|charge|payment|invoice|discount|coupon|credit|price|billing|payout|subscription)/i;
const DELETE_RE = /(^|[._])(delete|destroy|remove|purge|erase|revoke)([._]|$)/i;
const SENSITIVE_RE =
  /(customer|contact|lead|person|identity|phone|email|address|gdpr|consent|pii)/i;
const ADMIN_RE =
  /(^|[._])(admin|role|permission|user|member|tenant|settings|config|integration|apikey|token|webhook)([._]|$)/i;

/**
 * Classify a tool into a risk group.
 *
 * Order matters and is deliberate: financial beats delete beats admin beats
 * sensitive-data, because a refund is the thing an operator most needs to see
 * grouped separately even though its name also matches "customer". Reads are
 * only ever read_only - a lookup of sensitive data is still a lookup, and
 * burying it under "sensitive" would push harmless tools into a scary group and
 * teach people to ignore the grouping.
 */
export function riskGroupFor(toolName: string): RiskGroup {
  const name = String(toolName || "");
  if (classifyToolEffect(name) === "read") return "read_only";
  if (FINANCIAL_RE.test(name)) return "financial";
  if (DELETE_RE.test(name)) return "delete";
  if (ADMIN_RE.test(name)) return "administrative";
  if (SENSITIVE_RE.test(name)) return "sensitive_data";
  return "create_update";
}

/** Groups that must never be silently auto-approved. */
const NEVER_AUTO_APPROVE: ReadonlySet<RiskGroup> = new Set<RiskGroup>([
  "delete",
  "financial",
  "administrative",
]);

/**
 * May this tool be set to "always allow"?
 *
 * A product may decide to permit it explicitly, but the default answer for
 * irreversible and money-moving operations is no: the cost of a wrong
 * always-allow there is a refund nobody authorised.
 */
export function mayBeAlwaysAllowed(group: RiskGroup, productPolicyPermits = false): boolean {
  if (!NEVER_AUTO_APPROVE.has(group)) return true;
  return productPolicyPermits;
}

/** The setting we recommend, and pre-select on "restore recommended defaults". */
export function recommendedState(group: RiskGroup): "always_allow" | "require_approval" {
  return group === "read_only" ? "always_allow" : "require_approval";
}

// ─── Availability ───────────────────────────────────────────

/**
 * What the admin's switch can be, plus the one state their switch does not
 * control. `unavailable` is not a preference - it is the platform saying this
 * tool cannot run right now no matter what the switch says.
 */
export type PermissionState =
  | "always_allow"
  | "require_approval"
  | "disabled"
  | "unavailable";

/** Why a tool is unavailable. `ok` means it really is the admin's choice. */
export type UnavailableReason =
  | "ok"
  | "integration_disconnected"
  | "missing_scope"
  | "plan_not_entitled"
  | "no_catalog_entry";

export interface ToolAvailabilityInput {
  toolName: string;
  /** Admin's stored preference. */
  enabled: boolean;
  requiresApproval: boolean;
  /** Integration-backed tools only: is the provider connected right now? */
  integrationConnected?: boolean;
  /** Provider scopes this tool needs, and the ones actually granted. */
  requiredScopes?: string[];
  grantedScopes?: string[];
  /**
   * The runtime's OWN verdict (toolBlockedByMissingScopes against
   * config.missingScopes). When present it wins over the required-vs-granted
   * comparison below: the enforcement source is `missingScopes`, which is
   * populated from real provider errors, and a UI that re-derives the answer
   * from two scope lists will eventually disagree with the code that actually
   * blocks the call.
   */
  scopeBlocked?: boolean;
  /** Which required scopes are known-missing, when the runtime says so. */
  missingScopes?: string[];
  /** Does the tenant's plan include the feature this tool belongs to? */
  planEntitled?: boolean;
  /** Dotted/integration tools with no CatalogTool row are denied at dispatch. */
  hasCatalogEntry?: boolean;
}

export interface ToolAvailability {
  state: PermissionState;
  reason: UnavailableReason;
  /** Scopes that are required but not granted. Empty unless missing_scope. */
  missingScopes: string[];
  riskGroup: RiskGroup;
  /** True when the stored preference is currently overridden by the platform. */
  overriddenByPlatform: boolean;
}

/**
 * Resolve what the row should actually say.
 *
 * Reasons are checked in the order the admin can act on them: an unentitled
 * plan cannot be fixed by connecting anything, a disconnected integration
 * cannot be fixed by granting scopes, and a missing scope cannot be fixed by
 * toggling the switch. Reporting the wrong one sends them to the wrong screen.
 */
export function resolveToolAvailability(input: ToolAvailabilityInput): ToolAvailability {
  const riskGroup = riskGroupFor(input.toolName);
  const base = { missingScopes: [] as string[], riskGroup };

  if (input.planEntitled === false) {
    return { ...base, state: "unavailable", reason: "plan_not_entitled", overriddenByPlatform: true };
  }
  if (input.hasCatalogEntry === false) {
    return { ...base, state: "unavailable", reason: "no_catalog_entry", overriddenByPlatform: true };
  }
  if (input.integrationConnected === false) {
    return { ...base, state: "unavailable", reason: "integration_disconnected", overriddenByPlatform: true };
  }

  // Prefer the runtime's verdict when it gave one.
  if (input.scopeBlocked === true) {
    return {
      ...base,
      state: "unavailable",
      reason: "missing_scope",
      missingScopes: input.missingScopes ?? [],
      overriddenByPlatform: true,
    };
  }
  // Fall back to comparing declared-required against granted. Only used when
  // the caller could not supply a verdict (e.g. a provider with no adapter
  // ToolDefinition), so an absent verdict never means "definitely fine".
  if (input.scopeBlocked !== false) {
    const required = input.requiredScopes ?? [];
    if (required.length > 0) {
      const granted = new Set(input.grantedScopes ?? []);
      const missing = required.filter((s) => !granted.has(s));
      if (missing.length > 0) {
        return { ...base, state: "unavailable", reason: "missing_scope", missingScopes: missing, overriddenByPlatform: true };
      }
    }
  }

  // Everything the platform controls is satisfied, so the switch is genuinely
  // the admin's.
  if (!input.enabled) {
    return { ...base, state: "disabled", reason: "ok", overriddenByPlatform: false };
  }
  return {
    ...base,
    state: input.requiresApproval ? "require_approval" : "always_allow",
    reason: "ok",
    overriddenByPlatform: false,
  };
}

// ─── Counts for the summary card ────────────────────────────

export interface ToolCounts {
  total: number;
  /** Tools that can actually run: always-allow plus require-approval. */
  enabled: number;
  alwaysAllow: number;
  requireApproval: number;
  disabled: number;
  unavailable: number;
}

/**
 * "8 of 8 tools enabled".
 *
 * `enabled` counts what can actually run, so an unavailable tool is never
 * counted as enabled just because the stored preference says so - that headline
 * is the first thing an operator reads, and it has to be true.
 */
export function summarizeTools(availabilities: ToolAvailability[]): ToolCounts {
  const counts: ToolCounts = {
    total: availabilities.length,
    enabled: 0, alwaysAllow: 0, requireApproval: 0, disabled: 0, unavailable: 0,
  };
  for (const a of availabilities) {
    if (a.state === "always_allow") { counts.alwaysAllow += 1; counts.enabled += 1; }
    else if (a.state === "require_approval") { counts.requireApproval += 1; counts.enabled += 1; }
    else if (a.state === "disabled") counts.disabled += 1;
    else counts.unavailable += 1;
  }
  return counts;
}

/** Group tools for display, in RISK_GROUPS order, skipping empty groups. */
export function groupByRisk<T extends { riskGroup: RiskGroup }>(rows: T[]): Array<[RiskGroup, T[]]> {
  const map = new Map<RiskGroup, T[]>();
  for (const r of rows) {
    if (!map.has(r.riskGroup)) map.set(r.riskGroup, []);
    map.get(r.riskGroup)!.push(r);
  }
  return RISK_GROUPS.filter((g) => map.has(g)).map((g) => [g, map.get(g)!]);
}

// ─── Bulk actions ───────────────────────────────────────────

export type BulkAction =
  | "enable_all_read_only"
  | "require_approval_for_all_writes"
  | "disable_all"
  | "restore_recommended";

/** Which bulk actions need a confirmation before they run. */
export function bulkActionNeedsConfirmation(action: BulkAction): boolean {
  // Enabling reads is additive and low risk. Everything else either turns
  // capability off wholesale or rewrites approval policy across the board.
  return action !== "enable_all_read_only";
}

/**
 * What a bulk action would change, per tool. Returns only the tools it would
 * actually touch, so the confirmation can state a real number instead of "all".
 * Unavailable tools are never included: their state is not the admin's to set.
 */
export function planBulkAction<T extends { toolName: string; riskGroup: RiskGroup; state: PermissionState }>(
  action: BulkAction,
  rows: T[],
): Array<{ toolName: string; enabled: boolean; requiresApproval: boolean }> {
  const actionable = rows.filter((r) => r.state !== "unavailable");
  const out: Array<{ toolName: string; enabled: boolean; requiresApproval: boolean }> = [];

  for (const r of actionable) {
    if (action === "enable_all_read_only") {
      if (r.riskGroup === "read_only" && r.state !== "always_allow") {
        out.push({ toolName: r.toolName, enabled: true, requiresApproval: false });
      }
    } else if (action === "require_approval_for_all_writes") {
      if (r.riskGroup !== "read_only" && r.state !== "require_approval") {
        out.push({ toolName: r.toolName, enabled: true, requiresApproval: true });
      }
    } else if (action === "disable_all") {
      if (r.state !== "disabled") out.push({ toolName: r.toolName, enabled: false, requiresApproval: r.riskGroup !== "read_only" });
    } else {
      const want = recommendedState(r.riskGroup);
      const already = r.state === want;
      if (!already) out.push({ toolName: r.toolName, enabled: true, requiresApproval: want === "require_approval" });
    }
  }
  return out;
}
