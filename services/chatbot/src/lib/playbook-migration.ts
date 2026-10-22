/**
 * The playbook canvas, as "New conversation" automations (2026-10-22).
 *
 * Pure: a tenant's canvas in, the automations to create and a report out. The
 * script (scripts/migrate-playbook-to-automations.ts) does the writing.
 *
 * What the canvas did for a new conversation (flow-executor pickMainFlowEntry,
 * keyword/campaign entries aside): the channel's own channel_entry, else the
 * FIRST channel_entry, else start; from the entry, its FIRST edge only.
 * Faithful mapping:
 *   - each channel's own entry -> an automation for that channel;
 *   - the first entry (the canvas's fallback for every other channel) -> also
 *     an automation with no channels, which the runner tries last
 *     (routingFallbackLast), exactly the canvas's "own entry, else first";
 *   - a canvas with only `start` -> one automation with no channels.
 * Inside a path: route_target / default_fallback "agent" -> hand_to_ai;
 * "human"/department -> assign to that team (the same dispatch); every other
 * step is carried as is when the go-live gate accepts it
 * (send_message_quick_reply is legacy-runnable, branches and all).
 *
 * Nothing is dropped silently. A path that cannot be carried (a route to a
 * sub-flow, an empty route, a step the gate refuses) is reported and that
 * channel is NOT migrated; a canvas with any other trigger on it (comment,
 * webhook, schedule, keyword, voice) is refused as a whole, because emptying
 * the canvas would switch those off.
 */
import { CHANNELS, validateAutomation, type Channel } from "./automation-catalog";

type Node = { id: string; type: string; data?: any; position?: { x: number; y: number } };
type Edge = { id?: string; source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null };

export interface PlannedAutomation {
  name: string;
  channels: Channel[];
  /** The canvas entry it came from. */
  fromEntryId: string;
  nodes: Node[];
  edges: Edge[];
  warnings: string[];
}

export interface PlaybookPlan {
  /** False: the canvas must not be emptied (see `refused`). */
  migratable: boolean;
  refused: string | null;
  automations: PlannedAutomation[];
  /** Everything not carried, and why. */
  notMigrated: string[];
}

const ROUTES = new Set(["route_target", "default_fallback"]);
const ROUTING_ENTRIES = new Set(["channel_entry", "start"]);
/** Triggers the canvas runs from OTHER events: emptying the canvas would stop them. */
const OTHER_TRIGGERS = new Set(["keyword_trigger", "comment_trigger", "schedule_trigger", "webhook_trigger", "campaign_entry"]);

const CHANNEL_LABEL: Record<string, string> = {
  WHATSAPP: "WhatsApp", MESSENGER: "Messenger", INSTAGRAM: "Instagram", EMAIL: "Email", GMAIL: "Gmail",
  OUTLOOK: "Outlook", SLACK: "Slack", VOICE: "Voice", WEBCHAT: "the website chat", SHOPIFY_LIVE_CHAT: "the Shopify store chat",
};

function channelOf(entry: Node): Channel | null {
  const c = String(entry.data?.channelType ?? "").toUpperCase();
  return (CHANNELS as string[]).includes(c) ? (c as Channel) : null;
}

