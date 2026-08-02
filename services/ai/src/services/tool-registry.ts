import { getAdapter } from "./connectors/integration-framework";
// Importing the barrel guarantees every adapter has run its registerAdapter()
// side effect before getAdapter() is consulted. A DYNAMIC import here resolved
// to a different module instance than the static chain index.ts uses, so the
// registry read back empty and every adapter-backed tool was silently
// classified as a dead seed.
import "./connectors";

/**
 * Tool Registry - single source of truth for the AI tool surface.
 *
 * Tools are classified into three exclusive kinds (OMC_EXECUTION_MAP):
 *
 *   - SYSTEM       : read-only context gatherers. Never appear in an
 *                    ExecutionPlan, never shown to the user, never executed
 *                    by the planner output path. Used by the context engine
 *                    only (chat-mode RAG, pre-plan enrichment).
 *   - ACTION       : planner-executable tools that mutate system state via
 *                    registered connectors. MUST pass policy + approval
 *                    gates and produce real side effects.
 *   - INTEGRATION  : tenant-scoped, dynamically loaded from DB
 *                    (CatalogTool / TenantTool / AgentToolPermission) and
 *                    executed via tool-execution.service.ts. Visible to the
 *                    planner only if enabled for the tenant.
 *
 * `getAvailableTools(tenantId)` is the unifier: it merges the static
 * registry (system + action) with the dynamic per-tenant integration list.
 * The action planner must consume this function - not the raw exports -
 * so it sees exactly the tools available for a given tenant/context.
 */

export type ToolKind = "system" | "action" | "integration";
export type ToolCategory =
  | "messaging"
  | "crm"
  | "broadcast"
  | "workflow"
  | "identity"
  | "meta";

export interface ToolSpec {
  name: string;
  kind: ToolKind;
  category: ToolCategory;
  description: string;
  /** JSON schema–ish shape. Kept loose so the LLM has flexibility. */
  input: Record<string, string>;
  /** Existing service endpoint (or "virtual" for executor-only tools). */
  endpoint: string;
  /**
   * Whether the action planner is allowed to emit this tool as a plan step.
   * Default true. Set to false for tools that exist only on the autonomous
   * conversational-bot surface (defined in packages/shared/src/lib/agent-tools.ts)
   * - they still need a registry entry so admins can configure HITL in the
   * Settings → Tools page, but the action planner must not include them in
   * its prompt.
   */
  plannerEmittable?: boolean;
}

