/**
 * P1-3 (B6) — the kernel approval gate's approval-RESUME path. When the
 * dispatcher re-enters the Runtime with a matching APPROVED request, the gate
 * treats it as satisfied (no re-ask); a stale/mismatched ref fails loud.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  findFirst: vi.fn(),
  evaluatePolicies: vi.fn(),
  createApprovalRequest: vi.fn(),
  findPendingByConversation: vi.fn(),
}));

vi.mock("@chatcenter/shared", () => ({
  prisma: { approvalRequest: { findFirst: h.findFirst } },
  evaluatePolicies: h.evaluatePolicies,
  createApprovalRequest: h.createApprovalRequest,
  findPendingByConversation: h.findPendingByConversation,
}));

import { kernelApprovalGate } from "../services/capability-runtime/approval-gate";

const contract = { id: "BOOK_MEETING", meaning: "book a meeting" } as any;
const baseReq = (extra: any = {}) => ({
  operation: "BOOK_MEETING",
  params: { desired_time: "t" },
  context: { tenantId: "t1", conversationId: "c1", aiAgentId: "a1" },
  mode: "autonomous",
  ...extra,
});
const map = { policyTool: "schedule_meeting", args: {} };

beforeEach(() => {
  Object.values(h).forEach((fn) => fn.mockReset());
});

describe("kernelApprovalGate — approval resume", () => {
  it("APPROVED ref matching tool+conversation → gate satisfied (required:false), policy NOT re-evaluated", async () => {
    h.findFirst.mockResolvedValue({ status: "APPROVED", tool: "schedule_meeting", conversationId: "c1" });
    const out = await kernelApprovalGate(contract, baseReq({ approval: { approvedRef: "ap1" } }), map);
    expect(out).toEqual({ required: false });
    expect(h.evaluatePolicies).not.toHaveBeenCalled();
  });

  it("stale ref (still PENDING) → throws, never silently allows or re-asks", async () => {
    h.findFirst.mockResolvedValue({ status: "PENDING", tool: "schedule_meeting", conversationId: "c1" });
    await expect(kernelApprovalGate(contract, baseReq({ approval: { approvedRef: "ap1" } }), map))
      .rejects.toThrow(/approval_resume_ref_invalid/);
  });

  it("ref for a DIFFERENT tool → throws (no cross-tool reuse)", async () => {
    h.findFirst.mockResolvedValue({ status: "APPROVED", tool: "cancel_order", conversationId: "c1" });
    await expect(kernelApprovalGate(contract, baseReq({ approval: { approvedRef: "ap1" } }), map))
      .rejects.toThrow(/approval_resume_ref_invalid/);
  });

  it("no approval ref + REQUIRE_APPROVAL → creates a request carrying the kernel resume envelope", async () => {
    h.evaluatePolicies.mockResolvedValue({ decision: "REQUIRE_APPROVAL", reason: "duration>60", approvalConfig: {} });
    h.findPendingByConversation.mockResolvedValue([]);
    h.createApprovalRequest.mockResolvedValue({ id: "new1" });
    const out = await kernelApprovalGate(contract, baseReq(), map);
    expect(out).toEqual({ required: true, ref: "new1" });
    const arg = h.createApprovalRequest.mock.calls[0][0];
    expect(arg.resumeEnvelope).toMatchObject({ kind: "kernel_operation", operation: "BOOK_MEETING" });
  });

  it("probe (dry_run) → reports required without creating a request", async () => {
    h.evaluatePolicies.mockResolvedValue({ decision: "REQUIRE_APPROVAL", reason: "duration>60", approvalConfig: {} });
    const out = await kernelApprovalGate(contract, baseReq(), map, { probe: true });
    expect(out).toEqual({ required: true, ref: "dry_run_probe" });
    expect(h.createApprovalRequest).not.toHaveBeenCalled();
  });
});
