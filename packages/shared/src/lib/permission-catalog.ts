/**
 * Permission Catalog - the SINGLE SOURCE OF TRUTH for RBAC, licensing and
 * future packaging.
 *
 * Everything authorization-related is derived from this file:
 *   • RBAC        → which permission keys a role/user holds
 *   • Licensing   → which feature/sub-feature a plan (tenant) entitles
 *   • Packaging   → plans are just sets of license keys (see plans.ts)
 *   • UI          → nav/buttons/pages react to the effective permission set
 *
 * Design rules (do not violate):
 *   1. Permissions are CAPABILITIES, never screens. Format is strictly
 *      `feature:sub-feature:action` (3 segments, lower-kebab).
 *   2. Permissions NEVER contain scope. Scope (own/team/department/workspace)
 *      is an INDEPENDENT dimension carried on the role assignment. Future
 *      "Team Leader" vs "Department Manager" differ ONLY by scope.
 *   3. Runtime vs Configuration is a property of the permission, not the role.
 *   4. Roles are data - collections of permission keys + a default scope.
 *      No authorization decision is ever made by hardcoding a role name
 *      (the lone exception is the SYSTEM_ADMIN PLATFORM tier, which is not a
 *      tenant role - it is the super-admin who operates across tenants).
 *
 * The resolver (permissions.ts) reads role/grant rows from the DB and only
 * consults this catalog for: the set of known permission keys, wildcard
 * expansion, license-key derivation, and the built-in role seed definitions.
 */

// ─────────────────────────────────────────────────────────────
// Dimensions
// ─────────────────────────────────────────────────────────────

/** Independent data-reach dimension. Ordered by increasing reach. */
export const SCOPE_ORDER = ["own", "team", "department", "workspace"] as const;
export type PermissionScope = (typeof SCOPE_ORDER)[number];

/** Runtime = operating the product. Configuration = changing how it works. */
export type PermissionKind = "runtime" | "configuration";

/** Top-level feature domains (first segment of every permission key). */
export type PermissionDomain =
  | "conversation"
  | "customer"
  | "crm"
  | "ai"
  | "approvals"
  | "integrations"
  | "business-systems"
  | "channels"
  | "analytics"
  | "settings";

export interface PermissionDef {
  /** Canonical key: `feature:sub-feature:action`. */
  key: string;
  domain: PermissionDomain;
  /** `feature` segment. */
  feature: string;
  /** `sub-feature` segment. */
  subFeature: string;
  /** `action` segment. */
  action: string;
  kind: PermissionKind;
  /** Whether the data-reach Scope dimension applies to this permission. */
  scoped: boolean;
  displayName: string;
  description: string;
}

// Compact constructor.
function p(
  key: string,
  domain: PermissionDomain,
  kind: PermissionKind,
  scoped: boolean,
  displayName: string,
  description: string,
): PermissionDef {
  const parts = key.split(":");
  if (parts.length !== 3) {
    throw new Error(`Permission key "${key}" must be feature:sub-feature:action`);
  }
  const [feature, subFeature, action] = parts;
  return { key, domain, feature, subFeature, action, kind, scoped, displayName, description };
}

// ─────────────────────────────────────────────────────────────
// The catalog
// ─────────────────────────────────────────────────────────────

