/**
 * flow-resume worker - picks up delayed-resume jobs enqueued by the graph
 * walker (e.g. when a Wait node schedules a resume N seconds later) and calls
 * back into the flow executor with the stored resumeNodeId.
 *
 * The walker halts synchronously on Wait and returns; when BullMQ fires this
 * job later, we re-enter the same flow scope (main canvas or sub-flow row)
 * and resume from the next node.
 */

import type { Job } from "bullmq";
import type { FlowResumeJob } from "@chatcenter/shared";
import { createWorker, prisma } from "@chatcenter/shared";
import { executeMainFlow, executeSubFlow } from "../services/flow-executor.service";
import { resumeAutomationRun } from "../services/automation-runner.service";

/**
 * Is the conversation still parked where this timer was set? A timer whose
 * cursor has moved on (a reply came first, the flow ended, the conversation
 * closed, a newer run took over) is stale and must not walk the flow again -
 * that is what ran the rest of a flow twice after a Wait.
 */
export function timerIsCurrent(
  job: Pick<FlowResumeJob, "resumeNodeId" | "automationRunId">,
  conv: { chatbotNodeId: string | null; automationRunId: string | null; status: string } | null,
): boolean {
  if (!conv || conv.status === "CLOSED") return false;
  if (conv.chatbotNodeId !== job.resumeNodeId) return false;
  if (job.automationRunId && conv.automationRunId !== job.automationRunId) return false;
  return true;
}

async function processFlowResume(job: Job<FlowResumeJob>): Promise<void> {
  const { tenantId, conversationId, flowKind, flowId, resumeNodeId, channel, message, automationRunId, timeout } = job.data;

  console.log(
    `[flow-resume] tenant=${tenantId} conv=${conversationId} kind=${flowKind} flow=${flowId ?? "-"} node=${resumeNodeId}` +
      (automationRunId ? ` run=${automationRunId}${timeout ? " timeout" : ""}` : ""),
  );

  // A scheduled-message flow start carries no cursor; everything else is a
  // timer that must still be current.
  if (resumeNodeId) {
    const conv = await prisma.conversation.findFirst({
      where: { id: conversationId, tenantId },
      select: { chatbotNodeId: true, automationRunId: true, status: true },
    });
    if (!timerIsCurrent(job.data, conv as any)) {
      console.log(`[flow-resume] stale timer for node ${resumeNodeId}; the conversation moved on`);
      return;
    }
  }

  if (automationRunId) {
    await resumeAutomationRun({ tenantId, conversationId, runId: automationRunId, message, channel, fromTimer: true, timeout: !!timeout });
    return;
  }
  if (flowKind === "sub") {
    if (!flowId) {
      console.warn("[flow-resume] sub job missing flowId; dropping");
      return;
    }
    await executeSubFlow({ tenantId, conversationId, message, channel, flowId, resumeNodeId, fromTimer: true });
  } else {
    await executeMainFlow({ tenantId, conversationId, message, channel, resumeNodeId, fromTimer: true });
  }
}

export function startFlowResumeWorker() {
  return createWorker<FlowResumeJob>("flow-resume", processFlowResume, 5);
}
