import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("@chatcenter/shared", () => {
  const mockPrisma = {
    channelAccount: { findFirst: vi.fn() },
    message: { findFirst: vi.fn(), update: vi.fn() },
  };

  return {
    prisma: mockPrisma,
    incomingMessageQueue: { add: vi.fn().mockResolvedValue(undefined) },
    publishEvent: vi.fn().mockResolvedValue(undefined),
    detectInboundAdapter: vi.fn(),
    // Shared webhook verifier. Default to "verified" so the enqueue path can be
    // exercised; individual tests override to { ok: false } to assert drops.
    verifyWebhookSignature: vi.fn().mockReturnValue({ ok: true }),
    verifySharedSecretToken: vi.fn().mockReturnValue({ ok: true }),
    timingSafeEqualStr: vi.fn().mockReturnValue(false),
    createServiceApp: (config: any) => {
      const app = express();
      app.use(express.json());
      app.get("/health", (_req, res) => res.json({ status: "ok", service: config.name }));
      return app;
    },
    startService: vi.fn(),
    createWorker: vi.fn(),
    // Pass-through: webhook.ts mounts this as router-level middleware at module
    // load, so the mock must define it or the whole suite fails to import.
    crossTenantMiddleware: (_req: any, _res: any, next: any) => next(),
  };
});

import webhookRoutes from "../routes/webhook";
import { prisma, incomingMessageQueue, detectInboundAdapter, verifyWebhookSignature } from "@chatcenter/shared";

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
    it("should respond 200 immediately and queue messages via adapter", async () => {
      const mockChannelAccount = { id: "ca-1", tenantId: "tenant-1", externalId: "phone-1" };
      (prisma.channelAccount.findFirst as any).mockResolvedValue(mockChannelAccount);

      const mockAdapter = {
        channel: "WHATSAPP",
        getSignatureHeader: () => "x-hub-signature-256",
        verifySignature: vi.fn().mockReturnValue(true),
        resolveChannelAccountExternalId: vi.fn().mockReturnValue("phone-1"),
        extractMessages: vi.fn().mockReturnValue([{
          externalMessageId: "wa-msg-1",
          senderId: "+123",
          senderDisplayName: "John",
          timestamp: new Date(),
          content: { type: "text", text: "Hello" },
        }]),
        extractStatusUpdates: vi.fn().mockReturnValue([]),
      };
      (detectInboundAdapter as any).mockReturnValue(mockAdapter);

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
        expect.objectContaining({
          tenantId: "tenant-1",
          channel: "WHATSAPP",
          channelAccountId: "ca-1",
          normalizedMessage: expect.objectContaining({
            externalMessageId: "wa-msg-1",
            senderId: "+123",
            body: "Hello",
          }),
        }),
        expect.any(Object)
      );
    });

    it("drops a Meta webhook whose signature fails verification (no enqueue)", async () => {
      (verifyWebhookSignature as any).mockReturnValueOnce({ ok: false, reason: "signature mismatch" });
      (prisma.channelAccount.findFirst as any).mockResolvedValue({ id: "ca-1", tenantId: "tenant-1", externalId: "phone-1" });
      (detectInboundAdapter as any).mockReturnValue({
        channel: "WHATSAPP",
        getSignatureHeader: () => "x-hub-signature-256",
        verifySignature: vi.fn().mockReturnValue(false),
        resolveChannelAccountExternalId: vi.fn().mockReturnValue("phone-1"),
        extractMessages: vi.fn().mockReturnValue([{ externalMessageId: "x", senderId: "+1", timestamp: new Date(), content: { type: "text", text: "forged" } }]),
        extractStatusUpdates: vi.fn().mockReturnValue([]),
      });
      const app = createTestApp();
      const res = await request(app).post("/api/webhook").send({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: {} }] }] });
      expect(res.status).toBe(200); // 200 is sent up-front by design
      await new Promise((r) => setTimeout(r, 50));
      expect(incomingMessageQueue.add).not.toHaveBeenCalled(); // but nothing enqueued
    });

    it("should ignore payloads from unknown platforms", async () => {
      (detectInboundAdapter as any).mockReturnValue(null);

      const app = createTestApp();
      const res = await request(app)
        .post("/api/webhook")
        .send({ object: "other" });

      expect(res.status).toBe(200);
      expect(incomingMessageQueue.add).not.toHaveBeenCalled();
    });
  });

  // Regression: the Slack webhook previously verified only when the signing
  // secret was set AND all headers were present, so an attacker who simply
  // omitted x-slack-signature bypassed verification and forged a message into
  // any tenant. Verification is now mandatory/fail-closed.
  describe("POST /api/webhook/slack (signature fail-closed)", () => {
    it("still answers the url_verification challenge", async () => {
      const app = createTestApp();
      const res = await request(app)
        .post("/api/webhook/slack")
        .send({ type: "url_verification", challenge: "abc123" });
      expect(res.status).toBe(200);
      expect(res.body.challenge).toBe("abc123");
      expect(incomingMessageQueue.add).not.toHaveBeenCalled();
    });

    it("rejects a forged event when the secret is set but no signature header is sent", async () => {
      process.env.SLACK_SIGNING_SECRET = "test-slack-secret";
      const app = createTestApp();
      const res = await request(app)
        .post("/api/webhook/slack")
        .send({ team_id: "T_VICTIM", event: { type: "message", text: "forged", user: "U1" } });
      // No x-slack-signature header -> dropped before any enqueue.
      expect(res.status).toBe(403);
      expect(incomingMessageQueue.add).not.toHaveBeenCalled();
      delete process.env.SLACK_SIGNING_SECRET;
    });
  });
});
