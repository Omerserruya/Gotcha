/**
 * Prod GOTCHA 2026-11-14: a re-onboarded WhatsApp number got a new channel
 * row and 237 open conversations stayed on NULL. The helpers re-point a
 * detached conversation only to the tenant's ONE active account on that
 * channel; with none or several nothing changes.
 */
import { describe, it, expect } from "vitest";
import { singleActiveChannelAccountId, adoptDetachedConversations, attachConversationAccount } from "../channel-account-reattach";

function store(accounts: any[], conversations: any[]) {
  const matchAcc = (a: any, w: any) => a.tenantId === w.tenantId && a.channel === w.channel
    && (w.isActive === undefined || a.isActive === w.isActive)
    && (w.connectionStatus === undefined || a.connectionStatus === w.connectionStatus)
    && (w.id?.not === undefined || a.id !== w.id.not);
  const matchConv = (c: any, w: any) => (w.id === undefined || c.id === w.id) && c.tenantId === w.tenantId
    && (w.channel === undefined || c.channel === w.channel)
    && (w.channelAccountId === undefined || c.channelAccountId === w.channelAccountId);
  return {
    accounts, conversations,
    channelAccount: { findMany: async (a: any) => accounts.filter((x) => matchAcc(x, a.where)).slice(0, a.take ?? 99).map((x) => ({ id: x.id })) },
    conversation: {
      updateMany: async (a: any) => {
        const hits = conversations.filter((c) => matchConv(c, a.where));
        hits.forEach((c) => Object.assign(c, a.data));
        return { count: hits.length };
      },
    },
  };
}
const acc = (id: string, o: any = {}) => ({ id, tenantId: "gotcha", channel: "WHATSAPP", isActive: true, connectionStatus: "CONNECTED", ...o });
const conv = (id: string, o: any = {}) => ({ id, tenantId: "gotcha", channel: "WHATSAPP", channelAccountId: null, ...o });

describe("singleActiveChannelAccountId", () => {
  it("one active connected account: its id", async () => {
    expect(await singleActiveChannelAccountId(store([acc("ca_new")], []) as any, "gotcha", "WHATSAPP")).toBe("ca_new");
  });
  it("two: null (ambiguous, not ours to pick)", async () => {
    expect(await singleActiveChannelAccountId(store([acc("a"), acc("b")], []) as any, "gotcha", "WHATSAPP")).toBeNull();
  });
  it("none, or only disconnected / inactive ones: null", async () => {
    const s = store([acc("a", { connectionStatus: "DISCONNECTED" }), acc("b", { isActive: false })], []);
    expect(await singleActiveChannelAccountId(s as any, "gotcha", "WHATSAPP")).toBeNull();
  });
  it("another tenant's or another channel's account never counts", async () => {
    const s = store([acc("x", { tenantId: "other" }), acc("g", { channel: "GMAIL" })], []);
    expect(await singleActiveChannelAccountId(s as any, "gotcha", "WHATSAPP")).toBeNull();
  });
});

describe("★ adoptDetachedConversations: the re-onboarded number takes the conversations its old row left", () => {
  it("★ the prod case: every detached WhatsApp conversation of the tenant, and nothing else", async () => {
    const s = store([acc("ca_new", { connectionStatus: "PENDING" })], [
      conv("c1"), conv("c2"), conv("closed", { status: "CLOSED" }),
      conv("attached", { channelAccountId: "ca_old_other" }),
      conv("gmail", { channel: "GMAIL" }),
      conv("other-tenant", { tenantId: "other" }),
    ]);
    expect(await adoptDetachedConversations(s as any, { tenantId: "gotcha", channel: "WHATSAPP", channelAccountId: "ca_new" })).toBe(3);
    const by = Object.fromEntries(s.conversations.map((c) => [c.id, c.channelAccountId]));
    expect(by).toEqual({ c1: "ca_new", c2: "ca_new", closed: "ca_new", attached: "ca_old_other", gmail: null, "other-tenant": null });
  });
  it("still PENDING is fine: onboarding proves the new account later, so only OTHER active accounts block", async () => {
    const s = store([acc("ca_new", { connectionStatus: "PENDING" })], [conv("c1")]);
    expect(await adoptDetachedConversations(s as any, { tenantId: "gotcha", channel: "WHATSAPP", channelAccountId: "ca_new" })).toBe(1);
  });
  it("control: a second active number on the channel: nothing moves (which number answered them is unknown)", async () => {
    const s = store([acc("ca_new"), acc("ca_second")], [conv("c1")]);
    expect(await adoptDetachedConversations(s as any, { tenantId: "gotcha", channel: "WHATSAPP", channelAccountId: "ca_new" })).toBe(0);
    expect(s.conversations[0].channelAccountId).toBeNull();
  });
  it("an inactive old row does not block", async () => {
    const s = store([acc("ca_new"), acc("ca_gone", { isActive: false, connectionStatus: "DISCONNECTED" })], [conv("c1")]);
    expect(await adoptDetachedConversations(s as any, { tenantId: "gotcha", channel: "WHATSAPP", channelAccountId: "ca_new" })).toBe(1);
  });
});

describe("attachConversationAccount", () => {
  it("attaches a detached conversation of the tenant", async () => {
    const s = store([], [conv("c1")]);
    expect(await attachConversationAccount(s as any, { tenantId: "gotcha", conversationId: "c1", channelAccountId: "ca_new" })).toBe(true);
    expect(s.conversations[0].channelAccountId).toBe("ca_new");
  });
  it("control: never overwrites an attached one, never crosses tenants", async () => {
    const s = store([], [conv("c1", { channelAccountId: "ca_keep" }), conv("c2", { tenantId: "other" })]);
    expect(await attachConversationAccount(s as any, { tenantId: "gotcha", conversationId: "c1", channelAccountId: "x" })).toBe(false);
    expect(await attachConversationAccount(s as any, { tenantId: "gotcha", conversationId: "c2", channelAccountId: "x" })).toBe(false);
    expect(s.conversations.map((c) => c.channelAccountId)).toEqual(["ca_keep", null]);
  });
});
