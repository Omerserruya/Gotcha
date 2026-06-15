import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the shared package: the dispatcher only needs prisma.tenant for the
// active-tenant gate, plus createWorker (referenced by startIncomingWorker, not
// under test here). Everything else the module imports stays real but unused.
// `vi.hoisted` exposes these mocks to the hoisted vi.mock factories below.
const { tenant, executeWebhookFlow } = vi.hoisted(() => ({
  tenant: { findUnique: vi.fn() },
  executeWebhookFlow: vi.fn(),
}));
vi.mock("@chatcenter/shared", () => ({
  prisma: { tenant, message: { findFirst: vi.fn() } },
  createWorker: vi.fn(),
  analyticsQueue: { add: vi.fn() },
  outgoingMessageQueue: { add: vi.fn() },
  publishEvent: vi.fn().mockResolvedValue(undefined),
  decryptCredentials: vi.fn(),
  resolveContactByChannelId: vi.fn(),
}));

// Sibling handlers the dispatcher can route to - stub so we can assert routing
// without executing the heavy message / flow paths.
vi.mock("../services/comment-trigger.service", () => ({
  processCommentTrigger: vi.fn(),
}));
vi.mock("../services/flow-executor.service", () => ({ executeWebhookFlow }));

import { dispatch } from "../workers/incoming.worker";

const WEBHOOK_JOB = {
  name: "webhook-trigger",
  data: { triggerId: "tr1", workflowId: "w1", tenantId: "t1", payload: { order_id: 7 } },
} as any;

describe("incoming worker dispatch - webhook-trigger routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeWebhookFlow.mockResolvedValue({ executed: true, halted: true, trace: [] });
  });

  it("runs the linked flow for an active tenant, forwarding the payload (defaults to flow mode)", async () => {
    tenant.findUnique.mockResolvedValue({ status: "ACTIVE" });

    await dispatch(WEBHOOK_JOB);

    expect(executeWebhookFlow).toHaveBeenCalledWith({
      tenantId: "t1",
      workflowId: "w1",
      payload: { order_id: 7 },
      targetMode: "flow",
    });
  });

  it("forwards connected target mode to the executor", async () => {
    tenant.findUnique.mockResolvedValue({ status: "ACTIVE" });

    await dispatch({
      name: "webhook-trigger",
      data: { triggerId: "tr2", workflowId: "w2", tenantId: "t1", payload: { a: 1 }, targetMode: "connected" },
    } as any);

    expect(executeWebhookFlow).toHaveBeenCalledWith({
      tenantId: "t1",
      workflowId: "w2",
      payload: { a: 1 },
      targetMode: "connected",
    });
  });

  it("skips the flow run for a non-active tenant", async () => {
    tenant.findUnique.mockResolvedValue({ status: "SUSPENDED" });

    await dispatch(WEBHOOK_JOB);

    expect(executeWebhookFlow).not.toHaveBeenCalled();
  });

  it("does not route non-webhook jobs to the flow runner", async () => {
    tenant.findUnique.mockResolvedValue({ status: "ACTIVE" });

    // A comment job must not reach executeWebhookFlow.
    await dispatch({ name: "process-comment", data: {} } as any);

    expect(executeWebhookFlow).not.toHaveBeenCalled();
  });
});
