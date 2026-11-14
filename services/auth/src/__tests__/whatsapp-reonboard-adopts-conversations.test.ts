/**
 * Prod GOTCHA 2026-11-14: the number was removed (health.service deletes the
 * channel row; conversations are SET NULL) and onboarded again on 11-10 as a
 * NEW row. Nothing re-pointed the old conversations, so 237 open ones could
 * not be answered from the inbox. Onboarding now adopts them, when the new
 * account is the tenant's only active WhatsApp account.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  accounts: [] as any[],
  conversations: [] as any[],
  failAdopt: false,
  sql: [] as string[],
}));
vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  const prisma = {
    channelAccount: {
      findUnique: vi.fn(async (a: any) => H.accounts.find((x) => x.channel === a.where.channel_externalId.channel && x.externalId === a.where.channel_externalId.externalId) ?? null),
      findMany: vi.fn(async (a: any) => H.accounts.filter((x) => x.tenantId === a.where.tenantId && x.channel === a.where.channel
        && (a.where.isActive === undefined || x.isActive === a.where.isActive) && (a.where.id?.not === undefined || x.id !== a.where.id.not))
        .slice(0, a.take ?? 99).map((x) => ({ id: x.id }))),
      create: vi.fn(async (a: any) => { const row = { id: "ca_new", ...a.data }; H.accounts.push(row); return row; }),
      update: vi.fn(async (a: any) => Object.assign(H.accounts.find((x) => x.id === a.where.id), a.data)),
    },
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...v: any[]) => {
      if (H.failAdopt) throw new Error("db blip");
      H.sql.push(strings.join("?"));
      const hits = H.conversations.filter((c) => c.tenantId === v[1] && c.channel === v[2] && c.channelAccountId === null);
      hits.forEach((c) => { c.channelAccountId = v[0]; });
      return hits.length;
    }),
    whatsAppNumber: { upsert: vi.fn(async (a: any) => ({ id: "wn1", ...a.create })) },
    conversation: {
      updateMany: vi.fn(async (a: any) => {
        if (H.failAdopt) throw new Error("db blip");
        const hits = H.conversations.filter((c) => c.tenantId === a.where.tenantId && c.channel === a.where.channel && c.channelAccountId === a.where.channelAccountId);
        hits.forEach((c) => Object.assign(c, a.data));
        return { count: hits.length };
      }),
    },
  };
  return { ...actual, prisma, encryptCredentials: (v: any) => v };
});

import { upsertNumberRecord } from "../services/whatsapp/onboarding.service";

const onboard = () => upsertNumberRecord({
  tenantId: "gotcha", userId: "u1", accessToken: "at", phoneNumberId: "1215458558322656", wabaId: "waba1", flow: "COEXISTENCE" as any,
  inspected: { displayPhoneNumber: "+972 55-263-3304" } as any,
});
const conv = (id: string, o: any = {}) => ({ id, tenantId: "gotcha", channel: "WHATSAPP", channelAccountId: null, ...o });

beforeEach(() => {
  H.accounts = []; H.failAdopt = false; H.sql = [];
  H.conversations = [conv("cmsztwsru0hytz6dblovgaqdd"), conv("old2", { status: "CLOSED" }), conv("gmail", { channel: "GMAIL" }), conv("other", { tenantId: "t2" })];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("★ re-onboarding a removed number adopts the conversations its old row left detached", () => {
  it("★ the prod case: a new channel row, every detached WhatsApp conversation of the tenant re-pointed to it", async () => {
    const { channelAccount } = await onboard();
    expect(channelAccount.id).toBe("ca_new");
    const by = Object.fromEntries(H.conversations.map((c) => [c.id, c.channelAccountId]));
    expect(by).toEqual({ cmsztwsru0hytz6dblovgaqdd: "ca_new", old2: "ca_new", gmail: null, other: null });
  });

  it("★ updated_at is never written: one raw UPDATE without it, no Prisma updateMany (whose @updatedAt would stamp every row)", async () => {
    const shared: any = await import("@chatcenter/shared");
    await onboard();
    expect(H.sql).toHaveLength(1);
    expect(H.sql[0]).not.toMatch(/updated_at/i);
    expect(shared.prisma.conversation.updateMany).not.toHaveBeenCalled();
  });

  it("an existing row being reconnected adopts them too", async () => {
    H.accounts.push({ id: "ca_same", tenantId: "gotcha", channel: "WHATSAPP", externalId: "1215458558322656", isActive: false, connectedAt: null, platformMeta: null });
    await onboard();
    expect(H.conversations[0].channelAccountId).toBe("ca_same");
  });

  it("control: a second active WhatsApp number in the tenant: nothing is moved", async () => {
    H.accounts.push({ id: "ca_second", tenantId: "gotcha", channel: "WHATSAPP", externalId: "999", isActive: true });
    await onboard();
    expect(H.conversations.every((c) => c.channelAccountId === null)).toBe(true);
  });

  it("a failed adopt never fails the onboarding", async () => {
    H.failAdopt = true;
    const { channelAccount } = await onboard();
    expect(channelAccount.id).toBe("ca_new");
    expect(H.conversations[0].channelAccountId).toBeNull();
  });
});
