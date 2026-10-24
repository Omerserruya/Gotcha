/**
 * The Copilot side chat: a private conversation between ONE agent and the
 * Copilot about ONE customer conversation (Omer's model, 2026-10-24). The agent
 * keeps talking to the customer in the main thread; nothing said here reaches
 * the customer. A Copilot answer may carry a `draft`, and a draft enters the
 * composer only when the agent presses "use as reply".
 *
 * The thread lives on the SERVER, per (tenant, conversation, agent):
 *   - the client used to send `history` itself, so any agent could put words in
 *     the Copilot's mouth for the next round; the stored thread is the only
 *     history the model now sees;
 *   - two agents on the same conversation have two threads, neither reads the
 *     other's.
 * Redis, last MAX_TURNS exchanges, kept THREAD_TTL_SECONDS after the last write.
 */
import crypto from "crypto";
import { getRedis } from "@chatcenter/shared";

export const MAX_TURNS = 20;
export const THREAD_TTL_SECONDS = 7 * 24 * 3600;
/** Longer than the slowest round (3 model calls with tools); a crash frees it. */
const LOCK_TTL_SECONDS = 90;
export const MAX_MESSAGE_CHARS = 4000;

export interface CopilotChatTurn {
  id: string;
  role: "agent" | "copilot";
  text: string;
  /** A reply the agent may send the customer as is. Copilot turns only. */
  draft?: string;
  at: string;
}

const threadKey = (tenantId: string, conversationId: string, userId: string) =>
  `copilot:chat:${tenantId}:${conversationId}:${userId}`;
const lockKey = (tenantId: string, conversationId: string, userId: string) =>
  `copilot:chat:lock:${tenantId}:${conversationId}:${userId}`;

export function newTurn(role: CopilotChatTurn["role"], text: string, draft?: string): CopilotChatTurn {
  return {
    id: crypto.randomBytes(8).toString("hex"),
    role,
    text,
    ...(draft ? { draft } : {}),
    at: new Date().toISOString(),
  };
}

export async function readThread(tenantId: string, conversationId: string, userId: string): Promise<CopilotChatTurn[]> {
  const raw = await getRedis().get(threadKey(tenantId, conversationId, userId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Append and keep the newest MAX_TURNS exchanges (an exchange is two turns). */
export async function appendTurns(
  tenantId: string,
  conversationId: string,
  userId: string,
  turns: CopilotChatTurn[],
): Promise<CopilotChatTurn[]> {
  const next = [...(await readThread(tenantId, conversationId, userId)), ...turns].slice(-MAX_TURNS * 2);
  await getRedis().set(threadKey(tenantId, conversationId, userId), JSON.stringify(next), "EX", THREAD_TTL_SECONDS);
  return next;
}

export async function clearThread(tenantId: string, conversationId: string, userId: string): Promise<void> {
  await getRedis().del(threadKey(tenantId, conversationId, userId));
}

/**
 * One round at a time per thread: two tabs sending at once would each read the
 * same history and the second write would drop the first exchange. Returns a
 * release function, or null when a round is already running.
 */
export async function acquireRound(tenantId: string, conversationId: string, userId: string): Promise<(() => Promise<void>) | null> {
  const key = lockKey(tenantId, conversationId, userId);
  const token = crypto.randomBytes(8).toString("hex");
  const ok = await getRedis().set(key, token, "EX", LOCK_TTL_SECONDS, "NX");
  if (ok !== "OK") return null;
  return async () => {
    // Only the holder releases: a round that outlived the TTL must not free
    // the lock a newer round now holds.
    if ((await getRedis().get(key)) === token) await getRedis().del(key);
  };
}

/** The stored thread as the model's chat history. */
export function asModelHistory(turns: CopilotChatTurn[]): Array<{ role: "user" | "assistant"; content: string }> {
  return turns.map((t) => ({
    role: t.role === "agent" ? "user" : "assistant",
    content: t.role === "copilot" && t.draft ? `${t.text}\n\n[Draft reply offered]: ${t.draft}` : t.text,
  }));
}
