/**
 * Where an AI employee answers, read from the playbook (FlowCanvas), the one
 * thing the runtime routes by. AIAgent.channels is display-only and inert;
 * this replaces it for the screens.
 *
 * Mirrors the flow executor's entry choice: an inbound on channel C starts at
 * the channel_entry whose channelType is C, else at the first channel_entry,
 * else at a start node (a playbook with no channel entries at all).
 * From there:
 *   - "always": the single path (no branch) reaches a route to this employee
 *     before any other employee
 *   - "sometimes": only some branch (a condition, hours, a choice) reaches it
 */
import { prisma } from "@chatcenter/shared";

export type Reach = "always" | "sometimes";

const isRouteTo = (n: any, agentId: string) => (n?.data?.routeType ?? "agent") === "agent" && n?.data?.targetId === agentId;
const isAnyAgentRoute = (n: any) => (n?.data?.routeType ?? "agent") === "agent" && !!n?.data?.targetId && n?.type !== "channel_entry";

/** The node an inbound on `channel` enters the playbook at (flow-executor's rule, keyword triggers aside). */
export function entryFor(nodes: any[], channel: string): any | null {
  const entries = nodes.filter((n) => n?.type === "channel_entry");
  return entries.find((n) => String(n?.data?.channelType ?? "").toLowerCase() === channel.toLowerCase())
    ?? entries[0]
    ?? nodes.find((n) => n?.type === "start")
    ?? null;
}

export function reachFrom(entryId: string, nodes: any[], edges: any[], agentId: string): Reach | null {
  const byId = new Map(nodes.map((n) => [n?.id, n]));
  const out = (id: string) => edges.filter((e) => e?.source === id).map((e) => e.target);
  // The single path, while it does not branch.
  let cur: string | undefined = entryId;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const n = byId.get(cur);
    if (cur !== entryId && isAnyAgentRoute(n)) return isRouteTo(n, agentId) ? "always" : null;
    const next = out(cur);
    if (next.length !== 1) break;
    cur = next[0];
  }
  // Any branch at all.
  const queue = [entryId];
  const visited = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const n = byId.get(id);
    if (id !== entryId && isRouteTo(n, agentId)) return "sometimes";
    // A route to another employee ends that branch: the conversation is theirs.
    if (id !== entryId && isAnyAgentRoute(n)) continue;
    queue.push(...out(id));
  }
  return null;
}

export interface ReachAccount {
  channelAccountId: string;
  /** The channel's own name: a WhatsApp number's verified name, "@handle", a page name. */
  displayName: string | null;
  /** WhatsApp: the number as shown; otherwise null. */
  detail: string | null;
}

/**
 * Per channel the workspace has, whether this employee answers there, and the
 * accounts of that channel (A7, 2026-10-13). The playbook routes by channel
 * TYPE (the flow executor matches channel_entry by type), so every active
 * account of a reached channel is reached the same way.
 */
export async function whereEmployeeAnswers(tenantId: string, agentId: string): Promise<Array<{ channel: string; reach: Reach; accounts: ReachAccount[] }>> {
  const [canvas, accounts] = await Promise.all([
    (prisma as any).flowCanvas.findUnique({ where: { tenantId }, select: { nodes: true, edges: true } }),
    prisma.channelAccount.findMany({ where: { tenantId, isActive: true }, select: { id: true, channel: true, displayName: true, platformMeta: true } as any }),
  ]);
  const nodes: any[] = Array.isArray(canvas?.nodes) ? canvas.nodes : [];
  const edges: any[] = Array.isArray(canvas?.edges) ? canvas.edges : [];
  const channels = [...new Set((accounts as any[]).map((a) => String(a.channel)))].sort();
  const out: Array<{ channel: string; reach: Reach; accounts: ReachAccount[] }> = [];
  for (const ch of channels) {
    const entry = entryFor(nodes, ch);
    if (!entry) continue;
    const reach = reachFrom(entry.id, nodes, edges, agentId);
    if (!reach) continue;
    const ofChannel = (accounts as any[])
      .filter((a) => String(a.channel) === ch)
      .map((a) => {
        const meta = a.platformMeta && typeof a.platformMeta === "object" ? (a.platformMeta as Record<string, any>) : {};
        return {
          channelAccountId: String(a.id),
          displayName: (a.displayName as string | null) ?? meta.verifiedName ?? null,
          detail: ch === "WHATSAPP" ? (meta.displayPhoneNumber ?? null) : null,
        };
      });
    out.push({ channel: ch, reach, accounts: ofChannel });
  }
  return out;
}