export const PERMISSIONS: readonly PermissionDef[] = [
  // ── Conversation (runtime, scoped) ──────────────────────────
  p("conversation:messages:read", "conversation", "runtime", true, "Read Conversations", "View customer conversations and messages."),
  p("conversation:messages:reply", "conversation", "runtime", true, "Reply to Conversations", "Send replies in customer conversations."),
  p("conversation:messages:takeover", "conversation", "runtime", true, "Take Over Conversations", "Take over a conversation from the bot or another agent."),
  p("conversation:messages:assign", "conversation", "runtime", true, "Assign Conversations", "Assign or reassign conversations to agents."),
  p("conversation:messages:close", "conversation", "runtime", true, "Close Conversations", "Close/resolve conversations."),

  // ── Customer profile ────────────────────────────────────────
  p("customer:profile:read", "customer", "runtime", true, "Read Customer Profiles", "View customer profile data."),
  p("customer:profile:update", "customer", "runtime", true, "Update Customer Profiles", "Edit customer profile data."),
  p("customer:profile:export", "customer", "configuration", true, "Export Customer Data", "Export customer profile data."),

  // ── Customer commerce context (Shopify orders in the conversation panel) ──
  // Verified commerce context + safe order actions. Deliberately permissions,
  // not Role==ADMIN: a tenant can let front-line agents SEE order context while
  // reserving cancel/refund for managers. Actions still route through business
  // policy + HITL regardless of who holds the permission.
  p("customer:commerce:read", "customer", "runtime", true, "View Commerce Context", "View the customer's connected-store orders, spend and status in the conversation."),
  p("customer:commerce:open", "customer", "runtime", true, "Open Orders in Store", "Open the customer's order in the connected store admin."),
  p("customer:commerce:cancel", "customer", "runtime", true, "Cancel Orders", "Cancel a customer's store order (subject to business policy and approval)."),
  p("customer:commerce:refund", "customer", "runtime", true, "Refund Orders", "Refund a customer's store order (subject to business policy and approval)."),

  // ── CRM ─────────────────────────────────────────────────────
  p("crm:contacts:read", "crm", "runtime", true, "Read CRM Contacts", "View CRM contacts."),
  p("crm:contacts:update", "crm", "runtime", true, "Update CRM Contacts", "Create and edit CRM contacts."),
  p("crm:deals:read", "crm", "runtime", true, "Read CRM Deals", "View CRM deals/opportunities."),
  p("crm:deals:update", "crm", "runtime", true, "Update CRM Deals", "Create and edit CRM deals/opportunities."),
  p("crm:activities:create", "crm", "runtime", true, "Create CRM Activities", "Log tasks, notes and activities in the CRM."),

  // ── AI Employees (configuration) ────────────────────────────
  p("ai:employees:read", "ai", "configuration", false, "View AI Employees", "View AI employees/agents and their configuration."),
  p("ai:employees:create", "ai", "configuration", false, "Create AI Employees", "Create new AI employees/agents."),
  p("ai:employees:update", "ai", "configuration", false, "Edit AI Employees", "Edit AI employees/agents and their behavior."),
  p("ai:employees:delete", "ai", "configuration", false, "Delete AI Employees", "Delete AI employees/agents."),

  // ── AI Knowledge (configuration) ────────────────────────────
  p("ai:knowledge:read", "ai", "configuration", false, "View Knowledge", "View knowledge base sources and documents."),
  p("ai:knowledge:write", "ai", "configuration", false, "Edit Knowledge", "Add, edit and remove knowledge base content."),

  // ── AI Workflows (configuration) ────────────────────────────
  p("ai:workflows:read", "ai", "configuration", false, "View Workflows", "View automation workflows and flows."),
  p("ai:workflows:update", "ai", "configuration", false, "Edit Workflows", "Create and edit automation workflows and flows."),
  p("ai:workflows:publish", "ai", "configuration", false, "Publish Workflows", "Activate/publish a workflow so it runs live (subject to graph validation)."),

  // ── AI Tools (configuration) - executable tool assignment + AUTO/HITL ──
  p("ai:tools:read", "ai", "configuration", false, "View AI Tools", "View executable AI tools, their assignments and AUTO/HITL settings."),
  p("ai:tools:manage", "ai", "configuration", false, "Manage AI Tools", "Enable/disable tools and configure AUTO/HITL, approval recipients and limits."),
  p("ai:tools:assign", "ai", "configuration", false, "Assign AI Tools", "Assign executable tools to AI employees."),

  // ── Approvals ───────────────────────────────────────────────
  p("approvals:requests:view", "approvals", "runtime", true, "View Approval Requests", "View pending AI/agent approval requests."),
  p("approvals:requests:approve", "approvals", "runtime", true, "Approve Requests", "Approve pending approval requests."),
  p("approvals:requests:reject", "approvals", "runtime", true, "Reject Requests", "Reject pending approval requests."),
  p("approvals:policies:manage", "approvals", "configuration", false, "Manage Approval Policies", "Configure approval/HITL policies."),

  // ── Integrations (configuration) ────────────────────────────
  p("integrations:connections:read", "integrations", "configuration", false, "View Integrations", "View connected integrations."),
  p("integrations:connections:connect", "integrations", "configuration", false, "Connect Integrations", "Connect/configure third-party integrations."),
  p("integrations:connections:disconnect", "integrations", "configuration", false, "Disconnect Integrations", "Disconnect third-party integrations."),

  // ── Business Systems (configuration) ────────────────────────
  // The tenant's Source-of-Truth home (Settings → Business Systems). Distinct
  // from the generic `integrations` domain (AI Studio marketplace) because the
  // authority is different: business-systems governs which system answers "who
  // is this customer?" and how data syncs back. Routes that serve BOTH
  // surfaces accept either domain's key (OR semantics in requirePermission).
  p("business-systems:connections:read", "business-systems", "configuration", false, "View Business Systems", "View connected business systems, their health and Source-of-Truth status."),
  p("business-systems:connections:connect", "business-systems", "configuration", false, "Connect Business Systems", "Connect or reconnect a business system (OAuth or API key)."),
  p("business-systems:connections:manage", "business-systems", "configuration", false, "Manage Business Systems", "Configure sync/writeback, change settings, or disconnect a business system."),
  p("business-systems:sot:select", "business-systems", "configuration", false, "Select Source of Truth", "Elect which connected system is the customer Source of Truth."),

  // ── Channels (configuration) ────────────────────────────────
  p("channels:manage:read", "channels", "configuration", false, "View Channels", "View connected messaging/voice channels."),
  p("channels:manage:update", "channels", "configuration", false, "Manage Channels", "Connect and configure messaging/voice channels."),

  // ── Outbound calling (runtime, scoped) ──────────────────────
  // Deliberately permissions, not Role==ADMIN: a tenant can let front-line
  // agents place calls without granting workspace administration. Routes
  // still validate the tenant's phone channel and the destination number
  // regardless of who holds the permission. Domain "channels" so licensing
  // follows the tenant's channel entitlement (same as the Outbound nav).
  p("outbound:calls:create", "channels", "runtime", true, "Place Outbound Calls", "Start outbound phone calls to customers."),
  p("outbound:calls:view", "channels", "runtime", true, "View Outbound Calls", "View outbound call activity and live call sessions."),

  // ── Analytics ───────────────────────────────────────────────
  p("analytics:dashboard:read", "analytics", "runtime", true, "View Analytics Dashboard", "View analytics dashboards and metrics."),
  p("analytics:reports:export", "analytics", "runtime", true, "Export Reports", "Export analytics reports."),

  // ── Settings / Administration (configuration) ───────────────
  p("settings:workspace:update", "settings", "configuration", false, "Manage Workspace Settings", "Edit workspace-level settings and defaults."),
  p("settings:members:manage", "settings", "configuration", false, "Manage Members", "Invite, edit, deactivate users and assign roles."),
  p("settings:roles:manage", "settings", "configuration", false, "Manage Roles", "Create and edit roles and their permissions."),
  p("settings:billing:manage", "settings", "configuration", false, "Manage Billing", "Manage subscription, billing and plans."),
  // Cancellation is a distinct permission (not merely "manage") so a tenant can
  // let a billing manager change plans/cards while reserving the ability to end
  // the subscription. Owner-held by default (see OWNER_ONLY); delegable.
  p("settings:billing:cancel", "settings", "configuration", false, "Cancel Subscription", "Cancel the workspace subscription or schedule its cancellation."),
  p("settings:api-keys:manage", "settings", "configuration", false, "Manage API Keys", "Create and revoke API keys."),
  // Business Rules (AI action policies): who may SEE the tenant's rules for
  // refunds/coupons/compensation, who may CHANGE them (each change appends an
  // immutable new policy version), and who may dry-run sample decisions.
  // These are deliberately permissions, not role checks - a tenant can grant
  // policy management to a finance lead without full admin.
  p("settings:business-policies:read", "settings", "configuration", false, "View Business Rules", "See the tenant's AI action policies for refunds, coupons and compensation."),
  p("settings:business-policies:manage", "settings", "configuration", false, "Manage Business Rules", "Create new versions of the AI action policies. Changes never rewrite historical decisions."),
  p("settings:business-policies:preview", "settings", "configuration", false, "Preview Business Rules", "Dry-run sample scenarios against the active policies."),
] as const;

