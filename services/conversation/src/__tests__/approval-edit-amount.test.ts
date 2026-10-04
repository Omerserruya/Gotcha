/**
 * "Edit amount" on an approval: POST /api/approvals/:id/approve { edits: { amount } }.
 *
 * The approver may LOWER the amount of an allow-listed money tool. The original
 * params stay on the row for audit, the edited ones are what runs, and nothing
 * outside the list can be edited this way. Approving without edits is exactly
 * what it was.
 *
 * The approval store is a double with the real compare-and-set semantics of
 * approveRequest (only a PENDING row can be decided, once), and the dispatch
 * is observed at the HTTP boundary to the ai service - so "runs with 120"
 * means 120 left this service, not that a variable held it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const S = vi.hoisted(() => ({
  row: null as any,
  approveCalls: [] as any[],
  dispatched: [] as any[],
  gate: { allowModification: false },
}));

vi.mock("@chatcenter/shared", () => ({
  readDurableSetting: async () => null,
  writeDurableSetting: async () => undefined,
  settingCacheKey: (t: string, k: string) => `tenant:${t}:${k}`,
  shopifyApiVersion: () => "2026-07",
  checkShopifyResponseVersion: () => ({ ok: true, served: "2026-07" }),
  metaGraphBaseUrl: (legacy?: string) => legacy || "https://graph.facebook.com/v24.0",
  stripeVersionHeader: () => ({ "Stripe-Version": "2026-02-25.clover" }),
  getInternalServiceKey: () => "test-internal-key",
  reportOperationalFailure: () => undefined,
  recordExpectedOutcome: () => undefined,
  recordHandover: async () => undefined,
  ERROR_CODES: new Proxy({}, { get: (_t, k) => String(k) }),
  prisma: {
    approvalRequest: {
      findFirst: async (a: any) => (S.row && a.where.id === S.row.id && a.where.tenantId === S.row.tenantId ? { ...S.row } : null),
      updateMany: async () => ({ count: 1 }),
    },
    conversation: { findFirst: async () => null, update: async () => ({}) },
    message: { findMany: async () => [], create: async () => ({ id: "m1" }) },
    tenantTool: { findFirst: async () => null },
    user: { findMany: async () => [] },
  },
  // Real CAS semantics: decide a PENDING row once, store what it was given.
  approveRequest: async (_t: string, id: string, decidedBy: string, modifiedParams?: any, decisionReason?: string) => {
    S.approveCalls.push({ id, decidedBy, modifiedParams });
    if (S.row.status !== "PENDING") return null;
    S.row = { ...S.row, status: "APPROVED", decidedBy, decidedAt: new Date(), modifiedParams: modifiedParams ?? null, decisionReason: decisionReason ?? null };
    return { ...S.row };
  },
  rejectRequest: async () => null,
  claimForExecution: async () => ({ id: "apv_1" }),
  recordExecutionOutcome: async () => undefined,
  claimCustomerNotification: async () => false,
  linkCustomerMessage: async () => undefined,
  findPendingByConversation: async () => [],
  publishEvent: async () => undefined,
  outgoingMessageQueue: { add: async () => undefined },
  evaluateToolGate: async () => ({ approvalConfig: { allowModification: S.gate.allowModification } }),
  revalidateBeforeExecution: async () => ({ ok: true, decision: "ALLOWED" }),
  authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "mgr_1", role: "ADMIN" }; n(); },
  resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "tenant_a"; n(); },
  requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
  requireInternalKey: (_q: any, _s: any, n: any) => n(),
}));

import router from "../routes/approvals";

const app = express();
app.use(express.json());
app.use("/api/approvals", router);
const approve = (body?: any) => request(app).post("/api/approvals/apv_1/approve").send(body ?? {});

function pending(tool: string, params: Record<string, unknown>) {
  S.row = {
    id: "apv_1", tenantId: "tenant_a", conversationId: "conv_1", tool, params,
    status: "PENDING", requestedBy: "bot", expiresAt: new Date(Date.now() + 3600_000),
    modifiedParams: null, resumeEnvelope: null, correlationId: null,
  };
}

beforeEach(() => {
  S.approveCalls = [];
  S.dispatched = [];
  S.gate.allowModification = false;
  (globalThis as any).fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes("/adapter-tools/execute")) S.dispatched.push(JSON.parse(String(init?.body)));
    return { ok: true, status: 200, json: async () => ({ data: { ok: true, output: {} } }), text: async () => "{}" } as any;
  });
});

const REFUND = { order_name: "#1842", amount: 179, currency: "ILS", reason: "damaged" };

describe("edit amount - the decided case", () => {
  it("★ refund 179 → 120 runs with 120, and the row keeps both", async () => {
    pending("shopify.process_refund", REFUND);
    const res = await approve({ edits: { amount: 120 } });

    expect(res.status).toBe(200);
    expect(res.body.edit).toEqual({ field: "amount", key: "amount", from: 179, to: 120, unit: "major" });
    // What left this service for the provider:
    expect(S.dispatched).toHaveLength(1);
    expect(S.dispatched[0].args.amount).toBe(120);
    expect(S.dispatched[0].args.order_name).toBe("#1842");
    // The record: original for audit, edited is what ran, who and when.
    expect(S.row.params.amount).toBe(179);
    expect(S.row.modifiedParams).toEqual({ ...REFUND, amount: 120 });
    expect(S.row.decidedBy).toBe("mgr_1");
    expect(S.row.decidedAt).toBeInstanceOf(Date);
  });

  it("does not need allowModification - the edit can only narrow the action", async () => {
    pending("shopify.process_refund", REFUND);
    S.gate.allowModification = false;
    expect((await approve({ edits: { amount: 120.5 } })).status).toBe(200);
    expect(S.dispatched[0].args.amount).toBe(120.5);
  });
});

describe("edit amount - refused, and nothing is decided or dispatched", () => {
  const refused = async (tool: string, params: any, body: any, error: string) => {
    pending(tool, params);
    const res = await approve(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(error);
    expect(S.approveCalls).toHaveLength(0);
    expect(S.dispatched).toHaveLength(0);
    expect(S.row.status).toBe("PENDING");
  };

  it("★ an amount above the original → 400", () =>
    refused("shopify.process_refund", REFUND, { edits: { amount: 180 } }, "amount_above_original"));

  it("★ a field outside the allow-list → 400 edit_not_allowed", () =>
    refused("shopify.process_refund", REFUND, { edits: { order_name: "#9999" } }, "edit_not_allowed"));

  it("★ amount alongside a field outside the list → 400 (no partial apply)", () =>
    refused("shopify.process_refund", REFUND, { edits: { amount: 100, currency: "USD" } }, "edit_not_allowed"));

  it("a tool not on the list → 400 edit_not_allowed", () =>
    refused("shopify.cancel_order", { order_name: "#1842", amount: 50 }, { edits: { amount: 10 } }, "edit_not_allowed"));

  it("a full refund (no original amount) → 400, not an unbounded edit", () =>
    refused("shopify.process_refund", { order_name: "#1842" }, { edits: { amount: 120 } }, "edit_requires_original_amount"));

  it.each([[0], [-5], [120.123], ["120"], [Number.NaN]])("amount %s → 400 invalid_amount", (amount) =>
    refused("shopify.process_refund", REFUND, { edits: { amount } }, "invalid_amount"));

  it("minor-unit tools take whole numbers only", () =>
    refused("stripe.refund_payment", { charge_id: "ch_1", amount: 17900 }, { edits: { amount: 12000.5 } }, "invalid_amount"));

  it("edits and modifiedParams together → 400", () =>
    refused("shopify.process_refund", REFUND, { edits: { amount: 100 }, modifiedParams: { amount: 1 } }, "edit_not_allowed"));
});

describe("approving without edits is exactly what it was", () => {
  it("★ dispatches the original params and stores no modification", async () => {
    pending("shopify.process_refund", REFUND);
    const res = await approve({});
    expect(res.status).toBe(200);
    expect(res.body.edit).toBeNull();
    expect(S.dispatched[0].args).toEqual(REFUND);
    expect(S.row.modifiedParams).toBeNull();
  });

  it("free-form modifiedParams is still gated by allowModification", async () => {
    pending("shopify.process_refund", REFUND);
    const res = await approve({ modifiedParams: { ...REFUND, amount: 1 } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("MODIFICATION_NOT_ALLOWED");
  });
});
