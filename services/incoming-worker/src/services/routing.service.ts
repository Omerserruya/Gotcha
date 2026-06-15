/**
 * Routing service - graph-walker only (Phase 3).
 *
 * The Main Playbook flow canvas is the single source of truth. Every brand-new
 * inbound conversation is routed through `executeMainFlow`; the graph decides
 * everything (AI agent, sub-flow, department, human, end). When the graph
 * doesn't execute (no canvas, no trigger matched), the conversation simply
 * sits in the inbox unassigned (`handledBy: null`) for a human to pick up.
 *
 * The previous list-based RouterRule evaluator + tenant fallback ladder
 * (default agent → routine → department → unassigned) lived here. They were
 * removed: the graph IS the flow.
 *
 * Resume of in-flight conversations is handled upstream in the worker
 * (`incoming.worker.ts`) via the `chatbotNodeId` branch - this service only
 * makes the *initial* routing decision.
 */
import { prisma, analyticsQueue, publishEvent } from "@chatcenter/shared";
import { executeMainFlow } from "./flow-executor.service";

// ─── Types ───────────────────────────────────────────────────

export interface RoutingResult {
  departmentId: string | null;
  assignedAgentId: string | null;
  handledByAI: boolean;
  intent: string;
  matchedRule: string | null;
  trace: RoutingTraceEntry[];
}

export interface RoutingTraceEntry {
  ruleId: string;
  name: string;
  isDefault: boolean;
  matched: boolean;
  condResults: { type: string; operator?: string; value: string; result: boolean }[];
  stopped?: true;
}

// ─── Live routing - graph-walker only ───────────────────────

export async function routeConversation(
  tenantId: string,
  conversationId: string,
  message: string,
  channel?: string,
): Promise<RoutingResult> {
  const chan = (channel || "whatsapp").toLowerCase();

  const graph = await executeMainFlow({ tenantId, conversationId, message, channel: chan });

  const result: RoutingResult = {
    departmentId:
      graph.executed && graph.route?.routeType === "DEPARTMENT"
        ? graph.route.targetId ?? null
        : null,
    assignedAgentId: null,
    handledByAI:
      graph.executed
      && (graph.route?.routeType === "AI_AGENT" || graph.route?.routeType === "FLOW"),
    intent: "",
    matchedRule: graph.executed ? graph.matchedNodeId ?? null : null,
    trace: graph.executed
      ? graph.trace.map((t) => ({
          ruleId: t.nodeId,
          name: t.type,
          isDefault: false,
          matched: t.action !== "no_match" && t.action !== "skip_unknown",
          condResults: [],
        }))
      : [],
  };

  console.log(
    `[routing] conversation=${conversationId} executed=${graph.executed} `
    + `route=${graph.route?.routeType ?? "-"} target=${graph.route?.targetId ?? "-"} `
    + `end=${graph.endKind ?? "-"} reason=${graph.reason ?? "-"}`,
  );

  await publishEvent({
    event: "conversation:updated",
    tenantId,
    data: { id: conversationId, departmentId: result.departmentId, assignedAgentId: null },
  });

  await analyticsQueue.add("routing-applied", {
    tenantId,
    event: "conversation_routed",
    data: {
      conversationId,
      intent: result.intent,
      departmentId: result.departmentId,
      assignedAgentId: null,
      handledByAI: result.handledByAI,
      matchedRule: result.matchedRule,
      source: graph.executed ? "flow_canvas" : "unmatched_inbox",
    },
    timestamp: new Date().toISOString(),
  });

  return result;
}
