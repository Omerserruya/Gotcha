/**
 * Business-operation dedup for HITL approvals.
 *
 * Live incident: two ApprovalRequest rows both meaning "refund order #1004"
 * each won their own row-level notification claim - the customer was told
 * twice. These tests lock the operation-key model: same operation → same key,
 * an OPEN sibling absorbs a duplicate creation, and a notified sibling
 * silences every other row of the same operation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  approvalRequest: {
    create: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
}));

vi.mock("../lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("../lib/event-bus", () => ({ publishEvent: vi.fn(async () => {}) }));

import {
  computeOperationKey,
  createApprovalRequest,
  claimCustomerNotification,
} from "../lib/approval-requests";

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.approvalRequest.findFirst.mockResolvedValue(null);
  prismaMock.approvalRequest.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.approvalRequest.create.mockResolvedValue({
    id: "apv_new", expiresAt: new Date(), conversationId: "c1", tool: "t",
    summary: "s", riskLevel: "high", requestedBy: "bot", createdAt: new Date(),
  });
});

describe("computeOperationKey", () => {
  it("names the same business operation identically across cosmetic differences", () => {
    const a = computeOperationKey("shopify.cancel_order", { order_name: "#1004", reason: "customer" });
    const b = computeOperationKey("shopify.cancel_order", { order_name: "1004", reason: "fraud", restock: true });
    expect(a).toBe(b);
  });

  it("different orders are different operations", () => {
    expect(computeOperationKey("shopify.cancel_order", { order_name: "#1004" }))
      .not.toBe(computeOperationKey("shopify.cancel_order", { order_name: "#1005" }));
  });

  it("different tools on the same order are different operations", () => {
    expect(computeOperationKey("shopify.cancel_order", { order_name: "#1004" }))
      .not.toBe(computeOperationKey("shopify.process_refund", { order_name: "#1004" }));
  });

  it("unknown tools fall back to a deterministic full-params hash", () => {
    const a = computeOperationKey("acme.frob", { b: 2, a: 1 });
    const b = computeOperationKey("acme.frob", { a: 1, b: 2 });
    expect(a).toBe(b);
    expect(a).not.toBe(computeOperationKey("acme.frob", { a: 1, b: 3 }));
  });
});

describe("createApprovalRequest dedup", () => {
  it("returns the OPEN sibling instead of creating a duplicate", async () => {
    prismaMock.approvalRequest.findFirst.mockResolvedValue({ id: "apv_open", expiresAt: new Date(9999999999999) });
    const r = await createApprovalRequest({
      tenantId: "t1", tool: "shopify.process_refund",
      params: { order_name: "#1004" }, summary: "s", reason: "r", requestedBy: "bot",
    });
    expect(r.id).toBe("apv_open");
    expect(r.deduped).toBe(true);
    expect(prismaMock.approvalRequest.create).not.toHaveBeenCalled();
  });

  it("creates normally when no open sibling exists, storing the operation key", async () => {
    const r = await createApprovalRequest({
      tenantId: "t1", tool: "shopify.process_refund",
      params: { order_name: "#1004" }, summary: "s", reason: "r", requestedBy: "bot",
    });
    expect(r.deduped).toBeUndefined();
    const data = prismaMock.approvalRequest.create.mock.calls[0][0].data;
    expect(data.operationKey).toBe(computeOperationKey("shopify.process_refund", { order_name: "#1004" }));
  });

  it("a FAILED/rejected/expired sibling does NOT block a fresh attempt", async () => {
    // The dedup query itself excludes dead-end rows; here findFirst returning
    // null models exactly that - and creation must proceed.
    prismaMock.approvalRequest.findFirst.mockResolvedValue(null);
    const r = await createApprovalRequest({
      tenantId: "t1", tool: "shopify.cancel_order",
      params: { order_name: "#1004" }, summary: "s", reason: "r", requestedBy: "bot",
    });
    expect(r.deduped).toBeUndefined();
    expect(prismaMock.approvalRequest.create).toHaveBeenCalled();
    // and the dedup query is explicit about which states block
    const where = prismaMock.approvalRequest.findFirst.mock.calls[0][0].where;
    expect(JSON.stringify(where)).toContain("PENDING");
    expect(JSON.stringify(where)).not.toContain("FAILED");
  });
});

describe("claimCustomerNotification operation-level guard", () => {
  it("refuses when a SIBLING row of the same operation already notified", async () => {
    prismaMock.approvalRequest.findFirst
      .mockResolvedValueOnce({ operationKey: "shopify.process_refund:order_id=&order_name=1004" }) // this row
      .mockResolvedValueOnce({ id: "apv_sibling" }); // notified sibling
    const ok = await claimCustomerNotification("t1", "apv_2");
    expect(ok).toBe(false);
    expect(prismaMock.approvalRequest.updateMany).not.toHaveBeenCalled();
  });

  it("claims normally when no sibling notified (row CAS still applies)", async () => {
    prismaMock.approvalRequest.findFirst
      .mockResolvedValueOnce({ operationKey: "k1" })
      .mockResolvedValueOnce(null);
    const ok = await claimCustomerNotification("t1", "apv_2");
    expect(ok).toBe(true);
    const where = prismaMock.approvalRequest.updateMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ tenantId: "t1", id: "apv_2", executionState: "SUCCEEDED", customerNotifiedAt: null });
  });

  it("rows without an operation key keep the plain row-level behavior", async () => {
    prismaMock.approvalRequest.findFirst.mockResolvedValueOnce({ operationKey: null });
    const ok = await claimCustomerNotification("t1", "apv_legacy");
    expect(ok).toBe(true);
    expect(prismaMock.approvalRequest.updateMany).toHaveBeenCalled();
  });
});
