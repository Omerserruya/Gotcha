import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock ONLY the production HITL helpers; keep the rest of shared real.
vi.mock("@chatcenter/shared", async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    evaluatePolicies: vi.fn(),
    createApprovalRequest: vi.fn(),
    findPendingByConversation: vi.fn(),
  };
});

import { evaluatePolicies, createApprovalRequest, findPendingByConversation } from "@chatcenter/shared";
import { CALENDAR_CONTRACTS } from "../services/capability-runtime/calendar.contracts";
import { kernelApprovalGate } from "../services/capability-runtime/approval-gate";
import type { ExecutionRequest } from "@chatcenter/shared";

const BOOK = CALENDAR_CONTRACTS.BOOK_MEETING;
const req = (params: Record<string, unknown> = {}): ExecutionRequest => ({
  operation: "BOOK_MEETING",
  params,
  context: { tenantId: "t1", conversationId: "c1", aiAgentId: "a1" },
  mode: "autonomous",
});

beforeEach(() => {
  vi.mocked(evaluatePolicies).mockReset();
  vi.mocked(createApprovalRequest).mockReset();
  vi.mocked(findPendingByConversation).mockReset();
});

describe("kernel approval gate — wraps the production HITL stack", () => {
  it("ALLOW → not required; nothing created", async () => {
    vi.mocked(evaluatePolicies).mockResolvedValue({ decision: "ALLOW", reason: "auto", snapshot: {} } as any);
    const v = await kernelApprovalGate(BOOK, req(), { policyTool: "schedule_meeting", args: { duration_minutes: 30 } });
    expect(v).toEqual({ required: false });
    expect(createApprovalRequest).not.toHaveBeenCalled();
    // the policy was consulted with the LEGACY tool name + concrete args
    expect(evaluatePolicies).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "t1", toolName: "schedule_meeting", args: { duration_minutes: 30 } }),
    );
  });

  it("REQUIRE_APPROVAL → creates the real ApprovalRequest and returns its id as ref", async () => {
    vi.mocked(evaluatePolicies).mockResolvedValue({ decision: "REQUIRE_APPROVAL", reason: "duration > 60", snapshot: {} } as any);
    vi.mocked(findPendingByConversation).mockResolvedValue([] as any);
    vi.mocked(createApprovalRequest).mockResolvedValue({ id: "apr_123", expiresAt: new Date() } as any);

    const v = await kernelApprovalGate(BOOK, req({ desired_time: "x" }), { policyTool: "schedule_meeting", args: { duration_minutes: 90 } });
    expect(v).toEqual({ required: true, ref: "apr_123" });
    expect(createApprovalRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "t1",
        conversationId: "c1",
        tool: "schedule_meeting",
        requestedBy: "agent-loop:a1",
      }),
    );
  });

  it("idempotent across turns: reuses a still-PENDING request for the same tool", async () => {
    vi.mocked(evaluatePolicies).mockResolvedValue({ decision: "REQUIRE_APPROVAL", reason: "always", snapshot: {} } as any);
    vi.mocked(findPendingByConversation).mockResolvedValue([{ id: "apr_old", tool: "schedule_meeting" }] as any);

    const v = await kernelApprovalGate(BOOK, req(), { policyTool: "schedule_meeting", args: {} });
    expect(v).toEqual({ required: true, ref: "apr_old" });
    expect(createApprovalRequest).not.toHaveBeenCalled();
  });

  it("DENY → throws (observable FAILED; never silently executes, never approves)", async () => {
    vi.mocked(evaluatePolicies).mockResolvedValue({ decision: "DENY", reason: "tool disabled at tenant level", snapshot: {} } as any);
    await expect(
      kernelApprovalGate(BOOK, req(), { policyTool: "schedule_meeting", args: {} }),
    ).rejects.toThrow(/policy_denied:tool disabled/);
    expect(createApprovalRequest).not.toHaveBeenCalled();
  });

  it("policy-evaluation failure propagates (never silently auto-execute)", async () => {
    vi.mocked(evaluatePolicies).mockRejectedValue(new Error("db down"));
    await expect(
      kernelApprovalGate(BOOK, req(), { policyTool: "schedule_meeting", args: {} }),
    ).rejects.toThrow(/db down/);
  });
});