export const TOOL_REGISTRY: ToolSpec[] = [
  // ─── SYSTEM (hidden - context gathering only) ──────────────
  {
    name: "get_conversation",
    kind: "system",
    category: "messaging",
    description: "Fetch a single conversation with metadata (status, channel, last activity).",
    input: { conversationId: "string" },
    endpoint: "GET /api/conversations/:id",
  },
  {
    name: "list_recent_messages",
    kind: "system",
    category: "messaging",
    description: "List the most recent messages in a conversation (up to 20).",
    input: { conversationId: "string", limit: "number?" },
    endpoint: "GET /api/conversations/:id/messages",
  },
  {
    name: "get_contact",
    kind: "system",
    category: "crm",
    description: "Fetch a contact's full profile including tags, channels, and last interaction.",
    input: { contactId: "string" },
    endpoint: "GET /api/contacts/:id",
  },
  {
    name: "resolve_identity",
    kind: "system",
    category: "identity",
    description: "Find a contact by email, phone, or external id. Read-only - does NOT create.",
    input: { email: "string?", phone: "string?", externalId: "string?", channel: "string?" },
    endpoint: "POST /api/identity/resolve",
  },
  {
    name: "list_workflows",
    kind: "system",
    category: "workflow",
    description: "List all workflows for the current tenant.",
    input: {},
    endpoint: "GET /api/chatbot-flows",
  },
  {
    name: "preview_broadcast",
    kind: "system",
    category: "broadcast",
    description: "Estimate audience size + rendered template for a broadcast without sending.",
    input: { audience: "object", templateId: "string" },
    endpoint: "POST /api/broadcasts/preview",
  },

  // ─── ACTION (planner-executable, mutating) ─────────────────
  {
    name: "send_message",
    kind: "action",
    category: "messaging",
    description: "Send an outbound message to a contact on a specific channel.",
    input: { contactId: "string", channel: "whatsapp|email|sms|webchat", body: "string" },
    endpoint: "POST /api/conversations/:id/messages",
  },
  {
    name: "update_contact",
    kind: "action",
    category: "crm",
    description: "Update a contact record in the connected CRM (fields, lifecycle, owner, etc.).",
    input: { contactId: "string", fields: "object" },
    endpoint: "virtual:update_contact",
  },
  {
    name: "update_crm",
    kind: "action",
    category: "crm",
    description: "Update arbitrary CRM record fields via the connected CRM adapter.",
    input: { recordType: "string", recordId: "string", fields: "object" },
    endpoint: "virtual:update_crm",
  },
  {
    name: "create_ticket",
    kind: "action",
    category: "crm",
    description: "Create a support ticket in the connected helpdesk/CRM.",
    input: { subject: "string", body: "string", priority: "string?" },
    endpoint: "virtual:create_ticket",
  },
  {
    name: "tag_contact",
    kind: "action",
    category: "crm",
    description: "Add one or more tags to a contact for segmentation.",
    input: { contactId: "string", tags: "string[]" },
    endpoint: "virtual:tag_contact",
  },
  {
    name: "create_broadcast",
    kind: "action",
    category: "broadcast",
    description: "Create a broadcast campaign targeting a contact segment.",
    input: { name: "string", audience: "object", templateId: "string" },
    endpoint: "POST /api/broadcasts",
  },
  {
    name: "schedule_broadcast",
    kind: "action",
    category: "broadcast",
    description: "Schedule an existing broadcast for a future date/time.",
    input: { broadcastId: "string", scheduleAt: "iso-datetime" },
    endpoint: "POST /api/broadcasts/:id/schedule",
  },
  {
    name: "create_workflow",
    kind: "action",
    category: "workflow",
    description: "Create a new automation flow (visual chatbot flow).",
    input: { name: "string", triggers: "object[]", steps: "object[]" },
    endpoint: "POST /api/chatbot-flows",
  },
  {
    name: "merge_contacts",
    kind: "action",
    category: "identity",
    description: "Merge two contacts into one (unified identity across channels).",
    input: { targetId: "string", sourceId: "string" },
    endpoint: "POST /api/identity/merge",
  },
  {
    name: "generate_followup",
    kind: "action",
    category: "messaging",
    description:
      "Draft a context-aware follow-up message for a stalled conversation. " +
      "Considers customer state, conversation history, and policy. Returns a draft body; " +
      "use schedule_followup or send_message to actually dispatch it.",
    input: {
      conversationId: "string",
      maxMessages: "number?",
    },
    endpoint: "virtual:generate_followup",
  },
  {
    name: "link_customer_identifier",
    kind: "action",
    category: "identity",
    description:
      "Progressively link an email or phone extracted from a customer message to their contact. " +
      "Safe: attaches new identifiers or creates a pending link suggestion when the identifier " +
      "already belongs to another contact. Never merges directly. Use when the user clearly states " +
      "ownership of an email or phone.",
    input: {
      contactId: "string",
      type: "email|phone",
      value: "string",
      confidence: "number",
    },
    endpoint: "POST /api/identity/link",
  },

  // ─── BOT-SURFACE ACTION TOOLS (autonomous conversational bot only) ──
  // These are dispatched inside packages/shared/src/lib/agent-tools.ts during
  // live customer conversations, NOT by the action planner. They appear here
  // ONLY so they show up in Settings → Tools for HITL configuration.
  // plannerEmittable=false keeps the action planner from emitting them as plan
  // steps (they have no executor case in action-executor.service.ts).
  {
    name: "schedule_followup",
    kind: "action",
    category: "messaging",
    description:
      "Schedule a future free-text outbound message to the customer. Used by the autonomous bot when the " +
      "customer needs time to think or asked to be re-engaged later.",
    input: { message: "string", delay_iso8601: "string?", send_at_iso: "string?", reason: "string" },
    endpoint: "virtual:schedule_followup",
    plannerEmittable: false,
  },
  {
    name: "schedule_followup_template",
    kind: "action",
    category: "messaging",
    description:
      "Schedule a future WhatsApp TEMPLATE message - used by the bot when the send time falls outside " +
      "the WhatsApp 24h customer-service window.",
    input: {
      template_name: "string",
      language: "string?",
      send_at_iso: "string?",
      delay_iso8601: "string?",
      variables: "object?",
      reason: "string",
    },
    endpoint: "virtual:schedule_followup_template",
    plannerEmittable: false,
  },
  {
    name: "create_task",
    kind: "action",
    category: "crm",
    description: "Create a CRM task for the human team. Used by the bot to flag follow-up work for agents.",
    input: { subject: "string", body: "string", priority: "string?" },
    endpoint: "virtual:create_task",
    plannerEmittable: false,
  },
  {
    name: "close_conversation",
    kind: "action",
    category: "messaging",
    description: "Mark the current conversation as resolved (autonomous bot only).",
    input: { resolution: "string", summary: "string" },
    endpoint: "virtual:close_conversation",
    plannerEmittable: false,
  },
  {
    name: "escalate_to_human",
    kind: "action",
    category: "meta",
    description: "Transfer the current conversation to a human agent (autonomous bot only).",
    input: { reason: "string", priority: "string?", summary: "string?" },
    endpoint: "virtual:escalate_to_human",
    plannerEmittable: false,
  },
  {
    name: "schedule_meeting",
    kind: "action",
    category: "meta",
    description:
      "Book a meeting on the assigned agent's calendar. Surfaced only when the tenant has a calendar " +
      "integration connected and a MeetingType configured.",
    input: {
      duration_minutes: "number",
      meeting_type: "string",
      requested_at_iso: "string?",
      customer_timezone: "string?",
      customer_email: "string?",
      additional_guests: "string[]?",
      notes: "string?",
    },
    endpoint: "virtual:schedule_meeting",
    plannerEmittable: false,
  },
];

