/**
 * WhatsApp template status updates (B9, 2026-10-13):
 *  - matched by Meta's template id, else by name AND language on this number
 *    (by name alone, the English template's status overwrote the Hebrew one);
 *  - PAUSED makes the template unusable (it used to be ignored, so a paused
 *    template stayed APPROVED and was still offered), with the exact Meta state
 *    in front of the reason: "[PAUSED] ...".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const H = vi.hoisted(() => ({ updates: [] as any[] }));

vi.mock("@chatcenter/shared", () => ({
  prisma: {
    channelAccount: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => [{ id: "ca1", tenantId: "T", credentials: "enc", isActive: true }]),
    },
    message: { findFirst: vi.fn(), update: vi.fn() },
    messageTemplate: { updateMany: vi.fn(async (a: any) => { H.updates.push(a); return { count: 1 }; }) },
  },
  decryptCredentials: vi.fn(() => ({ wabaId: "waba1" })),
  incomingMessageQueue: { add: vi.fn() },
  publishEvent: vi.fn(async () => undefined),
  detectInboundAdapter: vi.fn(() => ({
    channel: "WHATSAPP",
    getSignatureHeader: () => "x-hub-signature-256",
    verifySignature: () => true,
    resolveChannelAccountExternalId: () => null,
    extractMessages: () => [],
    extractStatusUpdates: () => [],
  })),
  verifyWebhookSignature: vi.fn(() => ({ ok: true })),
  verifySharedSecretToken: vi.fn(() => ({ ok: true })),
  timingSafeEqualStr: vi.fn(() => false),
  createServiceApp: () => express(),
  startService: vi.fn(),
  createWorker: vi.fn(),
  crossTenantMiddleware: (_q: any, _s: any, n: any) => n(),
  reportOperationalFailure: vi.fn(),
  ERROR_CODES: new Proxy({}, { get: (_t, k) => String(k) }),
}));

import webhookRoutes from "../routes/webhook";
const app = express();
app.use(express.json());
app.use("/api/webhook", webhookRoutes);

const post = async (value: any, field = "message_template_status_update") => {
  await request(app).post("/api/webhook").send({ object: "whatsapp_business_account", entry: [{ id: "waba1", changes: [{ field, value }] }] });
  await new Promise((r) => setTimeout(r, 20));
};

beforeEach(() => { H.updates = []; });

describe("template status updates", () => {
  it("★ PAUSED: no longer usable, the Meta state in front of the reason", async () => {
    await post({ event: "PAUSED", message_template_id: 991, message_template_name: "gotcha_reopen", message_template_language: "he", reason: "Low quality" });
    expect(H.updates).toHaveLength(1);
    expect(H.updates[0].data).toEqual({ metaTemplateId: "991", status: "REJECTED", rejectionReason: "[PAUSED] Low quality" });
  });

  it("DISABLED with no reason: just the state", async () => {
    await post({ event: "DISABLED", message_template_name: "gotcha_reopen", message_template_language: "he" });
    expect(H.updates[0].data).toEqual({ status: "REJECTED", rejectionReason: "[DISABLED]" });
  });

  it("REJECTED keeps Meta's reason as it was; APPROVED clears it", async () => {
    await post({ event: "REJECTED", message_template_name: "t", message_template_language: "en", reason: "INVALID_FORMAT" });
    await post({ event: "APPROVED", message_template_name: "t", message_template_language: "en" });
    expect(H.updates.map((u) => u.data)).toEqual([{ status: "REJECTED", rejectionReason: "INVALID_FORMAT" }, { status: "APPROVED", rejectionReason: null }]);
  });

  it("★ matched by Meta's id, else by name AND language on this number", async () => {
    await post({ event: "APPROVED", message_template_id: 991, message_template_name: "gotcha_reopen", message_template_language: "he" });
    expect(H.updates[0].where).toEqual({
      tenantId: "T",
      channel: "WHATSAPP",
      OR: [
        { metaTemplateId: "991" },
        { AND: [{ name: "gotcha_reopen" }, { language: "he" }, { metaTemplateId: null }, { OR: [{ channelAccountId: "ca1" }, { channelAccountId: null }] }] },
      ],
    });
  });

  it("without an id or language, by name on this number (as before)", async () => {
    await post({ event: "APPROVED", message_template_name: "old" });
    expect(H.updates[0].where.OR).toEqual([{ AND: [{ name: "old" }, { OR: [{ channelAccountId: "ca1" }, { channelAccountId: null }] }] }]);
  });
});