export type PermissionKey = string;

const PERMISSION_BY_KEY = new Map<string, PermissionDef>(PERMISSIONS.map((d) => [d.key, d]));
export const ALL_PERMISSION_KEYS: readonly string[] = PERMISSIONS.map((d) => d.key);

export function isPermissionKey(value: string): boolean {
  return PERMISSION_BY_KEY.has(value);
}

export function getPermission(key: string): PermissionDef | undefined {
  return PERMISSION_BY_KEY.get(key);
}

export function listPermissionsByDomain(): Record<string, PermissionDef[]> {
  const grouped: Record<string, PermissionDef[]> = {};
  for (const d of PERMISSIONS) (grouped[d.domain] ||= []).push(d);
  return grouped;
}

// ─────────────────────────────────────────────────────────────
// Licensing - derive the entitlement key for a permission.
//
// A plan/package entitles at FEATURE or SUB-FEATURE granularity
// (`analytics`, `analytics:dashboard`). A permission is licensed when its
// feature OR feature:sub-feature node is entitled. This is the packaging
// unit ("Pro sees analytics, Light doesn't") and is INDEPENDENT of which
// permissions a role holds.
// ─────────────────────────────────────────────────────────────

/** Feature-level license key for a permission, e.g. "analytics". */
export function featureLicenseKey(permissionKey: string): string {
  return permissionKey.split(":")[0];
}

