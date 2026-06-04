import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("@chatcenter/shared", () => {
  const mockPrisma = {
    webhookTrigger: { findUnique: vi.fn() },
  };

  return {
    prisma: mockPrisma,
    incomingMessageQueue: { add: vi.fn().mockResolvedValue(undefined) },
    // Pass-through middleware in tests — the real one toggles the Prisma
    // tenant-guard, which is irrelevant against the mocked client.
    crossTenantMiddleware: (_req: any, _res: any, next: any) => next(),
  };
});

import triggerRoutes from "../routes/triggers";
import { prisma, incomingMessageQueue } from "@chatcenter/shared";

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use("/webhooks", triggerRoutes);
  return app;
}

const VALID_TRIGGER = {
  id: "trig-1",
  tenantId: "tenant-1",
  workflowId: "flow-1",
  token: "tok-abc",
  secret: "s3cr3t",
  enabled: true,
};

describe("POST /webhooks/:token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 404 for an unknown token", async () => {
    (prisma.webhookTrigger.findUnique as any).mockResolvedValue(null);

    const res = await request(createTestApp())
      .post("/webhooks/does-not-exist")
      .set("x-webhook-secret", "whatever")
      .send({ hello: "world" });

    expect(res.status).toBe(404);
    expect(incomingMessageQueue.add).not.toHaveBeenCalled();
  });

  it("returns 401 when the secret header is missing", async () => {
    (prisma.webhookTrigger.findUnique as any).mockResolvedValue(VALID_TRIGGER);

    const res = await request(createTestApp())
      .post("/webhooks/tok-abc")
      .send({ hello: "world" });

    expect(res.status).toBe(401);
    expect(incomingMessageQueue.add).not.toHaveBeenCalled();
  });

  it("returns 401 when the secret is wrong", async () => {
    (prisma.webhookTrigger.findUnique as any).mockResolvedValue(VALID_TRIGGER);

    const res = await request(createTestApp())
      .post("/webhooks/tok-abc")
      .set("x-webhook-secret", "wrong-secret")
      .send({ hello: "world" });

    expect(res.status).toBe(401);
    expect(incomingMessageQueue.add).not.toHaveBeenCalled();
  });

  it("returns 403 when the trigger is disabled", async () => {
    (prisma.webhookTrigger.findUnique as any).mockResolvedValue({
      ...VALID_TRIGGER,
      enabled: false,
    });

    const res = await request(createTestApp())
      .post("/webhooks/tok-abc")
      .set("x-webhook-secret", "s3cr3t")
      .send({ hello: "world" });

    expect(res.status).toBe(403);
    expect(incomingMessageQueue.add).not.toHaveBeenCalled();
  });

  it("enqueues the event and returns 200 on a valid, authenticated call", async () => {
    (prisma.webhookTrigger.findUnique as any).mockResolvedValue(VALID_TRIGGER);

    const payload = { order: { id: 42, status: "paid" }, nested: { a: [1, 2, 3] } };
    const res = await request(createTestApp())
      .post("/webhooks/tok-abc")
      .set("x-webhook-secret", "s3cr3t")
      .send(payload);

    expect(res.status).toBe(200);
    expect(incomingMessageQueue.add).toHaveBeenCalledWith(
      "webhook-trigger",
      {
        triggerId: "trig-1",
        workflowId: "flow-1",
        tenantId: "tenant-1",
        payload,
        // Defaults to flow mode when the record predates the field.
        targetMode: "flow",
      },
      expect.any(Object),
    );
  });

  it("forwards the trigger's connected target mode on the enqueued job", async () => {
    (prisma.webhookTrigger.findUnique as any).mockResolvedValue({
      ...VALID_TRIGGER,
      targetMode: "connected",
    });

    const res = await request(createTestApp())
      .post("/webhooks/tok-abc")
      .set("x-webhook-secret", "s3cr3t")
      .send({ any: "thing" });

    expect(res.status).toBe(200);
    const enqueued = (incomingMessageQueue.add as any).mock.calls[0][1];
    expect(enqueued.targetMode).toBe("connected");
  });

  it("forwards the raw JSON payload to the queue intact", async () => {
    (prisma.webhookTrigger.findUnique as any).mockResolvedValue(VALID_TRIGGER);

    const payload = { weird: "✓ data", arr: [{ deep: true }], n: 0, b: false };
    await request(createTestApp())
      .post("/webhooks/tok-abc")
      .set("x-webhook-secret", "s3cr3t")
      .send(payload);

    const enqueued = (incomingMessageQueue.add as any).mock.calls[0][1];
    expect(enqueued.payload).toEqual(payload);
  });

  it("looks up the trigger by the token path param", async () => {
    (prisma.webhookTrigger.findUnique as any).mockResolvedValue(VALID_TRIGGER);

    await request(createTestApp())
      .post("/webhooks/tok-abc")
      .set("x-webhook-secret", "s3cr3t")
      .send({});

    expect(prisma.webhookTrigger.findUnique).toHaveBeenCalledWith({
      where: { token: "tok-abc" },
    });
  });
});
