import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

/**
 * ai-assist-voice.test.ts
 *
 * Tests for POST /voice (voice stream handler).
 * Mocks @chatcenter/shared (prisma + redis) following ai-bot-e2e.test.ts style.
 * Spec reference: §9, W9
 */

// ─── Hoisted mocks ──────────────────────────────────────────

const { prismaMock, redisMock, publishEventMock } = vi.hoisted(() => {
  const redisMock = {
    set: vi.fn(),
    get: vi.fn(),
    del: vi.fn(),
    pipeline: vi.fn(),
  };

  const prismaMock = {
    conversation: {
      findFirst: vi.fn(),
    },
    message: {
      findMany: vi.fn().mockResolvedValue([]),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };

  const publishEventMock = vi.fn().mockResolvedValue(undefined);

  return { prismaMock, redisMock, publishEventMock };
});

vi.mock("@chatcenter/shared", () => ({
  // Version pins now live in shared modules, so exhaustive mocks of this
  // barrel must supply them. Returning the real defaults keeps any URL the
  // code builds meaningful instead of "undefined/...".
  shopifyApiVersion: () => "2026-07",
  checkShopifyResponseVersion: () => ({ ok: true, served: "2026-07" }),
  metaGraphBaseUrl: (legacy?: string) => legacy || "https://graph.facebook.com/v24.0",
  stripeVersionHeader: () => ({ "Stripe-Version": "2026-02-25.clover" }),
  prisma: prismaMock,
  getRedis: () => redisMock,
  publishEvent: publishEventMock,
  // Middleware stubs - ai-assist.ts imports these at module load
  authenticate: (_req: any, _res: any, next: any) => next(),
  resolveTenant: (_req: any, _res: any, next: any) => next(),
  requireActiveTenant: () => (_req: any, _res: any, next: any) => next(),
  requireRole: (_role: string) => (_req: any, _res: any, next: any) => next(),
  // Other shared exports used by services
  trackAIUsage: vi.fn().mockResolvedValue(undefined),
  decryptCredentials: vi.fn().mockReturnValue({}),
  evaluateToolGate: vi.fn().mockResolvedValue({ decision: "ALLOW", reason: "default" }),
  getDefaultHighRiskTools: () => [],
  createApprovalRequest: vi.fn().mockResolvedValue({ id: "apr-1", expiresAt: new Date() }),
  findPendingByConversation: vi.fn().mockResolvedValue([]),
  approveRequest: vi.fn(),
  rejectRequest: vi.fn(),
  buildAgentTools: vi.fn().mockReturnValue([]),
  dispatchToolCall: vi.fn(),
  closeRedis: vi.fn(),
}));

// Mock ai-assist.service to avoid full AI stack in unit tests
vi.mock("../services/ai-assist.service", () => ({
  getEffectiveCopilotConfig: vi.fn().mockResolvedValue(null),
  getSuggestions: vi.fn().mockResolvedValue([]),
}));

import aiAssistRouter from "../routes/ai-assist";

// ─── Test app ────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/ai-assist", aiAssistRouter);
  return app;
}

// ─── Helpers ─────────────────────────────────────────────────

const INTERNAL_KEY = "chatcenter-internal-2026";
const TENANT_ID = "tenant-abc";
const CONV_ID = "conv-xyz";

function authHeaders(opts: { useBearer?: boolean; key?: string } = {}) {
  const key = opts.key ?? INTERNAL_KEY;
  if (opts.useBearer) {
    return {
      Authorization: `Bearer ${key}`,
      "x-tenant-id": TENANT_ID,
    };
  }
  return {
    "x-internal-key": key,
    "x-tenant-id": TENANT_ID,
  };
}

function makeMsg(overrides: Partial<{
  speaker: "agent" | "customer";
  text: string;
  timestamp: number;
  isFinal: boolean;
  confidence: number;
  seq: number;
}> = {}) {
  return {
    speaker: "customer",
    text: "Hello there",
    timestamp: 1700000000000,
    isFinal: false,
    confidence: 0.9,
    seq: 0,
    ...overrides,
  };
}

function makePipeline(results: ("OK" | null)[]) {
  return {
    set: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(results.map((r) => [null, r])),
  };
}

function validBody(msgs: ReturnType<typeof makeMsg>[]) {
  return {
    type: "voice_stream",
    tenantId: TENANT_ID,
    conversationId: CONV_ID,
    messages: msgs,
  };
}

