/**
 * ★ Meta's "your app was removed from this business's WhatsApp account" is
 * forwarded to the channel health worker (2026-11-22).
 *
 * A business removed GOTCHA at Meta; Meta sent PARTNER_APP_UNINSTALLED and
 * PARTNER_REMOVED; no code read either, and the channel said CONNECTED for
 * five days with no message arriving. The webhook does not write the status
 * itself: it forwards one job and the worker, the status's one owner, decides.
 *
 * The delivery's shape is the one Meta really sent: the business's WABA is
 * value.waba_info.waba_id, and entry.id is a DIFFERENT id.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const H = vi.hoisted(() => ({ jobs: [] as any[], queueDown: false, templateWrites: 0 }));

vi.mock("@chatcenter/shared", async () => ({
  whatsappAccessRemoval: (await import("@chatcenter/shared/src/whatsapp/access-removal")).whatsappAccessRemoval,
  metaTemplateStatus: (await import("@chatcenter/shared/src/whatsapp/platform-store")).metaTemplateStatus,
  channelHealthQueue: {
    add: async (name: string, data: any, opts: any) => {
      if (H.queueDown) throw new Error("redis is down");
      H.jobs.push({ name, data, opts });
    },
  },
  isPlatformWaba: async () => false,
  applyPlatformTemplateStatus: async () => true,
  notePlatformPhoneQuality: async () => undefined,
  prisma: {
    channelAccount: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    message: { findFirst: vi.fn(), update: vi.fn() },
    messageTemplate: { updateMany: vi.fn(async () => { H.templateWrites++; return { count: 0 }; }) },
  },
  decryptCredentials: vi.fn(() => ({})),
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

const ENTRY_ID = "100000000000001";
const WABA = "200000000000002";
const removal = (event: string, over: Record<string, unknown> = {}) => ({
  event,
  waba_info: { waba_id: WABA, owner_business_id: "300000000000003" },
  disconnection_info: { reason: "ACCOUNT_DISCONNECTED", initiated_by: "USER" },
  ...over,
});
const post = async (changes: any[], entryId = ENTRY_ID) => {
  const res = await request(app).post("/api/webhook").send({ object: "whatsapp_business_account", entry: [{ id: entryId, time: 1763392000, changes }] });
  await new Promise((r) => setTimeout(r, 20));
  return res;
};

beforeEach(() => {
  H.jobs = []; H.queueDown = false; H.templateWrites = 0;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("account_update: access removed", () => {
  it("★ PARTNER_REMOVED: one channel-health job naming the WABA inside the value", async () => {
    await post([{ field: "account_update", value: removal("PARTNER_REMOVED") }]);
    expect(H.jobs).toHaveLength(1);
    expect(H.jobs[0].name).toBe("whatsapp-access-removed");
    expect(H.jobs[0].data).toEqual({ type: "whatsapp_access_removed", wabaId: WABA, event: "PARTNER_REMOVED" });
    expect(H.jobs[0].opts).toMatchObject({ attempts: 5 });
  });

  it("★ never entry.id: it is a different id on this delivery, and it is nowhere in the job", async () => {
    await post([{ field: "account_update", value: removal("PARTNER_REMOVED") }]);
    expect(JSON.stringify(H.jobs)).not.toContain(ENTRY_ID);
  });

  it("a removal that names no WABA is not forwarded, even though entry.id is there", async () => {
    await post([{ field: "account_update", value: removal("PARTNER_REMOVED", { waba_info: undefined }) }]);
    await post([{ field: "account_update", value: removal("PARTNER_REMOVED", { waba_info: { owner_business_id: "300000000000003" } }) }]);
    expect(H.jobs).toEqual([]);
  });

  it("the two events Meta sent together are two jobs (the worker makes them one change)", async () => {
    await post([
      { field: "account_update", value: removal("PARTNER_APP_UNINSTALLED") },
      { field: "account_update", value: removal("PARTNER_REMOVED") },
    ]);
    expect(H.jobs.map((j) => j.data.event)).toEqual(["PARTNER_APP_UNINSTALLED", "PARTNER_REMOVED"]);
    expect(H.jobs.every((j) => j.data.wabaId === WABA)).toBe(true);
  });

  it.each([["PARTNER_ADDED"], ["PARTNER_APP_INSTALLED"], ["ACCOUNT_VIOLATION"], ["DISABLED_UPDATE"], ["VERIFIED_ACCOUNT"]])(
    "account_update %s is not a removal: nothing forwarded", async (event) => {
      await post([{ field: "account_update", value: removal(event) }]);
      expect(H.jobs).toEqual([]);
    });

  it.each([["messages"], ["message_template_status_update"], ["phone_number_quality_update"], ["account_alerts"], ["business_capability_update"]])(
    "the same value under field %s is not forwarded", async (field) => {
      await post([{ field, value: removal("PARTNER_REMOVED") }]);
      expect(H.jobs).toEqual([]);
    });

  it("the queue being down does not fail the delivery: Meta still gets its 200", async () => {
    H.queueDown = true;
    const res = await post([{ field: "account_update", value: removal("PARTNER_REMOVED") }]);
    expect(res.status).toBe(200);
    expect(H.jobs).toEqual([]);
    expect(JSON.stringify((console.error as any).mock.calls)).toContain("could not forward WhatsApp PARTNER_REMOVED");
  });

  it("a template update in the same entry is still handled", async () => {
    await post([
      { field: "account_update", value: removal("PARTNER_REMOVED") },
      { field: "message_template_status_update", value: { event: "APPROVED", message_template_name: "t", message_template_language: "en" } },
    ]);
    expect(H.jobs).toHaveLength(1);
  });
});
