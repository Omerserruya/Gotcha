/**
 * Tool Registry — single source of truth for the AI tool surface.
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
 * The action planner must consume this function — not the raw exports —
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
}

export const TOOL_REGISTRY: ToolSpec[] = [
  // ─── SYSTEM (hidden — context gathering only) ──────────────
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
    description: "Find a contact by email, phone, or external id. Read-only — does NOT create.",
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
  // NOTE: `update_contact` / `create_task` are intentionally absent from the
  // action list. Their executor paths depend on a CRM connector registered via
  // `registerCrmConnector()` in services/ai/src/services/connectors/types.ts.
  // No tenant CRM connector is wired in-repo today, so the default is
  // `failingCrm` which returns {ok:false} on every call. Rather than let the
  // planner emit tools that are guaranteed to fail, we gate them out of the
  // registry until a connector ships. Re-add them once a real CRM adapter
  // exists. The executor switch still handles them for any direct /execute
  // caller so no contract is broken.
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
    integrationTools = rows.map((r: any) => ({
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
    // DB may be unavailable in some unit tests — fall back to empty list
    // rather than fail the whole planner call. Audit at caller if needed.
    integrationTools = [];
  }

  return { systemTools, actionTools, integrationTools };
}

/**
 * Build the human-readable tool section the planner injects into its system
 * prompt. Only action + integration tools are listed — system tools are
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
      lines.push(`- ${t.name}(${schema}) — ${t.description}`);
    }
  };
  group("ACTION TOOLS (executable — mutate state via connectors)", tools.actionTools);
  group("INTEGRATION TOOLS (tenant-scoped — executed via tool-execution.service.ts)", tools.integrationTools);
  return lines.join("\n");
}

/**
 * Context capabilities advertised to the planner so it knows what
 * information the system can retrieve on its behalf — WITHOUT offering
 * those as plan steps. The planner may reference them in its reasoning
 * (e.g. "I already have the contact via get_contact") but must not emit
 * them as ExecutionPlan steps.
 */
export function renderSystemCapabilities(tools: AvailableTools): string {
  if (tools.systemTools.length === 0) return "";
  const lines = ["\n## CONTEXT CAPABILITIES (read-only, pre-resolved — NEVER emit as steps)"];
  for (const t of tools.systemTools) {
    lines.push(`- ${t.name}: ${t.description}`);
  }
  return lines.join("\n");
}

/** Back-compat shim — delegates to the new unified path. */
export function renderToolRegistryForPrompt(): string {
  const actionTools = TOOL_REGISTRY.filter((t) => t.kind === "action");
  const lines: string[] = [];
  for (const t of actionTools) {
    const schema = Object.entries(t.input)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    lines.push(`- ${t.name}(${schema}) — ${t.description}`);
  }
  return lines.join("\n");
}
