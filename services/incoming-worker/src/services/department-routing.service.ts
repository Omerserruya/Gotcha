/**
 * Department / role picker routing (deterministic safety net).
 *
 * The Main Playbook flow can present a department picker via a
 * `send_message_quick_reply` node (e.g. buttons "שירות" / "מכירה"). Whichever
 * employee that selection lands on is decided entirely by how the flow author
 * wired the button edges - and that wiring can be wrong (both buttons pointing
 * at the same route_target, an orphaned branch, a swapped target). When that
 * happens a customer who picks "מכירה" (sales) gets handed to the support
 * employee, with no department set.
 *
 * This module maps a picker button payload directly to the employee ROLE that
 * should own the conversation and assigns an ACTIVE employee of that role,
 * regardless of the graph edges. It is deterministic (no LLM), tenant-scoped,
 * and fails soft: if no matching-role employee exists we leave the assignment
 * untouched and log a warning rather than crash or force a wrong agent.
 */
import { prisma } from "@chatcenter/shared";

interface Selection {
  role: string;           // AIAgent.role to match (customer_support, sales, ...)
  departmentName: string; // Department name to lookup/create
}

// Payload/title tokens → selection. Tokens cover Hebrew + English so the same
// picker resolves no matter which language the flow author labeled the buttons
// in. Matching is exact (normalized) to avoid hijacking unrelated quick-reply
// buttons like "מכירה מיוחדת" or free-text answers.
const SELECTIONS: Array<{ tokens: string[]; sel: Selection }> = [
  {
    tokens: ["מכירה", "מכירות", "sales", "sale"],
    sel: { role: "sales", departmentName: "Sales" },
  },
  {
    tokens: ["שירות", "תמיכה", "support", "service", "customer support", "customer_support"],
    sel: { role: "customer_support", departmentName: "Customer Support" },
  },
];

/**
 * Resolve a department-picker button payload/title to the role + department it
 * represents, or null when the payload is not a recognized department picker
 * option (a normal quick-reply / free text). Exported for unit testing.
 */
export function resolveDepartmentSelection(payload: string | null | undefined): Selection | null {
  const p = String(payload ?? "").trim().toLowerCase();
  if (!p) return null;
  for (const { tokens, sel } of SELECTIONS) {
    if (tokens.some((t) => p === t.toLowerCase())) return sel;
  }
  return null;
}

export interface DepartmentPickerResult {
  handled: boolean;
  assignedAiAgentId?: string;
  departmentId?: string;
  role?: string;
  /** Why the override declined, when it declined for a reason worth naming. */
  skippedReason?: "active_flow_cursor";
}

/**
 * When an inbound interactive reply matches a department picker option, route
 * the conversation by ROLE: set the department and pin an ACTIVE matching-role
 * employee as the assigned AI agent. Returns { handled:false } (no side
 * effects) when the payload is not a picker option, or when no matching-role
 * active employee exists for the tenant.
 */
export async function applyDepartmentPickerReply(args: {
  tenantId: string;
  conversationId: string;
  payload: string | null | undefined;
  /**
   * The conversation's `chatbotNodeId`. Non-null means an authored flow is
   * parked mid-execution and this reply belongs to ITS quick-reply node.
   *
   * Required, not optional: a caller that forgets it would silently restore
   * the behaviour this argument exists to prevent, and the compiler is a
   * better guard than a comment.
   */
  activeFlowCursor: string | null | undefined;
}): Promise<DepartmentPickerResult> {
  const { tenantId, conversationId, payload, activeFlowCursor } = args;

  // An authored flow outranks this fallback. Full stop.
  //
  // This override used to run first and unconditionally: it pinned an agent,
  // NULLED chatbotNodeId, and called processAIBot directly - so a customer
  // tapping a button labelled "שירות" inside a working flow had that flow
  // abandoned mid-execution. Every deterministic node after the quick reply
  // (send_message, send_interactive) was never reached, the cursor was gone so
  // nothing could resume, and the conversation went straight to an AI turn.
  // With an exhausted wallet that turn escalated to a human, which is how a
  // correctly authored flow ended up looking like a billing bug.
  //
  // The picker is a routing FALLBACK for conversations with no flow driving
  // them - not a higher-priority execution engine competing with flow edges
  // and route_target targets for authority over the same conversation.
  if (activeFlowCursor) {
    console.log(
      `[department-routing] conversation=${conversationId} payload="${payload}" ` +
        `skipped: active flow cursor node=${activeFlowCursor} owns this reply`,
    );
    return { handled: false, skippedReason: "active_flow_cursor" };
  }

  const sel = resolveDepartmentSelection(payload);
  if (!sel) return { handled: false };

  // Find an ACTIVE employee of the selected role, scoped to the tenant. Oldest
  // first for a stable, deterministic pick when several exist.
  const agent = await prisma.aIAgent.findFirst({
    where: { tenantId, role: sel.role, status: "ACTIVE" },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });

  if (!agent) {
    console.warn(
      `[department-routing] conversation=${conversationId} payload="${payload}" matched role=${sel.role} ` +
        `but no ACTIVE ${sel.role} employee exists for tenant=${tenantId}; leaving assignment unchanged`,
    );
    return { handled: false };
  }

  // Lookup or create the department (unique on [tenantId, name]).
  const department = await prisma.department.upsert({
    where: { tenantId_name: { tenantId, name: sel.departmentName } },
    update: {},
    create: { tenantId, name: sel.departmentName },
    select: { id: true },
  });

  // Assign + pin. Clearing chatbotNodeId drops any paused quick-reply node so a
  // mis-wired flow can't resume and re-route this conversation on a later
  // inbound. handledBy="ai_agent" keeps the AI employee driving thereafter.
  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      departmentId: department.id,
      assignedAiAgentId: agent.id,
      handledBy: "ai_agent",
      chatbotNodeId: null,
    },
  });

  console.log(
    `[department-routing] conversation=${conversationId} payload="${payload}" → role=${sel.role} ` +
      `agent=${agent.id} department=${department.id} (pinned)`,
  );

  return { handled: true, assignedAiAgentId: agent.id, departmentId: department.id, role: sel.role };
}
