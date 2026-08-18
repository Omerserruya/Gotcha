import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";
import request from "supertest";
import express from "express";

/**
 * The history webhook, end to end through the real route.
 *
 * Meta delivers a business's past conversations ONCE, in the minutes after
 * Coexistence onboarding, and will not send them again. That makes this
 * endpoint unusually unforgiving: a payload dropped here is history the
 * customer can only recover by offboarding and completing Embedded Signup a
 * second time.
 *
 * Real HMACs rather than a mocked verifier, matching the Instagram test in this
 * directory. The signature gate is the thing most likely to silently reject
 * this new field, and a mocked verifier would pass code that Meta would not.
 */

const FB_SECRET = "fb-app-secret-939a58";
const BUSINESS = "972500000000";
const CUSTOMER = "972541111111";

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
  app.use(
    express.json({
      verify: (req: any, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );
  app.use("/api/webhook", router);
  return app;
}

function sign(secret: string, body: string) {
  return "sha256=" + crypto.createHmac("sha256", secret).update(Buffer.from(body)).digest("hex");
}

function historyBody(overrides: { progress?: number; errors?: any[] } = {}) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_1",
        changes: [
          {
            field: "history",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: BUSINESS, phone_number_id: "PN_1" },
              history: [
                {
                  metadata: { phase: 1, chunk_order: 4, progress: overrides.progress ?? 55 },
                  ...(overrides.errors ? { errors: overrides.errors } : {}),
                  threads: overrides.errors
                    ? undefined
                    : [
                        {
                          id: CUSTOMER,
                          messages: [
                            {
                              from: CUSTOMER,
                              to: BUSINESS,
                              id: "wamid.H1",
                              timestamp: "1760000000",
                              type: "text",
                              text: { body: "do you deliver to Haifa?" },
                              history_context: { status: "DELIVERED" },
                            },
                            {
                              from: BUSINESS,
                              to: CUSTOMER,
                              id: "wamid.H2",
                              timestamp: "1760000060",
                              type: "text",
                              text: { body: "yes, 3 to 5 business days" },
                              history_context: { status: "READ" },
                            },
                          ],
                        },
                      ],
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

async function post(body: unknown, secret = FB_SECRET) {
  const raw = JSON.stringify(body);
  return request(makeApp())
    .post("/api/webhook")
    .set("x-hub-signature-256", sign(secret, raw))
    .set("content-type", "application/json")
    .send(raw);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.WHATSAPP_APP_SECRET = FB_SECRET;
  channelAccount.findFirst.mockResolvedValue({ id: "ca1", tenantId: "t1" });
  channelAccount.findMany.mockResolvedValue([]);
});

describe("a history delivery is accepted and handed off", () => {
  it("acknowledges immediately, before any work happens", async () => {
    // Meta expects a fast 200 and redelivers on anything else. A chunk can
    // carry thousands of messages, so the work cannot happen in the request.
    const res = await post(historyBody());
    expect(res.status).toBe(200);
  });

  it("enqueues the chunk under its own job name", async () => {
    await post(historyBody());
    await vi.waitFor(() => expect(queueAdd).toHaveBeenCalled());

    const call = queueAdd.mock.calls.find((c) => c[0] === "process-history");
    expect(call, "no process-history job was enqueued").toBeTruthy();
    expect(call![1]).toMatchObject({
      tenantId: "t1",
      channelAccountId: "ca1",
      source: "WHATSAPP_BUSINESS_APP",
    });
  });

  it("carries the counters the pipeline needs to sequence and finish", async () => {
    await post(historyBody({ progress: 55 }));
    await vi.waitFor(() => expect(queueAdd).toHaveBeenCalled());

    const chunk = queueAdd.mock.calls.find((c) => c[0] === "process-history")![1].chunk;
    expect(chunk).toMatchObject({ phase: 1, chunkOrder: 4, progress: 55, threadCount: 1 });
  });

  it("normalizes both directions of the thread", async () => {
    await post(historyBody());
    await vi.waitFor(() => expect(queueAdd).toHaveBeenCalled());

    const chunk = queueAdd.mock.calls.find((c) => c[0] === "process-history")![1].chunk;
    expect(chunk.messages).toHaveLength(2);
    expect(chunk.messages[0]).toMatchObject({
      externalMessageId: "wamid.H1",
      direction: "INBOUND",
      customerExternalId: CUSTOMER,
      body: "do you deliver to Haifa?",
    });
    expect(chunk.messages[1]).toMatchObject({
      externalMessageId: "wamid.H2",
      direction: "OUTBOUND",
      customerExternalId: CUSTOMER,
    });
  });

  it("retries more persistently than the live paths do", async () => {
    // Meta grants ONE history sync per onboarding. A chunk lost because Redis
    // blinked is history the customer cannot get back without offboarding and
    // repeating Embedded Signup, so this queue is worth more attempts than an
    // inbound message that the sender can simply resend.
    await post(historyBody());
    await vi.waitFor(() => expect(queueAdd).toHaveBeenCalled());

    const opts = queueAdd.mock.calls.find((c) => c[0] === "process-history")![2];
    expect(opts.attempts).toBeGreaterThan(3);
  });
});

describe("history never enters the live pipeline", () => {
  it("enqueues no `process` job and no `process-echo` job", async () => {
    // The property the whole feature rests on. A `process` job here would put
    // a message from last March through the bot.
    await post(historyBody());
    await vi.waitFor(() => expect(queueAdd).toHaveBeenCalled());

    const names = queueAdd.mock.calls.map((c) => c[0]);
    expect(names).toContain("process-history");
    expect(names).not.toContain("process");
    expect(names).not.toContain("process-echo");
    expect(names).not.toContain("process-comment");
  });
});

describe("a business that declined is still delivered", () => {
  it("enqueues the decline so the import can record it honestly", async () => {
    // Meta says "history sharing is turned off". That is an ANSWER and has to
    // reach the pipeline, otherwise the import sits at PENDING until the 24
    // hour watchdog fails it for the wrong reason.
    await post(
      historyBody({
        errors: [
          {
            code: 2593109,
            title: "History sync is turned off by the business from the WhatsApp Business App",
            error_data: { details: "History sharing is turned off by the business" },
          },
        ],
      }),
    );
    await vi.waitFor(() => expect(queueAdd).toHaveBeenCalled());

    const chunk = queueAdd.mock.calls.find((c) => c[0] === "process-history")![1].chunk;
    expect(chunk.unavailable).toMatchObject({ code: 2593109 });
    expect(chunk.messages).toHaveLength(0);
  });
});

describe("the signature gate still applies", () => {
  it("drops a history payload signed with the wrong secret", async () => {
    await post(historyBody(), "not-the-right-secret");
    // Give the async handler a chance to have done the wrong thing.
    await new Promise((r) => setTimeout(r, 30));
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("drops it when no channel account matches the number", async () => {
    channelAccount.findFirst.mockResolvedValue(null);
    await post(historyBody());
    await new Promise((r) => setTimeout(r, 30));
    expect(queueAdd).not.toHaveBeenCalled();
  });
});
