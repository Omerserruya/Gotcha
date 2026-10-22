/**
 * Who answers the website widget's channels.
 *
 * ★ 2026-10-22: AUTOMATIONS decide, not the playbook. A channel is answered by
 *   the "New conversation" automation (trigger conversation_started) that
 *   matches it - its own first, else one for every channel. Writes create or
 *   update the widget channel's OWN automation (trigger -> hand to AI), so a
 *   change here never moves another channel. The playbook canvas is read only
 *   for a workspace that has no routing automation yet (not migrated), and is
 *   never written any more.
 *
 * Before 2026-10-22 this read and wrote THE PLAYBOOK (FlowCanvas) (Omer's
 * decision 2026-10-08; docs/api/website-widget-v1.md §4):
 *
 * The playbook's entry rule (flow-executor findEntry, keyword triggers aside):
 * the channel's own channel_entry, else the FIRST channel_entry, else start.
 * Hence the two rules this file keeps:
 *   - a route reached by channels outside the request is never changed
 *     silently (409 PLAYBOOK_SHARED unless includeShared);
 *   - a channel entry is added only to a playbook that already has some, and
 *     appended (a first entry would carry every other channel with it, and an
 *     entry placed first would become the others' fallback).
 */
import { prisma, auditUser, buildRoutingGraph, straightRouteStep, ROUTING_TRIGGER } from "@chatcenter/shared";
import { entryFor, routingAutomations, routingAutomationFor, type RoutingAutomation } from "./employee-reach.service";

type Node = { id: string; type: string; data?: any; position?: { x: number; y: number } };
type Edge = { id: string; source: string; target: string; sourceHandle?: string };

export type How = "always" | "conditional" | "team" | "flow" | "none";

export interface ChannelPath {
  channel: string;
  entryId: string | null;
  dedicated: boolean;
  how: How;
  routeNodeId: string | null;   // the route the single path reaches
  lastNodeId: string | null;    // the last node of a path that reaches no route
  employeeId: string | null;
  routesReached: string[];      // every route any branch reaches (for "shared")
}

const ROUTE_TYPES = new Set(["route_target", "default_fallback"]);
const ENTRY_TYPES = new Set(["channel_entry", "start"]);

const outOf = (edges: Edge[], id: string) => edges.filter((e) => e?.source === id);

/** Follow a channel's path through the playbook the way the walker does. */
export function pathFor(nodes: Node[], edges: Edge[], channel: string): ChannelPath {
  const entry = entryFor(nodes, channel) as Node | null;
  const base: ChannelPath = {
    channel, entryId: entry?.id ?? null,
    dedicated: !!entry && entry.type === "channel_entry" && String(entry.data?.channelType ?? "").toLowerCase() === channel.toLowerCase(),
    how: "none", routeNodeId: null, lastNodeId: null, employeeId: null, routesReached: [],
  };
  if (!entry) return base;
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // Every route any branch reaches (a route ends its branch).
  const reached = new Set<string>();
  const seen = new Set<string>();
  const queue = [entry.id];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const n = byId.get(id);
    if (id !== entry.id && n && ROUTE_TYPES.has(n.type)) { reached.add(id); continue; }
    const next = n && ENTRY_TYPES.has(n.type) ? outOf(edges, id).slice(0, 1) : outOf(edges, id);
    queue.push(...next.map((e) => e.target));
  }
  base.routesReached = [...reached];

  // The single path: an entry follows its first edge (as the walker does);
  // any other node with more than one way out is a condition.
  let cur: Node | undefined = entry;
  const walked = new Set<string>();
  while (cur && !walked.has(cur.id)) {
    walked.add(cur.id);
    if (cur !== entry && ROUTE_TYPES.has(cur.type)) {
      const routeType = cur.data?.routeType || "agent";
      base.routeNodeId = cur.id;
      base.how = routeType === "agent" ? (cur.data?.targetId ? "always" : "none") : routeType === "human" ? "team" : "flow";
      base.employeeId = routeType === "agent" ? cur.data?.targetId ?? null : null;
      return base;
    }
    const out = outOf(edges, cur.id);
    if (out.length === 0) { base.lastNodeId = cur.id; return base; }
    if (!ENTRY_TYPES.has(cur.type) && out.length > 1) { base.how = "conditional"; return base; }
    cur = byId.get(out[0]!.target);
  }
  return base;
}

