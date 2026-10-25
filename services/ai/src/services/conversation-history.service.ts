/**
 * The conversation the model reads (2026-10-25).
 *
 * `loadRecentHistory` is the LAST `limit` messages, oldest first. The bot used
 * to read `orderBy asc, take 50`: the FIRST 50. Past message 50 the model never
 * saw the newest turns, the customer's current message included (prod: 169
 * conversations over 50 messages, 627 replies written blind in 7 of them).
 *
 * `historyChatMessages` turns those rows into the chat turns the model sees.
 */
import { prisma } from "@chatcenter/shared";

export const BOT_HISTORY_LIMIT = 50;

export interface HistoryRow {
  direction: string;
  body: string | null;
  messageType?: string | null;
  createdAt?: Date | string | null;
}

export async function loadRecentHistory<T = any>(
  tenantId: string,
  conversationId: string,
  limit = BOT_HISTORY_LIMIT,
): Promise<T[]> {
  const newestFirst = await prisma.message.findMany({
    where: { conversationId, tenantId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
  });
  return (newestFirst as T[]).reverse();
}

export function historyChatMessages(rows: HistoryRow[]): Array<{ role: "user" | "assistant"; content: string }> {
  const out: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const m of rows) {
    if (!m.body?.trim()) continue;
    if (m.messageType === "system") continue;
    out.push({ role: m.direction === "INBOUND" ? "user" : "assistant", content: m.body });
  }
  return out;
}