/** Sub-feature-level license key for a permission, e.g. "analytics:dashboard". */
export function subFeatureLicenseKey(permissionKey: string): string {
  const [f, s] = permissionKey.split(":");
  return `${f}:${s}`;
}

/** All license keys a permission could be entitled by (most → least specific). */
export function licenseKeysFor(permissionKey: string): string[] {
  return [subFeatureLicenseKey(permissionKey), featureLicenseKey(permissionKey)];
}

/** The full set of grantable license (entitlement) keys derived from the catalog. */
export const ALL_LICENSE_KEYS: readonly string[] = Array.from(
  new Set(PERMISSIONS.flatMap((d) => [d.feature, `${d.feature}:${d.subFeature}`])),
).sort();

// ─────────────────────────────────────────────────────────────
// Wildcard expansion
//
// A stored role/grant key may be a wildcard so roles auto-inherit new
// permissions:
//   "*"                       → every permission
//   "ai:*"                    → every ai:* permission
//   "conversation:messages:*" → every action under conversation:messages
//   "conversation:messages:reply" → exact
// ─────────────────────────────────────────────────────────────

export function expandPermissionPattern(pattern: string): string[] {
  if (pattern === "*") return [...ALL_PERMISSION_KEYS];
  if (pattern.endsWith(":*")) {
    const prefix = pattern.slice(0, -1); // keep trailing ":"
    return ALL_PERMISSION_KEYS.filter((k) => k.startsWith(prefix));
  }
  return isPermissionKey(pattern) ? [pattern] : [];
}

/** Expand a collection of patterns into a concrete, de-duplicated permission set. */
export function expandPermissionPatterns(patterns: Iterable<string>): Set<string> {
  const set = new Set<string>();
  for (const pat of patterns) for (const k of expandPermissionPattern(pat)) set.add(k);
  return set;
}

// ─────────────────────────────────────────────────────────────
// Built-in roles - seeded as system TenantRoles per tenant, editable later.
//
// `permissions` are stored verbatim (wildcards allowed) as TenantRoleFeature
// rows so the DB stays the source of truth and the set is editable. The
// resolver expands wildcards at read time.
// ─────────────────────────────────────────────────────────────

