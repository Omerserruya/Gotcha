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
  ({ id, tenantId, channel: "OUTLOOK", isActive, platformMeta: meta, externalId: `${id}@shop.test`, credentials: { accessToken: `at_${id}` } });
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
/** What Graph answers for a message id (2026-10-14: the route reads the message itself). */
const graph = vi.hoisted(() => ({ messages: {} as Record<string, any>, calls: [] as Array<{ url: string; auth: string }> }));
const graphMessage = (id: string, o: any = {}) => ({
  id, subject: "Order 1234", isDraft: false,
  from: { emailAddress: { address: "dana@customer.test", name: "Dana Buyer" } },
  uniqueBody: { content: "Where is my order?" }, body: { content: "Where is my order?\n\n> earlier" },
  internetMessageId: "<cust-1@customer.test>", conversationId: "conv_AAQ",
  internetMessageHeaders: [{ name: "References", value: "<first@shop.test>" }, { name: "In-Reply-To", value: "<first@shop.test>" }],
  ...o,
});
beforeEach(() => {
  vi.clearAllMocks();
  graph.messages = { msg_1: graphMessage("msg_1") };
  graph.calls = [];
  vi.stubGlobal("fetch", async (url: any, init: any) => {
    const u = String(url);
    graph.calls.push({ url: u, auth: String(init?.headers?.Authorization ?? "") });
    const id = decodeURIComponent(u.split("/me/messages/")[1]?.split("?")[0] ?? "");
    const m = graph.messages[id];
    return m ? new Response(JSON.stringify(m), { status: 200 }) : new Response("{}", { status: 404 });
  });
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
  vi.unstubAllGlobals();
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
    graph.messages = { m_a: graphMessage("m_a"), m_b: graphMessage("m_b") };
    await post([note("sub_a", STATE_A, "m_a"), note("sub_b", STATE_B, "m_b")]);
    await settle();
    const queued = queueAdd.mock.calls.map((c) => [c[1].channelAccountId, c[1].normalizedMessage.externalMessageId]);
    expect(queued).toEqual([["ca_a", "m_a"], ["ca_b", "m_b"]]);
    // Each mailbox is read with its own token.
    expect(graph.calls.map((c) => c.auth)).toEqual(["Bearer at_ca_a", "Bearer at_ca_b"]);
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

describe("★ the message itself, read from Graph (2026-10-14)", () => {
  // Was: the Graph path as the sender and "[Outlook notification]" as the text.
  it("★ the real sender, subject and text, and the ids a reply needs", async () => {
    await post([note("sub_a", STATE_A)]);
    await settle();
    expect(graph.calls[0]!.url).toMatch(/\/me\/messages\/msg_1\?\$select=.*internetMessageHeaders/);
    expect(graph.calls[0]!.auth).toBe("Bearer at_ca_a");
    expect(queueAdd).toHaveBeenCalledTimes(1);
    expect(queueAdd.mock.calls[0][1].normalizedMessage).toMatchObject({
      externalMessageId: "msg_1",
      senderId: "dana@customer.test",
      senderDisplayName: "Dana Buyer",
      subject: "Order 1234",
      // The reply's own text, not the quoted history.
      body: "Where is my order?",
      messageType: "email",
      metadata: { email: { messageIdHeader: "<cust-1@customer.test>", references: ["<first@shop.test>"], subject: "Order 1234", threadId: "conv_AAQ", providerMessageId: "msg_1" } },
    });
  });

  it("★ a bounce, an auto-reply or bulk mail is not taken, and the log says why", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    graph.messages = {
      b1: graphMessage("b1", { from: { emailAddress: { address: "MAILER-DAEMON@outlook.com", name: "Mail Delivery System" } } }),
      b2: graphMessage("b2", { internetMessageHeaders: [{ name: "Auto-Submitted", value: "auto-replied" }] }),
      b3: graphMessage("b3", { internetMessageHeaders: [{ name: "Precedence", value: "bulk" }] }),
    };
    await post([note("sub_a", STATE_A, "b1"), note("sub_a", STATE_A, "b2"), note("sub_a", STATE_A, "b3")]);
    await settle();
    expect(queueAdd).not.toHaveBeenCalled();
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines).toEqual(expect.arrayContaining([
      expect.stringContaining("message b1 not taken: mailer_daemon"),
      expect.stringContaining("message b2 not taken: auto_submitted"),
      expect.stringContaining("message b3 not taken: precedence"),
    ]));
    log.mockRestore();
  });

  it("the account's own mail, a draft, or a message Graph cannot find is not taken", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    graph.messages = {
      own: graphMessage("own", { from: { emailAddress: { address: "CA_A@shop.test" } } }),
      draft: graphMessage("draft", { isDraft: true }),
    };
    await post([note("sub_a", STATE_A, "own"), note("sub_a", STATE_A, "draft"), note("sub_a", STATE_A, "gone")]);
    await settle();
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("only new messages: an updated one is not read", async () => {
    await post([{ ...note("sub_a", STATE_A), changeType: "updated" }]);
    await settle();
    expect(graph.calls).toEqual([]);
    expect(queueAdd).not.toHaveBeenCalled();
  });
});
