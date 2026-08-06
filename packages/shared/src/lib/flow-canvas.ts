/**
 * What counts as a real, running process on the flow canvas.
 *
 * The Getting Started journey used to answer "has this tenant built a process?"
 * with `chatbotFlow.count() > 0`. That is a different, legacy store: the
 * builder saves to FlowCanvas, and FlowCanvas is what
 * incoming-worker/flow-executor.service.ts reads to execute a flow. So a
 * customer could build and save a process and watch the milestone stay empty
 * forever, because nothing ever wrote the table being counted.
 *
 * The other half of the question is what "built" means. A canvas holding one
 * trigger and nothing else is not a process - the executor finds the entry,
 * follows no edge, and does nothing. Counting it done would tell a customer
 * their automation is live while no message would ever be answered. So the bar
 * is a trigger with somewhere to go.
 */

/** Entry node types that the executor can start a run from. */
export const FLOW_TRIGGER_TYPES = new Set([
  "channel_entry",
  "start",
  "keyword_trigger",
  "comment_trigger",
  "schedule_trigger",
  "webhook_trigger",
]);

/** Voice triggers are namespaced (`voice_trigger:call.incoming`, …). */
export function isFlowTrigger(type: unknown): boolean {
  const t = String(type ?? "");
  return FLOW_TRIGGER_TYPES.has(t) || t.startsWith("voice_trigger:");
}

interface CanvasNode { id?: unknown; type?: unknown }
interface CanvasEdge { source?: unknown; target?: unknown }

/**
 * True when the canvas holds at least one trigger that leads somewhere: an
 * edge from the trigger to a node that exists and is not itself a trigger.
 *
 * Tolerant of whatever shape the JSON columns actually hold - this reads
 * untyped Json straight out of Prisma, and a malformed canvas must answer
 * "not a process", never throw inside the journey endpoint.
 */
export function canvasHasRunnableProcess(nodes: unknown, edges: unknown): boolean {
  if (!Array.isArray(nodes) || !Array.isArray(edges)) return false;

  const byId = new Map<string, CanvasNode>();
  for (const n of nodes as CanvasNode[]) {
    const id = n && typeof n === "object" ? String((n as any).id ?? "") : "";
    if (id) byId.set(id, n);
  }

  const triggers = new Set<string>();
  for (const [id, n] of Array.from(byId.entries())) {
    if (isFlowTrigger((n as any).type)) triggers.add(id);
  }
  if (triggers.size === 0) return false;

  for (const e of edges as CanvasEdge[]) {
    if (!e || typeof e !== "object") continue;
    const source = String((e as any).source ?? "");
    const target = String((e as any).target ?? "");
    if (!triggers.has(source)) continue;
    const downstream = byId.get(target);
    // The edge must land on a node that is still on the canvas and does
    // something - an edge into another trigger is not a step.
    if (downstream && !isFlowTrigger((downstream as any).type)) return true;
  }
  return false;
}
