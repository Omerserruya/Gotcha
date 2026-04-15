import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Phase 1 — verify the action-executor performs REAL HTTP dispatch for
 * the tools that were previously faked with `{ queued: true }`.
 *
 * Tests mock `global.fetch` and assert the request shape AND that a
 * failing upstream propagates as `{ ok:false, error }` instead of fake
 * success.
 */

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    contact: {
      findFirst: vi.fn().mockResolvedValue({
        id: "c1",
        tenantId: "t1",
        externalId: "+111",
        channel: "WHATSAPP",
      }),
    },
    channelAccount: {
      findFirst: vi.fn().mockResolvedValue({ id: "ch1" }),
    },
    scheduledMessage: {
      create: vi.fn().mockResolvedValue({
        id: "sm1",
        scheduledAt: new Date("2030-01-01"),
        status: "PENDING",
      }),
    },
    businessPolicy: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

vi.mock("@chatcenter/shared", () => ({ prisma: prismaMock }));

import { executeAction, PlannedAction } from "../services/action-executor.service";

const fetchMock = vi.fn();
(globalThis as any).fetch = fetchMock;

function okResponse(body: unknown, status = 200) {
  return {
    ok: true,
    status,
    async text() {
      return JSON.stringify(body);
    },
  } as any;
}
function errResponse(body: unknown, status: number) {
  return {
    ok: false,
    status,
    async text() {
      return JSON.stringify(body);
    },
  } as any;
}

describe("action-executor — real HTTP dispatch (phase 1)", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.clearAllMocks();
    process.env.CONVERSATION_SERVICE_URL = "http://test-conversation";
  });
  afterEach(() => {
    delete process.env.CONVERSATION_SERVICE_URL;
  });

  it("create_broadcast POSTs to /api/broadcasts with auth propagated", async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ data: { id: "b1", status: "DRAFT" } }, 201));
    const action: PlannedAction = {
      tool: "create_broadcast",
      params: { name: "Q4 promo", channel: "WHATSAPP", channelAccountId: "ch1", templateId: "tmpl_1" },
      reason: "launch",
      riskLevel: "high",
    };
    const r = await executeAction("t1", action, {
      approved: true,
      approvedBy: "admin",
      authToken: "jwt-xyz",
    });
    expect(r.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://test-conversation/api/broadcasts");
    expect(init.method).toBe("POST");
    expect(init.headers["Authorization"]).toBe("Bearer jwt-xyz");
    expect(init.headers["x-tenant-id"]).toBe("t1");
    expect(JSON.parse(init.body)).toMatchObject({ name: "Q4 promo", channel: "WHATSAPP" });
    expect((r.output as any).data.id).toBe("b1");
  });

  it("create_broadcast surfaces upstream 4xx as { ok:false } — no fake success", async () => {
    fetchMock.mockResolvedValueOnce(errResponse({ error: "channelAccountId is required" }, 400));
    const r = await executeAction(
      "t1",
      {
        tool: "create_broadcast",
        params: { name: "oops" },
        reason: "launch",
        riskLevel: "high",
      },
      { approved: true, approvedBy: "admin", authToken: "jwt-xyz" },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/channelAccountId is required/);
  });

  it("resolve_identity calls /api/identity/resolve and returns upstream payload", async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({ matched: true, contact: { id: "c9", email: "a@b.co" } }, 200),
    );
    const r = await executeAction(
      "t1",
      {
        tool: "resolve_identity",
        params: { email: "a@b.co" },
        reason: "lookup",
        riskLevel: "low",
      },
      { authToken: "jwt-xyz" },
    );
    expect(r.ok).toBe(true);
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://test-conversation/api/identity/resolve");
    expect((r.output as any).matched).toBe(true);
  });

  it("merge_contacts calls /api/identity/merge and surfaces 409 as failure", async () => {
    fetchMock.mockResolvedValueOnce(
      errResponse({ error: "merge conflict: source already removed" }, 409),
    );
    const r = await executeAction(
      "t1",
      {
        tool: "merge_contacts",
        params: { targetId: "c1", sourceId: "c2" },
        reason: "dedupe",
        riskLevel: "medium",
      },
      { authToken: "jwt-xyz" },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/merge conflict/);
  });

  it("schedule_followup inserts a ScheduledMessage row (real side effect)", async () => {
    const r = await executeAction(
      "t1",
      {
        tool: "schedule_followup",
        params: { contactId: "c1", body: "ping", scheduleAt: "2030-01-01T10:00:00Z" },
        reason: "nudge",
        riskLevel: "high",
      },
      { approved: true, approvedBy: "admin", authToken: "jwt-xyz" },
    );
    expect(r.ok).toBe(true);
    expect(prismaMock.scheduledMessage.create).toHaveBeenCalledTimes(1);
    const call = prismaMock.scheduledMessage.create.mock.calls[0]![0];
    expect(call.data.tenantId).toBe("t1");
    expect(call.data.recipientExternalId).toBe("+111");
    expect(call.data.channelAccountId).toBe("ch1");
    expect(call.data.body).toBe("ping");
    expect(call.data.status).toBe("PENDING");
  });

  it("schedule_broadcast PATCHes /api/broadcasts/:id with scheduledAt", async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ data: { id: "b1", scheduledAt: "2030-01-01T10:00:00Z" } }, 200));
    const r = await executeAction(
      "t1",
      {
        tool: "schedule_broadcast",
        params: { broadcastId: "b1", scheduleAt: "2030-01-01T10:00:00Z" },
        reason: "delay",
        riskLevel: "high",
      },
      { approved: true, approvedBy: "admin", authToken: "jwt-xyz" },
    );
    expect(r.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://test-conversation/api/broadcasts/b1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ scheduledAt: "2030-01-01T10:00:00Z" });
  });

  it("falls back to INTERNAL_SERVICE_TOKEN when no auth header present", async () => {
    process.env.INTERNAL_SERVICE_TOKEN = "svc-secret";
    fetchMock.mockResolvedValueOnce(okResponse({ matched: false, contact: null }, 200));
    await executeAction(
      "t1",
      {
        tool: "resolve_identity",
        params: { phone: "+222" },
        reason: "lookup",
        riskLevel: "low",
      },
      {},
    );
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers["Authorization"]).toBe("Bearer svc-secret");
    delete process.env.INTERNAL_SERVICE_TOKEN;
  });
});
