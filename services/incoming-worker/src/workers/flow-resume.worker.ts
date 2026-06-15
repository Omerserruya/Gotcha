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
import { createWorker } from "@chatcenter/shared";
import { executeMainFlow, executeSubFlow } from "../services/flow-executor.service";

async function processFlowResume(job: Job<FlowResumeJob>): Promise<void> {
  const { tenantId, conversationId, flowKind, flowId, resumeNodeId, channel, message } = job.data;

  console.log(
    `[flow-resume] tenant=${tenantId} conv=${conversationId} kind=${flowKind} flow=${flowId ?? "-"} node=${resumeNodeId}`,
  );

  if (flowKind === "sub") {
    if (!flowId) {
      console.warn("[flow-resume] sub job missing flowId; dropping");
      return;
    }
    await executeSubFlow({ tenantId, conversationId, message, channel, flowId, resumeNodeId });
  } else {
    await executeMainFlow({ tenantId, conversationId, message, channel, resumeNodeId });
  }
}

export function startFlowResumeWorker() {
  return createWorker<FlowResumeJob>("flow-resume", processFlowResume, 5);
}