export type BuiltinRoleKey = "owner" | "admin" | "department_manager" | "agent";

export interface BuiltinRoleDef {
  key: BuiltinRoleKey;
  name: string;
  description: string;
  defaultScope: PermissionScope;
  /** Permission patterns (may include wildcards). */
  permissions: string[];
}

/**
 * Configuration permissions are everything with kind === "configuration".
 * Owner-exclusive keys are billing / roles / api-keys management.
 */
const OWNER_ONLY = [
  "settings:billing:manage",
  "settings:billing:cancel",
  "settings:roles:manage",
  "settings:api-keys:manage",
];

export const BUILTIN_ROLES: Record<BuiltinRoleKey, BuiltinRoleDef> = {
  owner: {
    key: "owner",
    name: "Owner",
    description: "Full access to everything, including billing, roles and workspace lifecycle.",
    defaultScope: "workspace",
    permissions: ["*"],
  },
  admin: {
    key: "admin",
    name: "Admin",
    description: "Full operational and configuration access except billing, role management and API keys.",
    defaultScope: "workspace",
    // Everything the catalog knows about, minus the owner-only keys. Expanded
    // to explicit keys at seed time (so it stays editable + excludes are real).
    permissions: ALL_PERMISSION_KEYS.filter((k) => !OWNER_ONLY.includes(k)),
  },
  department_manager: {
    key: "department_manager",
    name: "Department Manager",
    description: "Runs a department: full conversation/approval handling and analytics within the department scope.",
    defaultScope: "department",
    permissions: [
      "conversation:messages:*",
      "customer:profile:read",
      "customer:profile:update",
      "customer:commerce:*",
      "crm:contacts:read",
      "crm:deals:read",
      "crm:activities:create",
      "approvals:requests:view",
      "approvals:requests:approve",
      "approvals:requests:reject",
      "outbound:calls:create",
      "outbound:calls:view",
      "analytics:dashboard:read",
      "analytics:reports:export",
    ],
  },
  agent: {
    key: "agent",
    name: "Agent",
    description: "Front-line agent: handles their own conversations and views customer/CRM context.",
    defaultScope: "own",
    // Kept intentionally narrow so nav/page visibility matches today's
    // agent experience (conversations + customer/CRM context only).
    // Approvals/analytics are department-manager-and-up.
    permissions: [
      "conversation:messages:read",
      "conversation:messages:reply",
      "conversation:messages:takeover",
      "conversation:messages:close",
      "customer:profile:read",
      // Front-line agents can SEE commerce context and open orders in the store,
      // but cancel/refund stay with department managers and up.
      "customer:commerce:read",
      "customer:commerce:open",
      "crm:contacts:read",
      // Agents can place/see outbound calls (e.g. missed-call callbacks) -
      // matches the pre-permission behavior of the voice routes.
      "outbound:calls:create",
      "outbound:calls:view",
    ],
  },
};

export const BUILTIN_ROLE_ORDER: BuiltinRoleKey[] = ["owner", "admin", "department_manager", "agent"];

// ─────────────────────────────────────────────────────────────
// Migration bridge - map the legacy coarse `Role` enum + departmentRole to a
// built-in role. Used ONLY as a fallback when a user has no explicit
// UserRoleAssignment yet (pre-backfill / freshly-created). Permissions still
// come from the role's catalog definition - this maps an identity to a role,
// it does not make an authorization decision.
// ─────────────────────────────────────────────────────────────

export function builtinRoleForLegacy(
  role: string,
  departmentRole?: string | null,
): BuiltinRoleKey | null {
  if (role === "ADMIN") return "admin";
  if (role === "AGENT") return departmentRole === "MANAGER" ? "department_manager" : "agent";
  return null; // SYSTEM_ADMIN handled by platform bypass; unknown → no role
}

/** Greater scope wins. Returns the higher-reach of two scopes. */
export function maxScope(a: PermissionScope, b: PermissionScope): PermissionScope {
  return SCOPE_ORDER.indexOf(a) >= SCOPE_ORDER.indexOf(b) ? a : b;
}