/** One entry's path, as an automation graph, or why it cannot be one. */
function pathAutomation(entry: Node, nodes: Node[], edges: Edge[]): { nodes: Node[]; edges: Edge[] } | { why: string } {
  const first = edges.find((e) => e.source === entry.id);
  if (!first) return { why: "it leads nowhere (no conversation there was routed)" };
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const keep = new Map<string, Node>();
  const keptEdges: Edge[] = [{ id: `e-trigger-${first.target}`, source: "trigger", target: first.target }];
  const queue = [first.target];
  while (queue.length) {
    const id = queue.shift()!;
    if (keep.has(id)) continue;
    const n = byId.get(id);
    if (!n) return { why: `a step it reaches (${id}) is missing from the canvas` };
    if (ROUTING_ENTRIES.has(n.type) || OTHER_TRIGGERS.has(n.type)) return { why: `it loops back into another entry (${n.type})` };
    if (ROUTES.has(n.type)) {
      const routeType = n.data?.routeType ?? "agent";
      const target = n.data?.targetId;
      if (!target) return { why: `its route (${n.id}) names nobody` };
      if (routeType === "agent") keep.set(id, { id, type: "hand_to_ai", position: n.position, data: { aiAgentId: String(target) } });
      else if (routeType === "human") keep.set(id, { id, type: "assign", position: n.position, data: { to: "team", departmentId: String(target) } });
      else return { why: `its route (${n.id}) goes to a sub-flow, which an automation cannot start` };
      continue; // a route ends its branch, as in the canvas
    }
    keep.set(id, { ...n, data: { ...(n.data ?? {}) } });
    for (const e of edges.filter((x) => x.source === id)) {
      keptEdges.push({ id: e.id ?? `e-${e.source}-${e.target}`, source: e.source, target: e.target, ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}) });
      queue.push(e.target);
    }
  }
  return {
    nodes: [{ id: "trigger", type: "automation_trigger", position: entry.position ?? { x: 0, y: 0 }, data: {} }, ...keep.values()],
    edges: keptEdges,
  };
}

export function planPlaybookMigration(canvas: { nodes?: unknown; edges?: unknown } | null): PlaybookPlan {
  const nodes: Node[] = Array.isArray(canvas?.nodes) ? (canvas!.nodes as Node[]) : [];
  const edges: Edge[] = Array.isArray(canvas?.edges) ? (canvas!.edges as Edge[]) : [];
  const plan: PlaybookPlan = { migratable: true, refused: null, automations: [], notMigrated: [] };

  const other = nodes.filter((n) => OTHER_TRIGGERS.has(n.type) || String(n.type).startsWith("voice_trigger"));
  if (other.length) {
    return { ...plan, migratable: false, refused: `the canvas also runs other triggers (${[...new Set(other.map((n) => n.type))].join(", ")}); emptying it would switch them off` };
  }

  const entries = nodes.filter((n) => n.type === "channel_entry");
  const start = nodes.find((n) => n.type === "start") ?? null;
  const add = (entry: Node, channels: Channel[], name: string) => {
    const g = pathAutomation(entry, nodes, edges);
    const where = channels.length ? CHANNEL_LABEL[channels[0]!] ?? channels[0] : "every other channel";
    if ("why" in g) { plan.notMigrated.push(`${where} (entry ${entry.id}): ${g.why}`); return; }
    const v = validateAutomation({ type: "conversation_started", config: channels.length ? { channels } : {} }, g.nodes as any, g.edges as any);
    if (v.errors.length) {
      plan.notMigrated.push(`${where} (entry ${entry.id}): the automations check refuses it: ${v.errors.map((e) => e.message).join(" ")}`);
      return;
    }
    plan.automations.push({ name, channels, fromEntryId: entry.id, nodes: g.nodes, edges: g.edges, warnings: v.warnings.map((w) => w.message) });
  };

  const seen = new Set<string>();
  for (const entry of entries) {
    const ch = channelOf(entry);
    if (!ch) { plan.notMigrated.push(`entry ${entry.id}: unknown channel "${entry.data?.channelType ?? ""}"`); continue; }
    // The canvas takes the FIRST entry for a channel; a later one never ran.
    if (seen.has(ch)) { plan.notMigrated.push(`entry ${entry.id}: a second ${CHANNEL_LABEL[ch] ?? ch} entry, never used by the canvas`); continue; }
    seen.add(ch);
    add(entry, [ch], `Who answers on ${CHANNEL_LABEL[ch] ?? ch} (from the playbook)`);
  }
  // The canvas's fallback: the first entry, else start, serves every channel
  // without an entry of its own.
  const fallback = entries[0] ?? start;
  if (fallback) add(fallback, [], "Who answers on every other channel (from the playbook)");

  const unused = nodes.filter((n) => !ROUTING_ENTRIES.has(n.type) && !edges.some((e) => e.target === n.id));
  for (const n of unused) plan.notMigrated.push(`step ${n.id} (${n.type}): nothing leads to it, so it never ran`);
  return plan;
}