export interface AvailableTools {
  systemTools: ToolSpec[];
  actionTools: ToolSpec[];
  integrationTools: ToolSpec[];
}

/**
 * Resolve the effective toolset for a tenant at request time.
 *
 * - systemTools + actionTools come from the static registry above.
 * - integrationTools are loaded from DB (TenantTool → CatalogTool), filtered
 *   to enabled tools whose tenantIntegration is CONNECTED. The planner sees
 *   them alongside actionTools but they are dispatched through
 *   tool-execution.service.ts (NOT the action-executor switch).
 *
 * This is the ONLY function the planner should call. Direct TOOL_REGISTRY
 * reads are permitted for tests and for the context engine's system-tool
 * lookups, but never for building the planner prompt.
 */
export async function getAvailableTools(
  tenantId: string,
  _context?: unknown,
): Promise<AvailableTools> {
  const systemTools = TOOL_REGISTRY.filter((t) => t.kind === "system");
  const actionTools = TOOL_REGISTRY.filter((t) => t.kind === "action");

  let integrationTools: ToolSpec[] = [];
  try {
    const { prisma } = await import("@chatcenter/shared");
    const rows = await prisma.tenantTool.findMany({
      where: {
        tenantId,
        isEnabled: true,
        tenantIntegration: { status: "CONNECTED" },
      },
      include: { catalogTool: true },
    });
    // Guard: the generic executor (tool-execution.service.ts) hard-fails any
    // catalog tool with no `endpoint` ("has no endpoint configured"). Such
    // rows are misconfigured stubs (e.g. the seeded calendar tools
    // create_event/list_events) - exposing them can ONLY ever fail and traps
    // the bot into calling a dead tool instead of the real path (calendar
    // booking goes through `schedule_meeting` → GoogleCalendarAdapter, not a
    // generic HTTP endpoint). Drop them from the surface so the model never
    // sees a tool it cannot successfully call.
    const usableRows = rows.filter(
      (r: any) => typeof r.catalogTool?.endpoint === "string" && r.catalogTool.endpoint.trim().length > 0,
    );
    const droppedNoEndpoint = rows.length - usableRows.length;
    if (droppedNoEndpoint > 0) {
      console.warn(
        `[tool-registry] tenant=${tenantId} dropped ${droppedNoEndpoint} enabled catalog tool(s) with no endpoint ` +
          `from the bot surface: ${rows
            .filter((r: any) => !(typeof r.catalogTool?.endpoint === "string" && r.catalogTool.endpoint.trim()))
            .map((r: any) => r.catalogTool?.slug)
            .join(", ")}. Fix the catalog seed or disable these tenant tools.`,
      );
    }
    integrationTools = usableRows.map((r: any) => ({
      name: `integration.${r.catalogTool.slug}`,
      kind: "integration" as const,
      category: "meta" as const,
      description: r.catalogTool.description ?? r.catalogTool.name,
      input:
        typeof r.catalogTool.inputSchema === "object" && r.catalogTool.inputSchema
          ? Object.fromEntries(
              Object.entries(r.catalogTool.inputSchema as Record<string, unknown>).map(([k, v]) => [
                k,
                typeof v === "string" ? v : "any",
              ]),
            )
          : {},
      endpoint: `tenantTool:${r.id}`,
    }));
  } catch (err) {
    // DB may be unavailable in some unit tests - fall back to empty list
    // rather than fail the whole planner call. Audit at caller if needed.
    integrationTools = [];
  }

  return { systemTools, actionTools, integrationTools };
}

