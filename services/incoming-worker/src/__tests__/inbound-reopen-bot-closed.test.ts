/**
 * The customer's next message carries on the conversation the bot closed (2026-11-19). Before: every
 * message after a close started a brand-new conversation (incoming.worker), so a bot that closes for
 * silence would have split one customer's thread at every pause. Never a conversation a person closed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ convs: [] as any[], msgs: [] as any[], created: [] as any[], locks: 0 }));

vi.mock("@chatcenter/shared", async () => {
  const tx = {
    $executeRaw: async () => { H.locks++; },
    conversation: {
      findFirst: async (a: any) => {
        const w = a.where;
        const rows = H.convs.filter((c) =>
          (w.id == null || c.id === w.id) && c.tenantId === w.tenantId
          && (w.channel == null || c.channel === w.channel)
          && (w.customerExternalId == null || c.customerExternalId === w.customerExternalId)
          && (w.channelAccountId == null || c.channelAccountId === w.channelAccountId)
          && (w.status == null || (typeof w.status === "string" ? c.status === w.status : c.status !== w.status.not)));
        return rows.sort((x, y) => +y.createdAt - +x.createdAt)[0] ?? null;
      },
      updateMany: async (a: any) => {
        const rows = H.convs.filter((c) => c.id === a.where.id && c.tenantId === a.where.tenantId && c.status === a.where.status);
        rows.forEach((c) => Object.assign(c, a.data));
        return { count: rows.length };
      },
      create: async (a: any) => { const c = { id: `new${H.created.length + 1}`, status: "OPEN", createdAt: new Date(), ...a.data }; H.created.push(c); H.convs.push(c); return c; },
    },
    message: {
      findFirst: async (a: any) => H.msgs.filter((m) => m.conversationId === a.where.conversationId && m.messageType === a.where.messageType).sort((x, y) => +y.createdAt - +x.createdAt)[0] ?? null,
    },
  };
  return { prisma: { $transaction: async (fn: any) => fn(tx) }, getRedis: () => ({}) };
});

import { findOrCreateOpenConversation } from "../services/inbound-dedupe";
import { BOT_CLOSE_REOPEN_DAYS } from "@chatcenter/shared/src/lib/bot-idle";

const DAY = 24 * 60 * 60_000;
const ago = (ms: number) => new Date(Date.now() - ms);
const closedConv = (id: string, closedDaysAgo: number, over: any = {}) => ({
  id, tenantId: "T", channel: "WHATSAPP", customerExternalId: "972541111111", channelAccountId: "ca1", status: "CLOSED",
  createdAt: ago((closedDaysAgo + 1) * DAY), closedAt: ago(closedDaysAgo * DAY), reminderSentAt: ago(closedDaysAgo * DAY + 15 * 60_000), ...over,
});
const botClose = (conversationId: string, daysAgo: number, reason = "bot_idle") =>
  H.msgs.push({ conversationId, messageType: "system", createdAt: ago(daysAgo * DAY - 500), metadata: { systemEvent: "auto_closed", reason } });
const run = (over: any = {}) => findOrCreateOpenConversation<any>({
  tenantId: "T", channel: "WHATSAPP", customerExternalId: "972541111111", accountScope: { channelAccountId: "ca1" },
  create: { tenantId: "T", channel: "WHATSAPP", customerExternalId: "972541111111", channelAccountId: "ca1" },
  reopenBotClosedDays: BOT_CLOSE_REOPEN_DAYS, ...over,
});

beforeEach(() => { H.convs = []; H.msgs = []; H.created = []; H.locks = 0; });

describe("a message after the bot's close", () => {
  it("★ closed for silence yesterday: the same conversation, open again, no new one", async () => {
    H.convs = [closedConv("c1", 1)];
    botClose("c1", 1);
    const r = await run();
    expect(r).toMatchObject({ created: false, reopened: true, conversation: { id: "c1", status: "OPEN", closedAt: null, reminderSentAt: null } });
    expect(H.created).toHaveLength(0);
    expect(H.locks).toBe(1);
  });

  it("★ the customer ended it (\"תודה\") and wrote again an hour later: the same conversation", async () => {
    H.convs = [closedConv("c1", 1 / 24)];
    botClose("c1", 1 / 24, "customer_ended");
    expect(await run()).toMatchObject({ created: false, reopened: true, conversation: { id: "c1" } });
  });

  it("★ a person closed it: a new conversation, the closed one stays closed", async () => {
    H.convs = [closedConv("c1", 1)];
    const r = await run();
    expect(r).toMatchObject({ created: true, conversation: { id: "new1" } });
    expect(r.reopened).toBeUndefined();
    expect(H.convs.find((c) => c.id === "c1").status).toBe("CLOSED");
  });

  it("★ the bot's close is older than 7 days: a new conversation", async () => {
    H.convs = [closedConv("c1", 8)];
    botClose("c1", 8);
    expect(await run()).toMatchObject({ created: true, conversation: { id: "new1" } });
    expect(H.convs.find((c) => c.id === "c1").status).toBe("CLOSED");
  });

  it("★ only the customer's newest conversation counts: an older bot close under a newer person's close is not reopened", async () => {
    H.convs = [closedConv("old", 3), closedConv("newer", 1)];
    botClose("old", 3);
    expect(await run()).toMatchObject({ created: true, conversation: { id: "new1" } });
    expect(H.convs.find((c) => c.id === "old").status).toBe("CLOSED");
  });

  it("an open conversation is used as before, whatever was closed earlier", async () => {
    H.convs = [closedConv("c1", 2), { ...closedConv("open", 0), status: "WAITING", closedAt: null, createdAt: ago(60_000) }];
    botClose("c1", 2);
    expect(await run()).toMatchObject({ created: false, conversation: { id: "open" } });
    expect(H.convs.find((c) => c.id === "c1").status).toBe("CLOSED");
  });

  it("★ another number of the same channel, another customer or another tenant: not this customer's conversation", async () => {
    H.convs = [closedConv("other_number", 1, { channelAccountId: "ca2" }), closedConv("other_customer", 1, { customerExternalId: "972549999999" }), closedConv("other_tenant", 1, { tenantId: "T2" })];
    for (const c of H.convs) botClose(c.id, 1);
    expect(await run()).toMatchObject({ created: true, conversation: { id: "new1" } });
    expect(H.convs.filter((c) => c.status === "CLOSED")).toHaveLength(3);
  });

  it("★ the owner's own conversation (no reopen asked): a new one, as before", async () => {
    H.convs = [closedConv("c1", 1)];
    botClose("c1", 1);
    expect(await run({ reopenBotClosedDays: null })).toMatchObject({ created: true, conversation: { id: "new1" } });
    expect(await run({ reopenBotClosedDays: undefined })).toMatchObject({ created: false, conversation: { id: "new1" } });
    expect(H.convs.find((c) => c.id === "c1").status).toBe("CLOSED");
  });
});
