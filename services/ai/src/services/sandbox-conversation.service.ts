/**
 * "Test the AI Employee" - run the REAL employee, not a lookalike.
 *
 * The old test chat (agent-sandbox-chat.service.ts, now deleted) was a second,
 * thinner implementation of the employee: its own system prompt, tools passed
 * as a list of names in text rather than callable functions, tenant-wide
 * knowledge retrieval instead of the agent's assigned bases, no playbook, no
 * routing, no department, no policy, no business hours, no memory model. It
 * could not have matched production even in principle, and it read like an
 * assistant discussing the customer rather than the employee talking to them.
 *
 * This routes the test chat through `generateAIBotReply` - the exact function
 * the incoming-worker calls for a live customer. Parity comes from using the
 * same code, not from trying to keep two prompts in sync:
 *
 *   - the same system instructions (prompt-builder)
 *   - the same playbook and routing decision
 *   - the same knowledge access, scoped to the agent
 *   - the same tone, language lock and policy constraints
 *   - the same tools, and the same HITL gate
 *   - the same conversation memory, because there is a real Conversation row
 *
 * The one deliberate difference is execution: mutating tools are simulated
 * unless the operator explicitly opts into real execution. That guard lives at
 * the single tool-dispatch chokepoint in shared, not here, so it cannot be
 * bypassed by a future caller.
 *
 * The sandbox conversation is a real row, kept and reused per (agent, user), so
 * "does it remember what I said three turns ago?" is a genuine test of the
 * production memory model rather than of an array we passed in.
 */

import { prisma } from "@chatcenter/shared";
import { generateAIBotReply } from "./ai-bot.service";

export type SandboxWriteMode = "safe" | "real";

export interface SandboxTurnInput {
  tenantId: string;
  agentId: string;
  /** The admin doing the testing - scopes the conversation so two testers don't collide. */
  userId: string;
  message: string;
  writes?: SandboxWriteMode;
  /** Start over: clears the transcript but keeps the same conversation row. */
  reset?: boolean;
}

export interface SandboxDiagnostics {
  employee: { id: string; name: string; role: string | null };
  department: { id: string; name: string } | null;
  knowledgeUsed: Array<{ title: string; sourceType: string | null }>;
  toolsConsidered: string[];
  simulatedActions: Array<{ tool: string; arguments: Record<string, unknown> }>;
  awaitingApproval: { tool: string; reason: string } | null;
  escalated: { reason: string } | null;
  writeMode: SandboxWriteMode;
  routing: string;
  conversationId: string;
  turnCount: number;
}

export interface SandboxTurnResult {
  reply: string;
  diagnostics: SandboxDiagnostics;
}

/** Deterministic per (agent, tester) so repeat visits resume the same thread. */
function sandboxExternalId(agentId: string, userId: string): string {
  return `sandbox:${agentId}:${userId}`;
}

/**
 * The conversation used for testing. Marked SANDBOX on the row itself
 * (handledBy) so analytics, inbox listings and reporting can exclude it - a
 * test conversation must never inflate a tenant's real conversation metrics.
 */
export async function ensureSandboxConversation(
  tenantId: string,
  agentId: string,
  userId: string,
): Promise<{ id: string; created: boolean }> {
  const customerExternalId = sandboxExternalId(agentId, userId);
  const existing = await prisma.conversation.findFirst({
    where: { tenantId, customerExternalId },
    select: { id: true },
  });
  if (existing) return { id: existing.id, created: false };

  const created = await prisma.conversation.create({
    data: {
      tenantId,
      channel: "WEBCHAT",
      customerExternalId,
      customerName: "Test conversation",
      assignedAiAgentId: agentId,
      handledBy: "sandbox",
      status: "OPEN",
    },
    select: { id: true },
  });
  return { id: created.id, created: true };
}

export async function isSandboxConversation(conversationId: string): Promise<boolean> {
  const c = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { customerExternalId: true },
  });
  return !!c?.customerExternalId?.startsWith("sandbox:");
}

/** Wipe the transcript without losing the conversation row (and its id). */
export async function resetSandboxConversation(tenantId: string, conversationId: string): Promise<void> {
  await prisma.message.deleteMany({ where: { tenantId, conversationId } });
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { aiSummary: null, chatbotFlowId: null, chatbotNodeId: null, flowVariables: undefined, detectedLocale: null },
  }).catch(() => {});
}

export async function runSandboxTurn(input: SandboxTurnInput): Promise<SandboxTurnResult | null> {
  const agent = await prisma.aIAgent.findFirst({
    where: { id: input.agentId, tenantId: input.tenantId },
    select: { id: true, name: true, role: true, departmentId: true },
  });
  if (!agent) return null;

  const { id: conversationId } = await ensureSandboxConversation(input.tenantId, agent.id, input.userId);
  if (input.reset) await resetSandboxConversation(input.tenantId, conversationId);

  const writes: SandboxWriteMode = input.writes === "real" ? "real" : "safe";

  // Persist the inbound exactly as the channel would, so the production path
  // reads its history from the same place it always does.
  await prisma.message.create({
    data: {
      tenantId: input.tenantId,
      conversationId,
      channel: "WEBCHAT",
      direction: "INBOUND",
      body: input.message,
      status: "DELIVERED",
      senderName: "Test conversation",
      metadata: { sandbox: true },
    },
  });

  const result = await generateAIBotReply({
    tenantId: input.tenantId,
    conversationId,
    aiAgentId: agent.id,
    incomingMessage: input.message,
    // Sandbox execution mode is threaded through to the tool dispatcher.
    sandbox: { enabled: true, writes },
  });

  const reply = String(result.reply ?? "").trim();

  if (reply) {
    await prisma.message.create({
      data: {
        tenantId: input.tenantId,
        conversationId,
        channel: "WEBCHAT",
        direction: "OUTBOUND",
        body: reply,
        status: "SENT",
        senderName: agent.name,
        metadata: { sandbox: true, simulated: writes === "safe" },
      },
    });
  }

  const department = agent.departmentId
    ? await prisma.department.findFirst({
        where: { id: agent.departmentId, tenantId: input.tenantId },
        select: { id: true, name: true },
      })
    : null;

  const turnCount = await prisma.message.count({ where: { tenantId: input.tenantId, conversationId } });

  // Diagnostics are derived from what the production turn actually reported -
  // its tool-call log, its retrieval list, its escalation and approval state.
  // Nothing here is inferred from the reply text, because the point of the
  // panel is to explain an answer the operator already distrusts.
  const log = result.toolCallLog ?? [];
  const simulatedActions = log
    .filter((t) => t.sideEffect === "simulated" || (typeof t.result === "string" && t.result.includes('"simulated":true')))
    .map((t) => ({ tool: t.tool, arguments: t.args ?? {} }));

  return {
    reply,
    diagnostics: {
      employee: { id: agent.id, name: agent.name, role: agent.role ?? null },
      department,
      knowledgeUsed: result.knowledgeUsed ?? [],
      toolsConsidered: log.map((t) => t.tool).filter(Boolean),
      simulatedActions,
      awaitingApproval: result.awaitingApproval
        ? { tool: result.awaitingApproval.tool, reason: result.awaitingApproval.reason }
        : null,
      escalated: result.escalation ? { reason: result.escalation.reason } : null,
      writeMode: writes,
      routing: department ? `department: ${department.name}` : `employee: ${agent.name}`,
      conversationId,
      turnCount,
    },
  };
}
