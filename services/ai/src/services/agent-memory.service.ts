/**
 * System Copilot — short-term memory.
 *
 * Per-user, per-tenant rolling history backed by `SystemAgentMessage`.
 * Isolated from the customer-facing Conversation/Message tables: operator
 * threads have a different lifecycle (no inbox surface, no realtime
 * publisher, no closed/waiting status), and mixing them would force every
 * customer-side query to add a "kind" filter forever.
 *
 * Memory is bounded:
 *   - We only LOAD the last N messages per (userId, tenantId).
 *   - We never delete on write — old rows stay queryable for audit.
 *   - A future job can prune rows older than X days; for now the index
 *     keeps reads fast regardless of total size.
 */

import { prisma } from "@chatcenter/shared";

export type SystemAgentRole = "user" | "assistant" | "tool";

export interface AgentMemoryMessage {
  id: string;
  role: SystemAgentRole;
  content: string;
  toolCalls?: any[] | null;
  toolCallId?: string | null;
  toolName?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: Date;
}

export interface AppendMemoryInput {
  tenantId: string;
  userId: string;
  sessionId: string;
  role: SystemAgentRole;
  content: string;
  toolCalls?: any[];
  toolCallId?: string;
  toolName?: string;
  metadata?: Record<string, unknown>;
}

const DEFAULT_HISTORY_LIMIT = 30;

/**
 * Load the most-recent N messages for an operator's session, ordered ASC
 * (oldest → newest) so the runtime can pass them straight into the LLM.
 *
 * Bounded by `limit` rather than session size so a long-running session
 * doesn't blow up the prompt. The system-copilot prompt assumes the model
 * can handle some loss of older context — operators usually re-state.
 */
export async function getAgentMemory(opts: {
  tenantId: string;
  userId: string;
  limit?: number;
}): Promise<AgentMemoryMessage[]> {
  const rows = await (prisma as any).systemAgentMessage.findMany({
    where: { tenantId: opts.tenantId, userId: opts.userId },
    orderBy: { createdAt: "desc" },
    take: opts.limit ?? DEFAULT_HISTORY_LIMIT,
  });

  return rows
    .map((r: any) => ({
      id: r.id,
      role: r.role as SystemAgentRole,
      content: r.content,
      toolCalls: r.toolCalls ?? null,
      toolCallId: r.toolCallId ?? null,
      toolName: r.toolName ?? null,
      metadata: r.metadata ?? null,
      createdAt: r.createdAt,
    }))
    .reverse();
}

export async function appendToMemory(input: AppendMemoryInput): Promise<AgentMemoryMessage> {
  const row = await (prisma as any).systemAgentMessage.create({
    data: {
      tenantId: input.tenantId,
      userId: input.userId,
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      toolCalls: input.toolCalls ?? null,
      toolCallId: input.toolCallId ?? null,
      toolName: input.toolName ?? null,
      metadata: input.metadata ?? null,
    },
  });
  return {
    id: row.id,
    role: row.role as SystemAgentRole,
    content: row.content,
    toolCalls: row.toolCalls,
    toolCallId: row.toolCallId,
    toolName: row.toolName,
    metadata: row.metadata,
    createdAt: row.createdAt,
  };
}

/**
 * Convert memory rows into the OpenAI chat-message shape. Tool messages
 * carry their `tool_call_id` so the model's tool-calling protocol stays
 * intact across turns.
 */
export function memoryToChatMessages(messages: AgentMemoryMessage[]): any[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return {
        role: "tool",
        tool_call_id: m.toolCallId,
        content: m.content,
      };
    }
    if (m.role === "assistant" && m.toolCalls && Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
      return {
        role: "assistant",
        content: m.content || "",
        tool_calls: m.toolCalls,
      };
    }
    return { role: m.role, content: m.content };
  });
}

/**
 * Wipe memory for a (tenantId, userId). Used when the operator hits "clear
 * conversation" in the Command Center modal.
 */
export async function clearAgentMemory(opts: { tenantId: string; userId: string }): Promise<number> {
  const r = await (prisma as any).systemAgentMessage.deleteMany({
    where: { tenantId: opts.tenantId, userId: opts.userId },
  });
  return r.count ?? 0;
}