/**
 * Build the human-readable tool section the planner injects into its system
 * prompt. Only action + integration tools are listed - system tools are
 * intentionally excluded so the LLM never emits them as steps.
 */
export function renderPlannerTools(tools: AvailableTools): string {
  const lines: string[] = [];
  const group = (title: string, list: ToolSpec[]) => {
    if (list.length === 0) return;
    lines.push(`\n## ${title}`);
    for (const t of list) {
      const schema = Object.entries(t.input)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
      lines.push(`- ${t.name}(${schema}) - ${t.description}`);
    }
  };
  const plannerActionTools = tools.actionTools.filter((t) => t.plannerEmittable !== false);
  group("ACTION TOOLS (executable - mutate state via connectors)", plannerActionTools);
  group("INTEGRATION TOOLS (tenant-scoped - executed via tool-execution.service.ts)", tools.integrationTools);
  return lines.join("\n");
}

/**
 * Context capabilities advertised to the planner so it knows what
 * information the system can retrieve on its behalf - WITHOUT offering
 * those as plan steps. The planner may reference them in its reasoning
 * (e.g. "I already have the contact via get_contact") but must not emit
 * them as ExecutionPlan steps.
 */
export function renderSystemCapabilities(tools: AvailableTools): string {
  if (tools.systemTools.length === 0) return "";
  const lines = ["\n## CONTEXT CAPABILITIES (read-only, pre-resolved - NEVER emit as steps)"];
  for (const t of tools.systemTools) {
    lines.push(`- ${t.name}: ${t.description}`);
  }
  return lines.join("\n");
}

/** Back-compat shim - delegates to the new unified path. */
export function renderToolRegistryForPrompt(): string {
  const actionTools = TOOL_REGISTRY.filter(
    (t) => t.kind === "action" && t.plannerEmittable !== false,
  );
  const lines: string[] = [];
  for (const t of actionTools) {
    const schema = Object.entries(t.input)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    lines.push(`- ${t.name}(${schema}) - ${t.description}`);
  }
  return lines.join("\n");
}