/** The widget's channels: the code snippet (web chat) and Shopify, where installed. */
export async function widgetChannels(tenantId: string): Promise<Array<{ channel: string; accountId: string }>> {
  const accounts = await prisma.channelAccount.findMany({
    where: { tenantId, channel: { in: ["WEBCHAT", "SHOPIFY_LIVE_CHAT"] as any } },
    orderBy: { createdAt: "asc" },
    select: { id: true, channel: true },
  });
  const out: Array<{ channel: string; accountId: string }> = [];
  for (const a of accounts as any[]) if (!out.some((o) => o.channel === a.channel)) out.push({ channel: String(a.channel), accountId: a.id });
  return out;
}

async function load(tenantId: string) {
  const [canvas, widget, active, employees] = await Promise.all([
    (prisma as any).flowCanvas.findUnique({ where: { tenantId }, select: { id: true, nodes: true, edges: true } }),
    widgetChannels(tenantId),
    prisma.channelAccount.findMany({ where: { tenantId, isActive: true }, select: { channel: true } }),
    prisma.aIAgent.findMany({ where: { tenantId }, select: { id: true, name: true, status: true }, orderBy: { name: "asc" } }),
  ]);
  const nodes: Node[] = Array.isArray(canvas?.nodes) ? canvas.nodes : [];
  const edges: Edge[] = Array.isArray(canvas?.edges) ? canvas.edges : [];
  // Every channel the playbook can be asked about: the workspace's active ones and the widget's.
  const all = [...new Set([...(active as any[]).map((a) => String(a.channel)), ...widget.map((w) => w.channel)])];
  return { canvas, nodes, edges, widget, all, employees: employees as Array<{ id: string; name: string; status: string }> };
}

function sharedWith(paths: Map<string, ChannelPath>, p: ChannelPath): string[] {
  const route = p.routeNodeId ?? null;
  return [...paths.values()]
    .filter((q) => q.channel !== p.channel && (
      (route && q.routesReached.includes(route)) ||
      // A path with no route, entered at the same node, is the same path.
      (!route && q.entryId && q.entryId === p.entryId)
    ))
    .map((q) => q.channel)
    .sort();
}

/** A widget channel as a routing automation answers it. */
function automationPath(auto: RoutingAutomation, channel: string): ChannelPath {
  const step = straightRouteStep(auto.nodes, auto.edges);
  const handsOver = auto.nodes.some((n) => n?.type === "hand_to_ai");
  return {
    channel,
    entryId: auto.id,
    dedicated: auto.channels.length === 1 && auto.channels[0] === channel,
    how: step ? (step.data?.aiAgentId ? "always" : "none") : handsOver ? "conditional" : "flow",
    routeNodeId: step?.id ?? null,
    lastNodeId: null,
    employeeId: step?.data?.aiAgentId ?? null,
    routesReached: [],
  };
}

export async function readAssignment(tenantId: string) {
  const { nodes, edges, widget, all, employees } = await load(tenantId);
  const autos = await routingAutomations(tenantId);
  const name = (id: string | null) => employees.find((e) => e.id === id);
  // A workspace with routing automations is decided by them; the playbook
  // only for one that has none yet.
  if (autos.length) {
    return {
      channels: widget.map(({ channel }) => {
        const auto = routingAutomationFor(autos, channel);
        const p: ChannelPath = auto ? automationPath(auto, channel) : {
          channel, entryId: null, dedicated: false, how: "none", routeNodeId: null, lastNodeId: null, employeeId: null, routesReached: [],
        };
        const emp = p.how === "always" ? name(p.employeeId) : undefined;
        const sharedWith = auto && !p.dedicated
          ? all.filter((c) => c !== channel && routingAutomationFor(autos, c)?.id === auto.id).sort()
          : [];
        return {
          channel,
          employee: emp ? { id: emp.id, name: emp.name } : null,
          how: p.how,
          // A write always targets the channel's OWN automation, so only a
          // channel whose own automation has conditions cannot be set here.
          editable: !(p.dedicated && p.how === "conditional"),
          dedicated: p.dedicated,
          sharedWith,
          movesWith: [] as string[],
        };
      }),
      employees: employees.map((e) => ({ id: e.id, name: e.name, active: e.status === "ACTIVE" })),
    };
  }
  const paths = new Map(all.map((c) => [c, pathFor(nodes, edges, c)]));
  const hasEntries = nodes.some((n) => n.type === "channel_entry");
  const widgetNames = widget.map((w) => w.channel);
  return {
    channels: widget.map(({ channel }) => {
      const p = paths.get(channel)!;
      const emp = p.how === "always" ? name(p.employeeId) : undefined;
      const shared = sharedWith(paths, p);
      // What a change made here (for the widget's channels) would also move:
      // nothing when the channel gets an entry of its own (the playbook
      // already has entries), else the other channels on the shared route.
      const outside = shared.filter((c) => !widgetNames.includes(c));
      const movesWith = p.how === "conditional" || outside.length === 0 || (!p.dedicated && hasEntries) ? [] : outside;
      return {
        channel,
        employee: emp ? { id: emp.id, name: emp.name } : null,
        how: p.how,
        editable: p.how !== "conditional",
        dedicated: p.dedicated,
        sharedWith: shared,
        movesWith,
      };
    }),
    employees: employees.map((e) => ({ id: e.id, name: e.name, active: e.status === "ACTIVE" })),
  };
}

