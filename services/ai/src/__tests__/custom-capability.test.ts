import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../services/connectors/custom-api.service", () => ({
  listCustomApiTools: vi.fn(),
  executeCustomApiTool: vi.fn(),
}));
vi.mock("../services/connectors/custom-db.service", () => ({
  listCustomDbQueryTools: vi.fn(),
  executeCustomDbQueryTool: vi.fn(),
}));

import { listCustomApiTools, executeCustomApiTool } from "../services/connectors/custom-api.service";
import { listCustomDbQueryTools } from "../services/connectors/custom-db.service";
import { CustomCapability } from "../services/capability-plane/custom.capability";
import type { ExecutionRequest, ExecutionMode } from "@chatcenter/shared";

const ORDER_TOOL = {
  id: "1", slug: "order_status", name: "Order status",
  description: "Look up an order's shipping status", whenToUse: "customer asks where their order is",
  whenNotToUse: "for refunds", method: "GET", urlTemplate: "https://api.shop.com/orders/{{order_id}}",
  parameters: { type: "object", properties: { order_id: { type: "string", description: "the order number" } }, required: ["order_id"] },
  category: "READ", riskLevel: "LOW",
};

const req = (operation: string, params: Record<string, unknown> = {}, mode: ExecutionMode = "autonomous"): ExecutionRequest => ({
  operation, params, context: { tenantId: "t1", conversationId: "c1" }, mode,
});

beforeEach(() => {
  vi.mocked(listCustomApiTools).mockResolvedValue([ORDER_TOOL] as any);
  vi.mocked(listCustomDbQueryTools).mockResolvedValue([] as any);
  vi.mocked(executeCustomApiTool).mockReset();
});

describe("CUSTOM operation set — tenant-defined tools as generic operations", () => {
  it("describeWorld exposes each tenant tool with its when-to-use meaning and schema params", async () => {
    const world = await CustomCapability.describeWorld({ tenantId: "t1", conversationId: "c1" });
    expect(world.operations).toHaveLength(1);
    const op = world.operations[0];
    expect(op.name).toBe("custom.order_status"); // exact legacy name → policy identity
    expect(op.meaning).toContain("when to use");
    expect(op.params).toEqual([{ name: "order_id", meaning: "the order number", required: true }]);
  });

  it("executes a READ tool through the real production executor", async () => {
    vi.mocked(executeCustomApiTool).mockResolvedValue({ ok: true, result: { status: "shipped" }, meta: { status: 200, durationMs: 5 } } as any);
    const { result } = await CustomCapability.execute!(req("custom.order_status", { order_id: "A-42" }));
    expect(result.status).toBe("EXECUTED");
    expect((result as any).data.result.status).toBe("shipped");
    expect(executeCustomApiTool).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "t1", slug: "order_status", args: { order_id: "A-42" } }),
    );
  });

  it("missing required param → NEEDS_INPUT, executor never called", async () => {
    const { result } = await CustomCapability.execute!(req("custom.order_status", {}));
    expect(result).toMatchObject({ status: "NEEDS_INPUT" });
    expect(executeCustomApiTool).not.toHaveBeenCalled();
  });

  it("executor failure → observable FAILED with the concrete reason", async () => {
    vi.mocked(executeCustomApiTool).mockResolvedValue({ ok: false, reason: "domain_whitelist_empty" } as any);
    const { result } = await CustomCapability.execute!(req("custom.order_status", { order_id: "A-42" }));
    expect(result).toMatchObject({ status: "FAILED", reason: "domain_whitelist_empty" });
  });

  it("unknown custom operation → BLOCKED (never a throw)", async () => {
    const { result } = await CustomCapability.execute!(req("custom.nope", {}));
    expect(result).toMatchObject({ status: "BLOCKED" });
  });

  it("ownsOperation covers both namespaces and nothing else", () => {
    expect(CustomCapability.ownsOperation("custom.x")).toBe(true);
    expect(CustomCapability.ownsOperation("custom_db.y")).toBe(true);
    expect(CustomCapability.ownsOperation("BOOK_MEETING")).toBe(false);
  });
});
