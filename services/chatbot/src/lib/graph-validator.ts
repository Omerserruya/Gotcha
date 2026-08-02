/**
 * Authoritative graph validation (§3).
 *
 * The frontend validates for UX (connection-rules.ts + flow-validator.ts);
 * THIS is the source of truth that gates publish/activate and can never be
 * bypassed by a crafted request. It cannot import the React node registry, so
 * it carries its own minimal, stable node TOPOLOGY (which types are entries,
 * which are terminal, which required config each needs). Keep this consistent
 * with the frontend registry; the two are asserted against each other in tests.
 */

export type IssueSeverity = "error" | "warning";
export interface GraphIssue { severity: IssueSeverity; code: string; nodeId?: string; message: string; }

interface GNode { id: string; type: string; data?: any; }
interface GEdge { id?: string; source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null; }

// Nodes with no input port - legitimate flow entries.
const ENTRY_TYPES = new Set([
  "channel_entry", "start", "keyword_trigger", "comment_trigger", "schedule_trigger",
]);
// Nodes with no output port - they terminate a branch.
const TERMINAL_TYPES = new Set(["end", "route_target", "default_fallback"]);
// Branch nodes whose exits are labelled (true/false) rather than a single flow.
const BRANCH_TYPES = new Set(["condition_group"]);
// Static nodes that may appear AT MOST ONCE in a process (duplicates are a
// modelling error - two starts / two default fallbacks are ambiguous).
const SINGLETON_TYPES = new Set(["start", "default_fallback"]);

function hasInput(type: string): boolean { return !ENTRY_TYPES.has(type); }
function hasOutput(type: string): boolean { return !TERMINAL_TYPES.has(type); }

/** Required-config rules (mirror of the frontend per-node checks). */
function missingConfig(n: GNode): { key: string; label: string }[] {
  const d = n.data || {};
  const empty = (v: unknown) => v == null || (typeof v === "string" && !v.trim());
  const out: { key: string; label: string }[] = [];
  switch (n.type) {
    case "send_message_text": if (empty(d.text)) out.push({ key: "text", label: "message text" }); break;
    case "send_message_image":
    case "send_message_file": if (empty(d.url)) out.push({ key: "url", label: "file URL" }); break;
    case "route_target": if (empty(d.targetId)) out.push({ key: "targetId", label: "route target" }); break;
    case "collect_input":
      if (empty(d.prompt)) out.push({ key: "prompt", label: "prompt" });
      if (empty(d.variable)) out.push({ key: "variable", label: "variable name" });
      break;
    case "set_variable": if (empty(d.variable)) out.push({ key: "variable", label: "variable name" }); break;
    case "http_request": if (empty(d.url)) out.push({ key: "url", label: "URL" }); break;
    case "ai_generate": if (empty(d.prompt)) out.push({ key: "prompt", label: "prompt" }); break;
    // `wait` delay validity is handled separately (invalid_delay) so a bad
    // duration is a precise error rather than a generic missing-config one.
  }
  return out;
}

function reachableFrom(starts: string[], edges: GEdge[]): Set<string> {
  const adj = new Map<string, string[]>();
  for (const e of edges) { (adj.get(e.source) ?? adj.set(e.source, []).get(e.source)!).push(e.target); }
  const seen = new Set<string>(starts);
  const stack = [...starts];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const nxt of adj.get(cur) ?? []) if (!seen.has(nxt)) { seen.add(nxt); stack.push(nxt); }
  }
  return seen;
}

function hasCycle(nodes: GNode[], edges: GEdge[]): boolean {
  const adj = new Map<string, string[]>();
  for (const e of edges) { (adj.get(e.source) ?? adj.set(e.source, []).get(e.source)!).push(e.target); }
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>(nodes.map((n) => [n.id, WHITE]));
  const dfs = (u: string): boolean => {
    color.set(u, GRAY);
    for (const v of adj.get(u) ?? []) {
      const c = color.get(v) ?? WHITE;
      if (c === GRAY) return true;
      if (c === WHITE && dfs(v)) return true;
    }
    color.set(u, BLACK);
    return false;
  };
  for (const n of nodes) if ((color.get(n.id) ?? WHITE) === WHITE && dfs(n.id)) return true;
  return false;
}

/**
 * Validate an entire process graph. `errors` block publish/activate; `warnings`
 * do not. Deterministic and side-effect free.
 */
