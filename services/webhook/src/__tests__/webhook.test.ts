import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("@chatcenter/shared", () => {
  const mockPrisma = {
    tenant: { findFirst: vi.fn() },
    message: { findFirst: vi.fn(), update: vi.fn() },
  };

  return {
    prisma: mockPrisma,
    incomingMessageQueue: { add: vi.fn().mockResolvedValue(undefined) },
    publishEvent: vi.fn().mockResolvedValue(undefined),
    createServiceApp: (config: any) => {
      const app = express();
      app.use(express.json());
      app.get("/health", (_req, res) => res.json({ status: "ok", service: config.name }));
      return app;
    },
    startService: vi.fn(),
    createWorker: vi.fn(),
  };
});

import webhookRoutes from "../routes/webhook";
import { prisma, incomingMessageQueue } from "@chatcenter/shared";

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/webhook", webhookRoutes);
  return app;
}

describe("Webhook Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/webhook (verification)", () => {
    it("should verify webhook with correct token", async () => {
      process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = "test-token";

      const app = createTestApp();
      const res = await request(app).get("/api/webhook")
        .query({
          "hub.mode": "subscribe",
          "hub.verify_token": "test-token",
          "hub.challenge": "challenge-123",
        });

      expect(res.status).toBe(200);
      expect(res.text).toBe("challenge-123");
    });

    it("should reject webhook with wrong token", async () => {
      process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = "test-token";

      const app = createTestApp();
      const res = await request(app).get("/api/webhook")
        .query({
          "hub.mode": "subscribe",
          "hub.verify_token": "wrong-token",
          "hub.challenge": "challenge-123",
        });

      expect(res.status).toBe(403);
    });
  });

  describe("POST /api/webhook (handler -> queue)", () => {
    it("should respond 200 immediately and queue messages", async () => {
      const mockTenant = { id: "tenant-1", waPhoneNumberId: "phone-1" };
      (prisma.tenant.findFirst as any).mockResolvedValue(mockTenant);

      const app = createTestApp();
      const res = await request(app)
        .post("/api/webhook")
        .send({
          object: "whatsapp_business_account",
          entry: [{
            changes: [{
              field: "messages",
              value: {
                metadata: { phone_number_id: "phone-1" },
                messages: [{ id: "wa-msg-1", from: "+123", type: "text", text: { body: "Hello" } }],
                contacts: [{ profile: { name: "John" } }],
              },
            }],
          }],
        });

      expect(res.status).toBe(200);
      // Give async handler time to complete
      await new Promise((r) => setTimeout(r, 100));
      expect(incomingMessageQueue.add).toHaveBeenCalledWith(
        "process",
        expect.objectContaining({ tenantId: "tenant-1", phoneNumberId: "phone-1" }),
        expect.any(Object)
      );
    });

    it("should ignore non-whatsapp payloads", async () => {
      const app = createTestApp();
      const res = await request(app)
        .post("/api/webhook")
        .send({ object: "other" });

      expect(res.status).toBe(200);
      expect(incomingMessageQueue.add).not.toHaveBeenCalled();
    });
  });
});
