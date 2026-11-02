/**
 * "Who answers a new conversation" as an automation (2026-10-22).
 *
 * The playbook canvas used to decide which AI employee answers a new
 * conversation on each channel. That decision is now an automation:
 * trigger_type "conversation_started", trigger_config { channels }, and a
 * "hand to AI" step. The same shape is written by the website widget's
 * "who answers" setting and by the playbook migration, so it lives here once.
 *
 * Precedence (incoming-worker routingFallbackLast): a channel's own automation
 * beats one with no channels, which beats nothing.
 */

export const ROUTING_TRIGGER = "conversation_started";

export interface FlowNode { id: string; type: string; data?: any; position?: { x: number; y: number } }
export interface FlowEdge { id: string; source: string; target: string; sourceHandle?: string | null }

/** trigger -> hand to AI, the simplest route. */
export function buildRoutingGraph(aiAgentId: string): { nodes: FlowNode[]; edges: FlowEdge[] } {
  return {
    nodes: [
      { id: "trigger", type: "automation_trigger", position: { x: 0, y: 0 }, data: {} },
      { id: "hand_to_ai", type: "hand_to_ai", position: { x: 0, y: 160 }, data: { aiAgentId } },
    ],
    edges: [{ id: "e-trigger-hand_to_ai", source: "trigger", target: "hand_to_ai" }],
  };
}

/**
 * The hand-to-AI step a routing automation always reaches, or null when the
 * automation branches, does something else first, or never hands over. Only a
 * straight line trigger -> hand_to_ai is something a one-field setting (the
 * widget's "who answers") may rewrite.
 */
export function straightRouteStep(nodes: FlowNode[], edges: FlowEdge[]): FlowNode | null {
  const trigger = nodes.find((n) => n?.type === "automation_trigger");
  if (!trigger) return null;
  const out = edges.filter((e) => e?.source === trigger.id);
  if (out.length !== 1) return null;
  const next = nodes.find((n) => n?.id === out[0]!.target);
  if (!next || next.type !== "hand_to_ai") return null;
  if (edges.some((e) => e?.source === next.id)) return null;
  return next;
}

/** Channels a routing automation's trigger names; empty means every channel. */
export function routingChannels(triggerConfig: unknown): string[] {
  const ch = (triggerConfig as any)?.channels;
  return Array.isArray(ch) ? ch.map((c: unknown) => String(c).toUpperCase()) : [];
}

/**
 * The setup route (2026-11-02): the routing automation onboarding writes, so
 * "who answers" is an automation the owner can see and edit, not a hidden
 * playbook. Marked in triggerConfig.origin, a machine value; the UI owns the
 * words. It cannot be deleted (pausing is allowed) and it does not count
 * toward the plan's automation limit.
 */
export const SETUP_ORIGIN = "setup";
export const SETUP_ROUTE_NAME = "Who answers new conversations";

export function isSetupRoute(triggerConfig: unknown): boolean {
  return (triggerConfig as any)?.origin === SETUP_ORIGIN;
}

/** The setup route's trigger config: every channel, marked. */
export function setupTriggerConfig(): { channels: string[]; origin: string } {
  return { channels: [], origin: SETUP_ORIGIN };
}