export class AssignmentError extends Error {
  constructor(public status: number, public code: string, public extra: Record<string, unknown> = {}) { super(code); }
}

/**
 * Point the widget's channels at one employee: each channel's OWN "New
 * conversation" automation (created if missing, its employee changed if it is
 * a straight trigger -> hand to AI). Never another channel, never the canvas.
 * Refused, with nothing written, when a channel's own automation has
 * conditions (409 PLAYBOOK_CONDITIONAL).
 */
export async function writeAssignment(
  tenantId: string,
  userId: string | null,
  body: { employeeId?: unknown; channels?: unknown; includeShared?: unknown },
) {
  const { widget, employees } = await load(tenantId);
  if (!widget.length) throw new AssignmentError(409, "WIDGET_NOT_CREATED");
  const employee = employees.find((e) => e.id === String(body.employeeId ?? "") && e.status === "ACTIVE");
  if (!employee) throw new AssignmentError(422, "EMPLOYEE_NOT_FOUND");
  const asked = Array.isArray(body.channels) ? body.channels.map((c) => String(c).toUpperCase()) : null;
  const targets = widget.filter((w) => !asked || asked.includes(w.channel));
  if (!targets.length) throw new AssignmentError(422, "NO_WIDGET_CHANNEL");

  // Every automation that is ONLY this channel's, active or paused.
  const own = await (prisma as any).chatbotFlow.findMany({
    where: { tenantId, triggerType: ROUTING_TRIGGER },
    orderBy: { createdAt: "asc" },
    select: { id: true, isActive: true, triggerConfig: true, nodes: true, edges: true },
  });
  const ownFor = (channel: string) => (own as any[]).find((f) => {
    const ch = Array.isArray(f.triggerConfig?.channels) ? f.triggerConfig.channels.map((c: unknown) => String(c).toUpperCase()) : [];
    return ch.length === 1 && ch[0] === channel;
  });

  const before = await readAssignment(tenantId);
  const fromOf = (channel: string) => before.channels.find((c) => c.channel === channel)?.employee ?? null;

  // All or nothing: check every target before writing any.
  const conditional = targets
    .map((t) => ({ t, f: ownFor(t.channel) }))
    .filter(({ f }) => f && !straightRouteStep(Array.isArray(f.nodes) ? f.nodes : [], Array.isArray(f.edges) ? f.edges : []))
    .map(({ t }) => t.channel);
  if (conditional.length) throw new AssignmentError(409, "PLAYBOOK_CONDITIONAL", { channels: conditional });

  const changed: Array<{ channel: string; from: { id: string; name: string } | null; created: boolean }> = [];
  const now = new Date();
  for (const t of targets) {
    const f = ownFor(t.channel);
    if (f) {
      const nodes = (f.nodes as any[]).map((n: any) => (n?.type === "hand_to_ai" ? { ...n, data: { ...(n.data ?? {}), aiAgentId: employee.id } } : n));
      await (prisma as any).chatbotFlow.updateMany({
        where: { id: f.id, tenantId },
        data: { nodes, ...(f.isActive ? {} : { isActive: true, activatedAt: now, activatedBy: userId, pausedAt: null, pausedBy: null }) },
      });
      changed.push({ channel: t.channel, from: fromOf(t.channel), created: false });
    } else {
      const graph = buildRoutingGraph(employee.id);
      await (prisma as any).chatbotFlow.create({
        data: {
          tenantId,
          name: t.channel === "SHOPIFY_LIVE_CHAT" ? "Who answers the Shopify store chat" : "Who answers the website chat",
          channel: t.channel as any,
          triggerType: ROUTING_TRIGGER,
          triggerConfig: { channels: [t.channel] },
          nodes: graph.nodes,
          edges: graph.edges,
          isActive: true,
          activatedAt: now,
          activatedBy: userId,
        },
      });
      changed.push({ channel: t.channel, from: fromOf(t.channel), created: true });
    }
  }
  await auditUser(tenantId, userId, "automation.route_updated", { type: "chatbot_flow", id: tenantId }, {
    source: "website_widget", employeeId: employee.id, channels: changed.map((c) => c.channel),
  });
  return { ...(await readAssignment(tenantId)), changed };
}