// ─── Governable surface (settings) vs executable surface (planner) ──────────
//
// These are genuinely different questions and conflating them is what left the
// tool-permissions page unable to show a single Shopify tool.
//
// `getAvailableTools` answers "what can the generic HTTP executor call RIGHT
// NOW", so it drops catalog tools with no `endpoint` - correct for the planner,
// because such a tool can only ever fail.
//
// This answers "what can an admin set a POLICY on", which is a superset:
//   - adapter-backed tools (shopify.*, hubspot.*, ...) legitimately have no
//     endpoint. They execute through executeAdapterTool, not HTTP. Every
//     Shopify tool is in this category, which is why the settings page showed
//     none of them.
//   - a tool with no TenantTool row yet is still governable. The catalog decides
//     what is LISTED; the row is what provisioning creates the moment an admin
//     picks a policy other than Disabled. Requiring the row first meant writes
//     like cancel_order could never be enabled at all, since provisioning only
//     ever creates read tools.
//
// A tool is excluded only when it is genuinely dead: no endpoint AND no adapter
// that exposes it. Those are misconfigured seeds and policy on them is a lie.

export interface GovernableTool {
  /** Dotted adapter name (`shopify.cancel_order`) or `integration.<slug>`. */
  name: string;
  integrationSlug: string;
  slug: string;
  displayName: string;
  description: string;
  /** READ | WRITE | DELETE | ACTION from the catalog. */
  catalogCategory: string | null;
  riskLevel: string | null;
  /** Seed HITL mode from CatalogTool.hitlPolicy. */
  catalogHitlMode: string;
  /** Provider scopes the adapter declares for this tool. */
  requiredScopes: string[];
  /** How it executes, which decides whether an endpoint is required. */
  execution: "adapter" | "http";
  /** Does a TenantTool row exist yet? False means "policy will provision it". */
  provisioned: boolean;
  tenantToolId: string | null;
  /** Tenant override mode, when a row exists and carries one. */
  overrideHitlMode: string | null;
  isEnabled: boolean;
  updatedAt: string | null;
}

/**
 * How many EXECUTABLE tools each catalog integration has, per slug, regardless
 * of whether this tenant has connected it.
 *
 * getGovernableIntegrationTools answers a different question - "what can this
 * tenant set policy on right now" - and is connected-only by design. Using it
 * to classify the sidebar gave every unconnected integration a count of 0, so
 * they were all filed as status-only external connections and the "Available"
 * group could never contain anything. An integration the tenant has not
 * connected still HAS tools; that is the reason to connect it.
 *
 * "Executable" still excludes dead seeds - a catalog row with neither an
 * endpoint nor an adapter cannot run, so counting it would oversell.
 */
export async function getExecutableToolCountsBySlug(): Promise<Map<string, number>> {
  const { prisma } = await import("@chatcenter/shared");

  const rows = await prisma.catalogTool.findMany({
    select: { slug: true, endpoint: true, integration: { select: { slug: true } } },
  });

  const adapterDefsBySlug = new Map<string, Map<string, any>>();
  const counts = new Map<string, number>();

  for (const ct of rows as any[]) {
    const integrationSlug = ct.integration?.slug;
    if (!integrationSlug) continue;

    if (!adapterDefsBySlug.has(integrationSlug)) {
      const defs = new Map<string, any>();
      const adapter = getAdapter(integrationSlug);
      try {
        for (const def of adapter?.tools?.() ?? []) {
          if (def?.name) defs.set(def.name.slice(def.name.indexOf(".") + 1), def);
        }
      } catch { /* a broken adapter must not hide the rest of the catalog */ }
      adapterDefsBySlug.set(integrationSlug, defs);
    }

    const hasEndpoint = typeof ct.endpoint === "string" && ct.endpoint.trim().length > 0;
    const def = adapterDefsBySlug.get(integrationSlug)?.get(ct.slug);
    if (!hasEndpoint && !def) continue;
    if (def?.unsupported) continue;
    counts.set(integrationSlug, (counts.get(integrationSlug) ?? 0) + 1);
  }

  return counts;
}

