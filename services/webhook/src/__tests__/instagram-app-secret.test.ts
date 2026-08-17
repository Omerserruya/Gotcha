import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import request from "supertest";
import express from "express";

/**
 * GOTCHA talks to Meta through TWO apps. WhatsApp and Messenger live in the
 * Facebook app; Instagram is connected through Instagram Login, which is a
 * separate app with its own id and its own secret. Meta signs each delivery
 * with the secret of the app that owns the subscription.
 *
 * The webhook verified everything with the Facebook secret, so every Instagram
 * message failed the HMAC and was dropped fail-closed - while the connect flow,
 * the subscription and the channel row all looked healthy, because those run in
 * the auth service, which does have the Instagram secret. Confirmed in
 * production 2026-08-16: `Rejected INSTAGRAM webhook: signature mismatch`
 * moments after a real customer DM reached us.
 *
 * These use REAL HMACs rather than a mocked verifier, because the bug was
 * precisely about which key the HMAC is computed with - a mock would have
 * happily passed the broken code.
 */

const FB_SECRET = "fb-app-secret-939a58";
const IG_SECRET = "ig-app-secret-a2c1c3";

const { channelAccount, queueAdd } = vi.hoisted(() => ({
  channelAccount: { findFirst: vi.fn(), findMany: vi.fn() },
  queueAdd: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return {
    ...actual,
    prisma: { channelAccount, message: { findFirst: vi.fn(), update: vi.fn() } },
    incomingMessageQueue: { add: queueAdd },
    publishEvent: vi.fn().mockResolvedValue(undefined),
    crossTenantMiddleware: (_req: any, _res: any, next: any) => next(),
    reportOperationalFailure: vi.fn(),
  };
});

import router from "../routes/webhook";

function makeApp() {
  const app = express();
  app.use(express.json({
    verify: (req: any, _res, buf) => { req.rawBody = buf; },
  }));
  app.use("/api/webhook", router);
  return app;
}

function sign(secret: string, body: string) {
  return "sha256=" + crypto.createHmac("sha256", secret).update(Buffer.from(body)).digest("hex");
}

const IG_BODY = {
  object: "instagram",
  entry: [{
    time: 1786858539143,
    id: "17841405721255029",
    messaging: [{
      sender: { id: "2138699903377017" },
      recipient: { id: "17841405721255029" },
      timestamp: 1786858537258,
      message: { mid: "ig_mid_1", text: "היי" },
    }],
  }],
};

const WA_BODY = {
  object: "whatsapp_business_account",
  entry: [{
    id: "WABA_1",
    changes: [{
      field: "messages",
      value: {
        metadata: { phone_number_id: "PN_1" },
        contacts: [{ profile: { name: "Dana" } }],
        messages: [{ from: "972541111111", id: "wamid.1", timestamp: "1760000000", type: "text", text: { body: "hi" } }],
      },
    }],
  }],
};

async function post(body: any, secret: string) {
  const raw = JSON.stringify(body);
  const res = await request(makeApp())
    .post("/api/webhook")
    .set("Content-Type", "application/json")
    .set("x-hub-signature-256", sign(secret, raw))
    .send(raw);
  // The handler answers 200 before doing the work, so wait for the async tail.
  await new Promise((r) => setTimeout(r, 60));
  return res;
}

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.WHATSAPP_APP_SECRET = FB_SECRET;
  process.env.META_APP_SECRET = FB_SECRET;
  process.env.INSTAGRAM_APP_SECRET = IG_SECRET;
  channelAccount.findFirst.mockResolvedValue({ id: "ca-1", tenantId: "tenant-1", externalId: "17841405721255029" });
  channelAccount.findMany.mockResolvedValue([]);
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("Meta webhook signature - two apps, two secrets", () => {
  it("accepts an Instagram delivery signed with the INSTAGRAM app secret", async () => {
    // The regression. Signed by the IG app, verified against the FB app's
    // secret, dropped - with the channel still showing CONNECTED.
    await post(IG_BODY, IG_SECRET);

    expect(queueAdd).toHaveBeenCalledWith(
      "process",
      expect.objectContaining({
        channel: "INSTAGRAM",
        normalizedMessage: expect.objectContaining({ body: "היי" }),
      }),
      expect.any(Object),
    );
  });

  it("still accepts WhatsApp signed with the Facebook app secret", async () => {
    await post(WA_BODY, FB_SECRET);

    expect(queueAdd).toHaveBeenCalledWith(
      "process",
      expect.objectContaining({ channel: "WHATSAPP" }),
      expect.any(Object),
    );
  });

  it("accepts Instagram signed with the Facebook secret too, for a single-app workspace", async () => {
    // Some deployments run one Meta app for everything. Trying both keys is
    // what makes the fix correct in that layout as well as the two-app one.
    await post(IG_BODY, FB_SECRET);

    expect(queueAdd).toHaveBeenCalledWith("process", expect.objectContaining({ channel: "INSTAGRAM" }), expect.any(Object));
  });

  it("still rejects a signature from neither app - the gate is not weakened", async () => {
    await post(IG_BODY, "some-other-secret");

    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("still rejects when no signature header is sent at all", async () => {
    const raw = JSON.stringify(IG_BODY);
    await request(makeApp()).post("/api/webhook").set("Content-Type", "application/json").send(raw);
    await new Promise((r) => setTimeout(r, 60));

    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("rejects Instagram when only the Facebook secret is configured and the IG app signed", async () => {
    // The exact production state before the config half of the fix: the code
    // knows to try the Instagram secret, but the container was never given one.
    delete process.env.INSTAGRAM_APP_SECRET;

    await post(IG_BODY, IG_SECRET);

    expect(queueAdd).not.toHaveBeenCalled();
  });
});
