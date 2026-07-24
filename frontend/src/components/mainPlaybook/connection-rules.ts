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
