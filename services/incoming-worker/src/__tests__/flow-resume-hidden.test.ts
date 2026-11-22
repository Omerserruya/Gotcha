/**
 * A flow timer that fires on a conversation hidden since it was set resumes nothing (2026-11-22).
 * The label is read when the timer fires.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ hidden: false, processor: null as any, calls: [] as string[] }));

vi.mock("@chatcenter/shared", () => ({
  prisma: { conversation: { findFirst: async () => ({ chatbotNodeId: "n1", automationRunId: null, status: "OPEN" }) } },
  createWorker: (_q: string, fn: any) => { H.processor = fn; return {}; },
}));
vi.mock("@chatcenter/shared/src/lib/relevance-hidden", () => ({
  isConversationHidden: vi.fn(async () => H.hidden),
  logHiddenSkip: vi.fn(),
}));
vi.mock("../services/flow-executor.service", () => ({
  executeMainFlow: vi.fn(async () => { H.calls.push("main"); }),
  executeSubFlow: vi.fn(async () => { H.calls.push("sub"); }),
}));
vi.mock("../services/automation-runner.service", () => ({ resumeAutomationRun: vi.fn(async () => { H.calls.push("run"); }) }));

import { startFlowResumeWorker } from "../workers/flow-resume.worker";
import { isConversationHidden } from "@chatcenter/shared/src/lib/relevance-hidden";

startFlowResumeWorker();
const job = (o: any = {}) => ({ data: { tenantId: "t1", conversationId: "c1", flowKind: "main", flowId: null, resumeNodeId: "n1", channel: "whatsapp", message: "", ...o } });

beforeEach(() => { H.hidden = false; H.calls = []; });

describe("flow-resume on a hidden conversation", () => {
  it("hidden: no flow, no sub-flow, no automation run resumes", async () => {
    H.hidden = true;
    await H.processor(job());
    await H.processor(job({ flowKind: "sub", flowId: "f1" }));
    await H.processor(job({ automationRunId: "r1", resumeNodeId: null }));
    expect(H.calls).toEqual([]);
    expect(isConversationHidden).toHaveBeenCalledWith("t1", "c1", expect.anything());
  });

  it("not hidden: resumes as before", async () => {
    await H.processor(job());
    await H.processor(job({ flowKind: "sub", flowId: "f1" }));
    await H.processor(job({ automationRunId: "r1", resumeNodeId: null }));
    expect(H.calls).toEqual(["main", "sub", "run"]);
  });
});
