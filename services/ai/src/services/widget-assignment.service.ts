/**
 * Who answers the website widget's channels, read from and written to THE
 * PLAYBOOK (FlowCanvas) - the one place that decides who answers (Omer's
 * decision 2026-10-08; docs/api/website-widget-v1.md §4).
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
import { prisma, auditUser } from "@chatcenter/shared";
import { entryFor } from "./employee-reach.service";

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

export async function readAssignment(tenantId: string) {
  const { nodes, edges, widget, all, employees } = await load(tenantId);
  const paths = new Map(all.map((c) => [c, pathFor(nodes, edges, c)]));
  const name = (id: string | null) => employees.find((e) => e.id === id);
  return {
    channels: widget.map(({ channel }) => {
      const p = paths.get(channel)!;
      const emp = p.how === "always" ? name(p.employeeId) : undefined;
      return {
        channel,
        employee: emp ? { id: emp.id, name: emp.name } : null,
        how: p.how,
        editable: p.how !== "conditional",
        dedicated: p.dedicated,
        sharedWith: sharedWith(paths, p),
      };
    }),
    employees: employees.map((e) => ({ id: e.id, name: e.name, active: e.status === "ACTIVE" })),
  };
}

export class AssignmentError extends Error {
  constructor(public status: number, public code: string, public extra: Record<string, unknown> = {}) { super(code); }
}

/** Point the widget's channels at one employee, in the playbook. All or nothing. */
export async function writeAssignment(
  tenantId: string,
  userId: string | null,
  body: { employeeId?: unknown; channels?: unknown; includeShared?: unknown },
) {
  const { canvas, nodes, edges, widget, all, employees } = await load(tenantId);
  if (!widget.length) throw new AssignmentError(409, "WIDGET_NOT_CREATED");
  const employee = employees.find((e) => e.id === String(body.employeeId ?? "") && e.status === "ACTIVE");
  if (!employee) throw new AssignmentError(422, "EMPLOYEE_NOT_FOUND");
  const asked = Array.isArray(body.channels) ? body.channels.map((c) => String(c).toUpperCase()) : null;
  const targets = widget.filter((w) => !asked || asked.includes(w.channel));
  if (!targets.length) throw new AssignmentError(422, "NO_WIDGET_CHANNEL");
  const includeShared = body.includeShared === true;
  const targetNames = targets.map((t) => t.channel);

  // No playbook yet: the one we create (start → route) answers EVERY channel.
  if (!nodes.length) {
    const others = all.filter((c) => !targetNames.includes(c)).sort();
    if (others.length && !includeShared) throw new AssignmentError(409, "PLAYBOOK_SHARED", { channels: targetNames, sharedWith: others });
  }
  const paths = new Map(all.map((c) => [c, pathFor(nodes, edges, c)]));
  const hasEntries = nodes.some((n) => n.type === "channel_entry");
  const conditional: string[] = [];
  const shared: Array<{ channel: string; sharedWith: string[] }> = [];
  type Step = { kind: "retarget"; nodeId: string; channels: string[] } | { kind: "append_route"; afterId: string; channels: string[] } | { kind: "create"; channel: string; accountId: string };
  const plan: Step[] = [];

  for (const t of nodes.length ? targets : []) {
    const p = paths.get(t.channel)!;
    if (p.how === "conditional") { conditional.push(t.channel); continue; }
    const others = sharedWith(paths, p).filter((c) => !targetNames.includes(c));
    if (others.length === 0 || includeShared) {
      const channels = [t.channel, ...(includeShared ? others : [])];
      if (p.routeNodeId) plan.push({ kind: "retarget", nodeId: p.routeNodeId, channels });
      else if (p.lastNodeId) plan.push({ kind: "append_route", afterId: p.lastNodeId, channels });
      else if (hasEntries) plan.push({ kind: "create", channel: t.channel, accountId: t.accountId });
      else shared.push({ channel: t.channel, sharedWith: others });
      continue;
    }
    // Shared with channels outside the request.
    if (!p.dedicated && hasEntries) { plan.push({ kind: "create", channel: t.channel, accountId: t.accountId }); continue; }
    shared.push({ channel: t.channel, sharedWith: others });
  }
  if (conditional.length) throw new AssignmentError(409, "PLAYBOOK_CONDITIONAL", { channels: conditional });
  if (shared.length) throw new AssignmentError(409, "PLAYBOOK_SHARED", { channels: shared.map((s) => s.channel), sharedWith: [...new Set(shared.flatMap((s) => s.sharedWith))].sort() });

  // Apply (to copies; one write).
  const nextNodes: Node[] = nodes.map((n) => ({ ...n, data: { ...(n.data ?? {}) } }));
  const nextEdges: Edge[] = [...edges];
  const byId = new Map(nextNodes.map((n) => [n.id, n]));
  const maxY = nextNodes.reduce((m, n) => Math.max(m, n.position?.y ?? 0), 0);
  const stamp = Date.now();
  const changed: Array<{ channel: string; from: { id: string; name: string } | null; created: boolean }> = [];
  const fromOf = (channel: string) => {
    const p = paths.get(channel);
    const e = p?.how === "always" ? employees.find((x) => x.id === p.employeeId) : undefined;
    return e ? { id: e.id, name: e.name } : null;
  };
  let row = 0;
  const seenNodes = new Set<string>();
  for (const step of plan) {
    if (step.kind === "retarget") {
      if (!seenNodes.has(step.nodeId)) {
        seenNodes.add(step.nodeId);
        const n = byId.get(step.nodeId)!;
        n.data = { ...n.data, routeType: "agent", targetId: employee.id };
      }
      for (const c of step.channels) changed.push({ channel: c, from: fromOf(c), created: false });
    } else if (step.kind === "append_route") {
      const after = byId.get(step.afterId)!;
      const route: Node = { id: `route_target-${stamp}-${row}`, type: "route_target", data: { routeType: "agent", targetId: employee.id }, position: { x: (after.position?.x ?? 400) + 350, y: after.position?.y ?? 100 } };
      nextNodes.push(route);
      nextEdges.push({ id: `e-${after.id}-${route.id}`, source: after.id, target: route.id });
      row++;
      for (const c of step.channels) changed.push({ channel: c, from: fromOf(c), created: true });
    } else {
      const y = maxY + 150 * (++row);
      const entry: Node = { id: `channel_entry-${stamp}-${step.channel.toLowerCase()}`, type: "channel_entry", data: { channelId: step.accountId, channelType: step.channel.toLowerCase(), label: "", connected: true }, position: { x: 400, y } };
      const route: Node = { id: `route_target-${stamp}-${step.channel.toLowerCase()}`, type: "route_target", data: { routeType: "agent", targetId: employee.id }, position: { x: 750, y } };
      // Appended: the first channel_entry (the others' fallback) stays first.
      nextNodes.push(entry, route);
      nextEdges.push({ id: `e-${entry.id}-${route.id}`, source: entry.id, target: route.id });
      changed.push({ channel: step.channel, from: fromOf(step.channel), created: true });
    }
  }

  if (!nodes.length) for (const c of [...targetNames, ...(includeShared ? all.filter((x) => !targetNames.includes(x)) : [])]) changed.push({ channel: c, from: null, created: true });
  if (canvas && nodes.length) {
    await (prisma as any).flowCanvas.update({ where: { tenantId }, data: { nodes: nextNodes, edges: nextEdges, updatedBy: userId } });
  } else {
    // No playbook yet (or an empty one): start → route, the shape the editor creates.
    const start: Node = { id: `start-${stamp}`, type: "start", data: { trigger: "message_received" }, position: { x: 400, y: 100 } };
    const route: Node = { id: `route_target-${stamp}`, type: "route_target", data: { routeType: "agent", targetId: employee.id }, position: { x: 750, y: 100 } };
    const data = { nodes: [start, route], edges: [{ id: `e-${start.id}-${route.id}`, source: start.id, target: route.id }], updatedBy: userId };
    await (prisma as any).flowCanvas.upsert({ where: { tenantId }, create: { tenantId, ...data }, update: data });
  }
  await auditUser(tenantId, userId, "playbook.route_updated", { type: "flow_canvas", id: canvas?.id ?? tenantId }, {
    source: "website_widget", employeeId: employee.id, channels: changed.map((c) => c.channel),
  });
  return { ...(await readAssignment(tenantId)), changed };
}
