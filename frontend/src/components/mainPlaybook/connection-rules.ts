// Connection validation (§3) - the SHARED, framework-agnostic rules that both
// canvases (chatbot/FlowEditor + mainPlaybook/MainPlaybookEditor) enforce via
// React Flow's isValidConnection, and that the frontend validation panel and
// the AUTHORITATIVE backend validator mirror. Pure functions, no React, so
// they're unit-testable and reusable.
import { NODE_REGISTRY, type NodePorts, type NodePort, type PortType } from "./node-registry";

export interface GraphNode { id: string; type: string; data?: any; }
export interface GraphEdge { id?: string; source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null; }

export interface ConnectionAttempt {
  source: string | null;
  target: string | null;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

// Machine-readable rejection code; the UI maps it to a localized, human message
// (never a raw enum). See aiStudio.flow.connErrors.* i18n keys.
export type ConnectionError =
  | "self_loop"
  | "no_input"      // target is an entry/trigger - it has no input port
  | "no_output"     // source handle isn't a real output
  | "single_input"  // target input already has a connection and isn't multiple
  | "incompatible"  // source output type can't feed the target input type
  | "cycle";        // would create a cycle in a control-flow (DAG) process

export interface ConnectionResult {
  ok: boolean;
  code?: ConnectionError;
  /** For "incompatible": the offending port types, for a precise message. */
  fromType?: PortType;
  toType?: PortType;
}

/**
 * A node's semantic ports. DERIVED from the registry `handles` (input iff a
 * target handle exists; one flow output per source; branch type for
 * true/false exits; no output when a node is terminal) unless the entry
 * declares an explicit `ports` override.
 */
export function getNodePorts(type: string, data?: any): NodePorts {
  const entry = NODE_REGISTRY[type];
  if (!entry) {
    // Unknown node type - be permissive so the graph still renders, but treat
    // it as a single-in/single-out "any" node.
    return { inputs: [{ id: "in", type: "any", multiple: true }], outputs: [{ id: "out", type: "any" }] };
  }
  if (entry.ports) return entry.ports;
  const inputs: NodePort[] = entry.handles.target ? [{ id: "in", type: "flow", multiple: false }] : [];
  const sources = entry.getSources ? entry.getSources(data ?? {}) : entry.handles.sources;
  const outputs: NodePort[] = (sources ?? []).map((s, i) => {
    const id = s.id ?? String(i);
    const isBranch = id === "true" || id === "false";
    return { id, type: isBranch ? "branch" : "flow", label: s.label };
  });
  return { inputs, outputs };
}

/** Is a source output type allowed to feed a target input type? */
export function canConnectPorts(from: PortType, to: PortType): boolean {
  if (from === "any" || to === "any") return true;
  if (from === to) return true;
  // A branch exit (condition true/false) is still control flow into a step.
  if ((from === "flow" || from === "branch") && to === "flow") return true;
  // Explicitly forbidden: a participant-lifecycle event cannot feed message
  // content (the canonical §3 example).
  if (from === "participant_event" && to === "message") return false;
  return false;
}

/**
 * Validate a single connection attempt against the current graph. This is the
 * UX gate (React Flow isValidConnection) AND the semantic core the backend
 * re-checks. Returns ok:false with a machine code the caller localizes.
 */
export function validateConnection(
  attempt: ConnectionAttempt,
  nodes: GraphNode[],
  edges: GraphEdge[],
): ConnectionResult {
  const { source, target, sourceHandle, targetHandle } = attempt;
  if (!source || !target) return { ok: false, code: "no_output" };

  // 1. No self-loop.
  if (source === target) return { ok: false, code: "self_loop" };

  const srcNode = nodes.find((n) => n.id === source);
  const tgtNode = nodes.find((n) => n.id === target);
  if (!srcNode || !tgtNode) return { ok: false, code: "no_output" };

  const srcPorts = getNodePorts(srcNode.type, srcNode.data);
  const tgtPorts = getNodePorts(tgtNode.type, tgtNode.data);

  // 2. Target must actually have an input (reject connecting into an
  //    entry/trigger node).
  if (tgtPorts.inputs.length === 0) return { ok: false, code: "no_input" };

  // 3. Source handle must be a real output port.
  const out = sourceHandle
    ? srcPorts.outputs.find((p) => p.id === sourceHandle)
    : srcPorts.outputs[0];
  if (!out) return { ok: false, code: "no_output" };

  // 4. Resolve the target input port.
  const inp = targetHandle
    ? tgtPorts.inputs.find((p) => p.id === targetHandle) ?? tgtPorts.inputs[0]
    : tgtPorts.inputs[0];

  // 5. Single-input: a non-multiple input rejects a second incoming edge.
  if (!inp.multiple) {
    const already = edges.some(
      (e) => e.target === target && (targetHandle ? e.targetHandle === targetHandle : true),
    );
    if (already) return { ok: false, code: "single_input" };
  }

  // 6. Type compatibility.
  if (!canConnectPorts(out.type, inp.type)) {
    return { ok: false, code: "incompatible", fromType: out.type, toType: inp.type };
  }

  // 7. Cycle: adding source→target must not let target already reach source
  //    (control-flow processes are DAGs).
  if (createsCycle(source, target, edges)) return { ok: false, code: "cycle" };

  return { ok: true };
}

// §7 Node types that are static process entries - they anchor the left edge.
export const ENTRY_NODE_TYPES = ["channel_entry", "start", "keyword_trigger", "comment_trigger", "schedule_trigger"];

/**
 * The left boundary X (graph-space) for the editable canvas: leftmost entry
 * node minus padding (or leftmost node when no entry exists yet). Nodes can't
 * be dragged, and the viewport can't pan, left of this. Pure + testable.
 */
export function leftBoundaryX(
  nodes: { position: { x: number }; type: string }[],
  pad = 120,
): number {
  const entries = nodes.filter((n) => ENTRY_NODE_TYPES.includes(n.type));
  const anchor = entries.length ? entries : nodes;
  if (anchor.length === 0) return -pad;
  return Math.min(...anchor.map((n) => n.position.x)) - pad;
}

/** The fixed column triggers start in. Everything else flows to the right. */
export const TRIGGER_COLUMN_X = 0;

/** Minimum gap between the trigger column and the first downstream node. */
export const MIN_BODY_OFFSET_X = 260;

export interface PositionedNode {
  id?: string;
  /**
   * Optional because React Flow's own Node type allows it. A node with no type
   * is not an entry node, so it is treated as body and shifted like one.
   */
  type?: string;
  position: { x: number; y: number };
}

/**
 * Normalize a graph's positions so triggers really are the left-most nodes.
 *
 * `leftBoundaryX` derives the boundary FROM the nodes, which is right for
 * ordinary editing but wrong for a graph that arrives with nonsense
 * coordinates: a trigger imported at x=-5000 simply dragged the boundary out
 * with it, so the "triggers are on the left" rule silently held while the
 * canvas panned into empty space, and a workflow saved by an older version
 * could open with its start node off screen.
 *
 * The rule enforced here:
 *   - every trigger/entry node sits in the trigger column (x = TRIGGER_COLUMN_X),
 *     keeping its own Y so multiple triggers stay in the order the author put
 *     them in;
 *   - the rest of the graph is shifted so nothing sits left of that column.
 *
 * Pure: returns new node objects and never mutates the input. Y is left alone
 * entirely - vertical placement carries meaning the author chose.
 */
export function normalizeGraphPositions<T extends PositionedNode>(nodes: T[]): T[] {
  if (!Array.isArray(nodes) || nodes.length === 0) return nodes ?? [];

  const finite = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

  // Repair unusable coordinates first, so NaN/undefined cannot poison the
  // Math.min below and push the whole graph somewhere unreachable.
  const repaired = nodes.map((n) => ({
    ...n,
    position: { x: finite(n.position?.x), y: finite(n.position?.y) },
  }));

  const isEntry = (n: PositionedNode) => !!n.type && ENTRY_NODE_TYPES.includes(n.type);
  const nonEntries = repaired.filter((n) => !isEntry(n));

  // How far right must the body move so nothing lands in or before the trigger
  // column? Triggers themselves are pinned, so they are not part of this.
  const minBodyX = nonEntries.length ? Math.min(...nonEntries.map((n) => n.position.x)) : Infinity;
  const bodyFloor = TRIGGER_COLUMN_X + MIN_BODY_OFFSET_X;
  const shift = Number.isFinite(minBodyX) && minBodyX < bodyFloor ? bodyFloor - minBodyX : 0;

  return repaired.map((n) =>
    isEntry(n)
      ? ({ ...n, position: { x: TRIGGER_COLUMN_X, y: n.position.y } } as T)
      : ({ ...n, position: { x: n.position.x + shift, y: n.position.y } } as T),
  );
}

/**
 * Is this graph already normalized? Used to avoid marking a freshly loaded
 * workflow dirty when nothing actually needed moving.
 */
export function positionsAreNormalized(nodes: PositionedNode[]): boolean {
  if (!Array.isArray(nodes) || nodes.length === 0) return true;
  const normalized = normalizeGraphPositions(nodes);
  return nodes.every((n, i) => {
    const m = normalized[i]!;
    return n.position?.x === m.position.x && n.position?.y === m.position.y;
  });
}

/** Would adding source→target create a cycle? True if target can already reach source. */
export function createsCycle(source: string, target: string, edges: GraphEdge[]): boolean {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    adj.get(e.source)!.push(e.target);
  }
  const seen = new Set<string>();
  const stack = [target];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === source) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const nxt of adj.get(cur) ?? []) stack.push(nxt);
  }
  return false;
}