export function validateGraph(nodes: GNode[], edges: GEdge[]): { errors: GraphIssue[]; warnings: GraphIssue[] } {
  const errors: GraphIssue[] = [];
  const warnings: GraphIssue[] = [];
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return { errors: [{ severity: "error", code: "empty", message: "The process has no steps." }], warnings };
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // 1. A valid start node.
  const entries = nodes.filter((n) => ENTRY_TYPES.has(n.type));
  if (entries.length === 0) {
    errors.push({ severity: "error", code: "no_start", message: "The process needs a start/entry step." });
  }

  // 2. Edge integrity + port rules.
  const inCount = new Map<string, number>();
  for (const e of edges) {
    const s = byId.get(e.source); const t = byId.get(e.target);
    // Deleted node left a broken edge.
    if (!s || !t) { errors.push({ severity: "error", code: "broken_edge", message: "An edge points at a deleted step." }); continue; }
    if (e.source === e.target) errors.push({ severity: "error", code: "self_loop", nodeId: e.source, message: "A step connects to itself." });
    if (!hasInput(t.type)) errors.push({ severity: "error", code: "no_input", nodeId: t.id, message: "A connection targets a start step, which has no input." });
    if (!hasOutput(s.type)) errors.push({ severity: "error", code: "no_output", nodeId: s.id, message: "A terminal step has an outgoing connection." });
    inCount.set(e.target, (inCount.get(e.target) ?? 0) + 1);
  }
  // 3. Single-input: non-branch, non-entry nodes accept ONE incoming edge.
  for (const [nodeId, c] of inCount) {
    const n = byId.get(nodeId);
    if (n && c > 1 && !BRANCH_TYPES.has(n.type)) {
      warnings.push({ severity: "warning", code: "multi_input", nodeId, message: "A step has multiple incoming connections; only the first path is guaranteed." });
    }
  }

  // 4. Reachability - every non-entry step reachable from an entry.
  const reach = reachableFrom(entries.map((n) => n.id), edges);
  for (const n of nodes) {
    if (ENTRY_TYPES.has(n.type)) continue;
    if (!reach.has(n.id)) warnings.push({ severity: "warning", code: "unreachable", nodeId: n.id, message: "This step is never reached." });
  }

  // 5. A reachable terminal/completion path.
  const hasReachableTerminal = nodes.some((n) => (TERMINAL_TYPES.has(n.type) && reach.has(n.id)));
  const hasRouteExit = nodes.some((n) => n.type === "route_target" && reach.has(n.id));
  if (entries.length > 0 && !hasReachableTerminal && !hasRouteExit) {
    warnings.push({ severity: "warning", code: "no_terminal", message: "No reachable end or route step - the process never completes." });
  }

  // 6. Cycles (control flow must be a DAG).
  if (hasCycle(nodes, edges)) errors.push({ severity: "error", code: "cycle", message: "The process contains a loop; it must flow forward." });

  // 7. Required config.
  for (const n of nodes) {
    for (const m of missingConfig(n)) {
      errors.push({ severity: "error", code: "missing_config", nodeId: n.id, message: `A ${n.type.replace(/_/g, " ")} step is missing its ${m.label}.` });
    }
  }

  // 8. Duplicate singleton static nodes (e.g. two starts).
  const singletonCounts = new Map<string, number>();
  for (const n of nodes) {
    if (SINGLETON_TYPES.has(n.type)) singletonCounts.set(n.type, (singletonCounts.get(n.type) ?? 0) + 1);
  }
  for (const [type, c] of singletonCounts) {
    if (c > 1) errors.push({ severity: "error", code: "duplicate_entry", message: `The process has ${c} "${type.replace(/_/g, " ")}" steps; only one is allowed.` });
  }

  // 9. Delay/time validity: a `wait` duration, when present, must be a finite
  // positive number of ms. A `wait` with no duration set defaults (warning).
  const outAdj = new Map<string, number>();
  for (const e of edges) outAdj.set(e.source, (outAdj.get(e.source) ?? 0) + 1);
  for (const n of nodes) {
    if (n.type !== "wait") continue;
    const dur = (n.data || {}).durationMs;
    if (dur == null) {
      warnings.push({ severity: "warning", code: "invalid_delay", nodeId: n.id, message: "A wait step has no delay set; it will not pause." });
    } else if (typeof dur !== "number" || !Number.isFinite(dur) || dur <= 0) {
      errors.push({ severity: "error", code: "invalid_delay", nodeId: n.id, message: "A wait step has an invalid delay; it must be a positive duration." });
    }
  }

  // 10. Branch completeness: a REACHABLE condition/branch node should connect
  // both of its exits. One (or zero) connected branch means a path falls
  // through - a soft issue (warning), not a publish blocker.
  for (const n of nodes) {
    if (!BRANCH_TYPES.has(n.type) || !reach.has(n.id)) continue;
    const outCount = outAdj.get(n.id) ?? 0;
    if (outCount < 2) {
      warnings.push({ severity: "warning", code: "branch_incomplete", nodeId: n.id, message: "A condition step has an unconnected branch; that path falls through." });
    }
  }

  return { errors, warnings };
}