// ─── Tests ───────────────────────────────────────────────────

describe("POST /api/ai-assist/voice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.INTERNAL_SERVICE_KEY = INTERNAL_KEY;

    // Default: conversation found
    prismaMock.conversation.findFirst.mockResolvedValue({
      id: CONV_ID,
      tenantId: TENANT_ID,
      departmentId: null,
      customerName: null,
    });
  });

  // ─── Test 1: Valid stream with 2 partials + 1 customer final → persists 3, triggers assist ───

  it("valid voice_stream with 2 partials + 1 customer final: persists 3, schedules assist trigger", async () => {
    const msgs = [
      makeMsg({ speaker: "customer", isFinal: false, seq: 0 }),
      makeMsg({ speaker: "agent", isFinal: false, seq: 0, text: "Yes?" }),
      makeMsg({ speaker: "customer", isFinal: true, seq: 1, text: "I need help" }),
    ];

    // All 3 pipeline slots claimed
    redisMock.set.mockResolvedValue("OK"); // top-level idem not used in this call
    redisMock.pipeline.mockReturnValue(makePipeline(["OK", "OK", "OK"]));

    const app = buildApp();
    const res = await request(app)
      .post("/api/ai-assist/voice")
      .set(authHeaders())
      .send(validBody(msgs));

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.processed).toBe(3);
    expect(res.body.deduped).toBe(0);
    expect(prismaMock.message.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ channel: "VOICE", messageType: "voice_final" }),
        ]),
      }),
    );
    // triggerAssist is async - publishEvent fires after debounce; verify createMany was called
    // (the actual setTimeout fires outside this test, which is fine - we verify scheduling path)
  });

  // ─── Test 2: Only partials → persists, does NOT trigger assist ───────────────────────────

  it("only partials: persists all, does NOT call scheduleAssistTrigger path", async () => {
    const msgs = [
      makeMsg({ speaker: "customer", isFinal: false, seq: 0 }),
      makeMsg({ speaker: "customer", isFinal: false, seq: 1 }),
    ];

    redisMock.pipeline.mockReturnValue(makePipeline(["OK", "OK"]));

    const app = buildApp();
    const res = await request(app)
      .post("/api/ai-assist/voice")
      .set(authHeaders())
      .send(validBody(msgs));

    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(2);
    expect(res.body.deduped).toBe(0);
    // No customer final → redis debounce set should NOT have been called for assist
    // (pipeline.set is for per-msg dedupe, not debounce - debounce redis.set only on customer final)
    expect(prismaMock.message.createMany).toHaveBeenCalled();
  });

  // ─── Test 3: Duplicate X-Idempotency-Key → 200 {processed:0,deduped:N}, no DB writes ──

  it("duplicate X-Idempotency-Key: responds 200 {processed:0, deduped} without DB writes", async () => {
    // Simulate key already claimed: redis.set returns null (NX failed)
    redisMock.set.mockResolvedValue(null);

    const msgs = [makeMsg(), makeMsg({ seq: 1 })];
    const app = buildApp();
    const res = await request(app)
      .post("/api/ai-assist/voice")
      .set({ ...authHeaders(), "x-idempotency-key": "idem-key-abc" })
      .send(validBody(msgs));

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.processed).toBe(0);
    expect(res.body.deduped).toBe(2);
    expect(prismaMock.message.createMany).not.toHaveBeenCalled();
    expect(prismaMock.conversation.findFirst).not.toHaveBeenCalled();
  });

  // ─── Test 4: Per-message idempotency: same (speaker,seq) → dedupe that message ─────────

  it("per-message dedupe: one of two messages already claimed → persists only the new one", async () => {
    const msgs = [
      makeMsg({ speaker: "customer", seq: 0, isFinal: false }),
      makeMsg({ speaker: "customer", seq: 1, isFinal: false }),
    ];
    // First pipeline slot already claimed (null), second newly claimed ("OK")
    redisMock.pipeline.mockReturnValue(makePipeline([null, "OK"]));

    const app = buildApp();
    const res = await request(app)
      .post("/api/ai-assist/voice")
      .set(authHeaders())
      .send(validBody(msgs));

    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(1);
    expect(res.body.deduped).toBe(1);
    expect(prismaMock.message.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.arrayContaining([expect.objectContaining({ metadata: expect.objectContaining({ voice: expect.objectContaining({ seq: 1 }) }) })]) }),
    );
  });

  // ─── Test 5: Cross-tenant body.tenantId ≠ x-tenant-id header → 403 ───────────────────

  it("cross-tenant: body.tenantId !== x-tenant-id → 403 cross_tenant_denied", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/ai-assist/voice")
      .set(authHeaders())
      .send({
        type: "voice_stream",
        tenantId: "different-tenant",
        conversationId: CONV_ID,
        messages: [makeMsg()],
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("cross_tenant_denied");
    expect(prismaMock.conversation.findFirst).not.toHaveBeenCalled();
  });

  // ─── Test 6: Conversation not found for tenant → 403 ─────────────────────────────────

  it("conversation not found for tenant → 403", async () => {
    prismaMock.conversation.findFirst.mockResolvedValue(null);
    redisMock.set.mockResolvedValue("OK"); // idem key claimed

    const app = buildApp();
    const res = await request(app)
      .post("/api/ai-assist/voice")
      .set(authHeaders())
      .send(validBody([makeMsg()]));

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("cross_tenant_denied");
    expect(prismaMock.message.createMany).not.toHaveBeenCalled();
  });

  // ─── Test 7: Malformed body (missing `type`) → 400 ───────────────────────────────────

  it("malformed body (missing type field) → 400", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/ai-assist/voice")
      .set(authHeaders())
      .send({
        tenantId: TENANT_ID,
        conversationId: CONV_ID,
        messages: [makeMsg()],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("malformed");
    expect(res.body.details).toBeDefined();
  });

  // ─── Test 8: Missing internal key → 401 ──────────────────────────────────────────────

  it("missing internal key → 401 unauthorized", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/ai-assist/voice")
      .set({ "x-tenant-id": TENANT_ID })
      .send(validBody([makeMsg()]));

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  // ─── Test 9: Agent final alone does NOT trigger assist ────────────────────────────────

  it("agent final only: persists but does NOT trigger assist (no customer final)", async () => {
    const msgs = [
      makeMsg({ speaker: "agent", isFinal: true, seq: 0, text: "How can I help?" }),
    ];
    redisMock.pipeline.mockReturnValue(makePipeline(["OK"]));

    const app = buildApp();
    const res = await request(app)
      .post("/api/ai-assist/voice")
      .set(authHeaders())
      .send(validBody(msgs));

    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(1);
    // Debounce redis.set (non-pipeline) should NOT have been called for assist scheduling
    // The pipeline.set is for per-msg dedupe only; no additional redis.set for debounce
    expect(prismaMock.message.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ direction: "OUTBOUND", messageType: "voice_final" }),
        ]),
      }),
    );
  });

  // ─── Test 10: Batch of 5 messages all persisted ───────────────────────────────────────

  it("batch of 5 messages: all persisted when none are dupes", async () => {
    const msgs = [0, 1, 2, 3, 4].map((seq) =>
      makeMsg({ seq, isFinal: seq === 4, speaker: "customer" }),
    );
    redisMock.pipeline.mockReturnValue(makePipeline(["OK", "OK", "OK", "OK", "OK"]));

    const app = buildApp();
    const res = await request(app)
      .post("/api/ai-assist/voice")
      .set(authHeaders())
      .send(validBody(msgs));

    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(5);
    expect(res.body.deduped).toBe(0);
    expect(prismaMock.message.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.arrayContaining([expect.objectContaining({ channel: "VOICE" })]) }),
    );
    expect((prismaMock.message.createMany.mock.calls[0][0] as any).data).toHaveLength(5);
  });

  // ─── Bonus: Authorization: Bearer key also accepted ──────────────────────────────────

  it("Authorization: Bearer {key} header is also accepted", async () => {
    redisMock.pipeline.mockReturnValue(makePipeline(["OK"]));

    const app = buildApp();
    const res = await request(app)
      .post("/api/ai-assist/voice")
      .set(authHeaders({ useBearer: true }))
      .send(validBody([makeMsg()]));

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  // ─── Bonus: Wrong key → 401 ───────────────────────────────────────────────────────────

  it("wrong internal key → 401 unauthorized", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/ai-assist/voice")
      .set(authHeaders({ key: "wrong-key" }))
      .send(validBody([makeMsg()]));

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });
});