export async function getGovernableIntegrationTools(
  tenantId: string,
): Promise<GovernableTool[]> {
  const { prisma } = await import("@chatcenter/shared");

  // Connected integrations only: policy on a provider the tenant has not
  // connected is not actionable, and the workspace lists those separately.
  const connections = await prisma.tenantIntegration.findMany({
    where: { tenantId, status: "CONNECTED" },
    select: { id: true, integration: { select: { id: true, slug: true } } },
  });
  if (connections.length === 0) return [];

  // De-duplicate by slug. The dev estate has three Shopify connection rows for
  // one tenant; keying by slug means the tool list is not tripled.
  const bySlug = new Map<string, { tenantIntegrationId: string; integrationId: string }>();
  for (const c of connections) {
    const slug = c.integration?.slug;
    if (!slug || bySlug.has(slug)) continue;
    bySlug.set(slug, { tenantIntegrationId: c.id, integrationId: c.integration!.id });
  }

  const [catalogTools, tenantTools] = await Promise.all([
    prisma.catalogTool.findMany({
      where: { integrationId: { in: [...bySlug.values()].map((v) => v.integrationId) } },
    }),
    prisma.tenantTool.findMany({
      where: { tenantId },
      select: { id: true, catalogToolId: true, isEnabled: true, configOverrides: true, updatedAt: true },
    }),
  ]);

  const rowByCatalogId = new Map(tenantTools.map((t: any) => [t.catalogToolId, t]));
  const slugByIntegrationId = new Map([...bySlug.entries()].map(([slug, v]) => [v.integrationId, slug]));

  // Adapter tool names per integration, so we can tell "adapter-backed" from
  // "dead seed" and pick up the declared scopes.
  const adapterToolsBySlug = new Map<string, Map<string, any>>();
  for (const slug of bySlug.keys()) {
    const adapter = getAdapter(slug);
    if (!adapter?.tools) continue;
    const map = new Map<string, any>();
    try {
      for (const def of adapter.tools()) {
        if (!def?.name) continue;
        map.set(def.name.slice(def.name.indexOf(".") + 1), def);
      }
    } catch { /* a broken adapter must not hide the rest of the catalog */ }
    adapterToolsBySlug.set(slug, map);
  }

  const out: GovernableTool[] = [];
  for (const ct of catalogTools as any[]) {
    const integrationSlug = slugByIntegrationId.get(ct.integrationId);
    if (!integrationSlug) continue;

    const adapterDef = adapterToolsBySlug.get(integrationSlug)?.get(ct.slug);
    const hasEndpoint = typeof ct.endpoint === "string" && ct.endpoint.trim().length > 0;
    // Genuinely dead: nothing can execute it, so offering policy would be a lie.
    if (!adapterDef && !hasEndpoint) continue;
    // Declared but not executable on this provider's API. Its handler always
    // throws, so a permission control over it is a decision with no effect -
    // and the failure only shows up later as a raw provider error.
    if (adapterDef?.unsupported) continue;

    const row = rowByCatalogId.get(ct.id) as any;
    out.push({
      name: adapterDef ? `${integrationSlug}.${ct.slug}` : `integration.${ct.slug}`,
      integrationSlug,
      slug: ct.slug,
      displayName: ct.name ?? ct.slug,
      description: ct.description ?? "",
      catalogCategory: ct.category ?? null,
      riskLevel: ct.riskLevel ?? null,
      catalogHitlMode: (ct.hitlPolicy as any)?.mode ?? "never",
      requiredScopes: Array.isArray(adapterDef?.requiredScopes) ? adapterDef.requiredScopes : [],
      execution: adapterDef ? "adapter" : "http",
      provisioned: !!row,
      tenantToolId: row?.id ?? null,
      overrideHitlMode: (row?.configOverrides as any)?.hitlPolicy?.mode ?? null,
      // An unprovisioned tool is not "enabled" - it has no row at all.
      isEnabled: row ? row.isEnabled !== false : false,
      updatedAt: row?.updatedAt ? new Date(row.updatedAt).toISOString() : null,
    });
  }
  return out;
}
