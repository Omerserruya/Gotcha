import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";

/**
 * ★ Outlook notifications are checked against the clientState stored on the
 * account their subscriptionId names (2026-10-09).
 *
 * auth created each Graph subscription with a random clientState and dropped
 * it, while this route compared every notification with one env value, so no
 * notification could ever pass. Now auth stores it in platformMeta and this
 * route compares per notification, timing-safe, with the REAL comparator and
 * the REAL Outlook adapter. No account, no stored value or a mismatch drops
 * the whole delivery, in every environment; the env value is not a way in.
 */

const { channelAccount, queueAdd } = vi.hoisted(() => {
  const rows: any[] = [];
  return {
    channelAccount: {
      rows,
      // Honours `where`: equality on every key given.
      findMany: vi.fn(async ({ where }: any = {}) =>
        rows.filter((r) => Object.entries(where ?? {}).every(([k, v]) => r[k] === v)),
      ),
      findFirst: vi.fn(),
    },
    queueAdd: vi.fn().mockResolvedValue(undefined),
  };
});

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
  app.use(express.json());
  app.use("/api/webhook", router);
  return app;
}

const STATE_A = "a".repeat(64);
const STATE_B = "b".repeat(64);
const account = (id: string, tenantId: string, meta: Record<string, unknown>, isActive = true) =>
  ({ id, tenantId, channel: "OUTLOOK", isActive, platformMeta: meta });
const note = (subscriptionId: string, clientState: string | undefined, id = "msg_1") => ({
  subscriptionId,
  ...(clientState === undefined ? {} : { clientState }),
  changeType: "created",
  resource: `Users/u/Messages/${id}`,
  resourceData: { id, "@odata.id": `Users/u/Messages/${id}` },
});
const post = (value: any[]) => request(makeApp()).post("/api/webhook/outlook").send({ value });
/** The route answers 202 first and works after; let that work finish. */
const settle = () => new Promise((r) => setTimeout(r, 30));

const savedEnv = { ...process.env };
beforeEach(() => {
  vi.clearAllMocks();
  channelAccount.rows.length = 0;
  channelAccount.rows.push(
    account("ca_a", "tenant_a", { subscriptionId: "sub_a", clientState: STATE_A }),
    account("ca_b", "tenant_b", { subscriptionId: "sub_b", clientState: STATE_B }),
    account("ca_legacy", "tenant_c", { subscriptionId: "sub_legacy" }),
    account("ca_off", "tenant_d", { subscriptionId: "sub_off", clientState: STATE_A }, false),
  );
});
afterEach(() => {
  process.env = { ...savedEnv };
});

describe("★ Outlook clientState, per account", () => {
  it("Graph's validationToken handshake still echoes the token, with no lookup", async () => {
    const r = await request(makeApp()).post("/api/webhook/outlook?validationToken=abc%20123").send({});
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/plain/);
    expect(r.text).toBe("abc 123");
    expect(channelAccount.findMany).not.toHaveBeenCalled();
  });

  it("a notification carrying its account's stored clientState is queued for THAT account", async () => {
    const r = await post([note("sub_a", STATE_A)]);
    expect(r.status).toBe(202);
    await settle();
    expect(queueAdd).toHaveBeenCalledTimes(1);
    expect(queueAdd.mock.calls[0][1]).toMatchObject({ tenantId: "tenant_a", channel: "OUTLOOK", channelAccountId: "ca_a" });
  });

  it("the lookup is scoped as before: active OUTLOOK accounts", async () => {
    await post([note("sub_a", STATE_A)]);
    await settle();
    expect(channelAccount.findMany).toHaveBeenCalledWith({ where: { channel: "OUTLOOK", isActive: true } });
  });

  it("another account's clientState is a mismatch: dropped", async () => {
    await post([note("sub_a", STATE_B)]);
    await settle();
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("a clientState one character off is dropped", async () => {
    await post([note("sub_a", `${STATE_A.slice(0, -1)}b`)]);
    await settle();
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("no clientState on the notification: dropped", async () => {
    await post([note("sub_a", undefined)]);
    await settle();
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("an account with no stored clientState is dropped, and the old env value is no way in", async () => {
    process.env.OUTLOOK_WEBHOOK_CLIENT_STATE = "env-secret";
    await post([note("sub_legacy", "env-secret")]);
    await settle();
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("an unknown subscription is dropped", async () => {
    await post([note("sub_nobody", STATE_A)]);
    await settle();
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("an inactive account's subscription is dropped, even with its own clientState", async () => {
    await post([note("sub_off", STATE_A)]);
    await settle();
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("a batch from two mailboxes lands on each, not both on the first", async () => {
    await post([note("sub_a", STATE_A, "m_a"), note("sub_b", STATE_B, "m_b")]);
    await settle();
    const queued = queueAdd.mock.calls.map((c) => [c[1].channelAccountId, c[1].normalizedMessage.externalMessageId]);
    expect(queued).toEqual([["ca_a", "m_a"], ["ca_b", "m_b"]]);
  });

  it("one bad notification in a batch drops the whole delivery, as before", async () => {
    await post([note("sub_a", STATE_A, "m_a"), note("sub_b", STATE_A, "m_b")]);
    await settle();
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("an unknown subscription in a batch drops the whole delivery too", async () => {
    await post([note("sub_a", STATE_A, "m_a"), note("sub_nobody", STATE_A, "m_x")]);
    await settle();
    expect(queueAdd).not.toHaveBeenCalled();
  });
});
