/**
 * ★ Home chat stage 2, the query layer (docs/api/assistant-threads-v1.md §9):
 *   - days are the workspace's days (a conversation at 22:30 UTC is the next
 *     day in Jerusalem), and the chart's numbers are the counts, highlighted
 *     where they peak
 *   - only real conversations (no rehearsals, no test rows), the caller's
 *     visibility kept beside any other OR
 *   - breakdowns by channel / status / who handled them, with names in words
 *   - intent/sentiment only with their coverage ("unknown" is not recorded)
 *   - a mention finds conversations by what was SAID in the period, and lists
 *     them with links; the source can be replayed page by page
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ convs: [] as any[], intel: [] as any[], wheres: [] as any[] }));

function test(row: any, w: any): boolean {
  if (!w) return true;
  return Object.entries(w).every(([k, v]: [string, any]) => {
    if (k === "AND") return v.every((x: any) => test(row, x));
    if (k === "OR") return v.some((x: any) => test(row, x));
    if (k === "NOT") return !test(row, v);
    if (k === "messages") return (row.messages ?? []).some((m: any) => test(m, v.some));
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("in" in v) return v.in.includes(row[k]);
      if ("startsWith" in v) return String(row[k] ?? "").startsWith(v.startsWith);
      if ("contains" in v) return String(row[k] ?? "").toLowerCase().includes(String(v.contains).toLowerCase());
      if ("gte" in v || "lt" in v) return (!v.gte || row[k] >= v.gte) && (!v.lt || row[k] < v.lt);
      return true;
    }
    return (row[k] ?? null) === v;
  });
}

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    readDurableSetting: async () => JSON.stringify({ timezone: "Asia/Jerusalem", schedule: {} }),
    prisma: {
      conversation: {
        findMany: async (a: any) => {
          H.wheres.push(a.where);
          let rows = H.convs.filter((c) => test(c, a.where));
          rows = rows.sort((x, y) => y.createdAt - x.createdAt || (y.id > x.id ? 1 : -1));
          if (a.cursor) rows = rows.slice(rows.findIndex((r) => r.id === a.cursor.id) + (a.skip ?? 0));
          return rows.slice(0, a.take ?? 1e9);
        },
      },
      conversationIntelligence: { findMany: async (a: any) => H.intel.filter((i) => a.where.conversationId.in.includes(i.conversationId)) },
    },
  };
});

import { queryConversations, normalizeQuery, listConversationsForSource, dayStart, dayOf, sourceLink, INBOX_VIEW_ALL_LIVE } from "../services/assistant-query.service";

const D = (iso: string) => new Date(iso);
const conv = (id: string, createdAt: string, o: any = {}) => ({
  id, tenantId: "T", isTest: false, customerExternalId: `9725000${id}`, customerName: `Customer ${id}`, channel: "WHATSAPP", status: "CLOSED",
  handledBy: "ai_agent", isHandedOver: false, departmentId: null, assignedAgentId: null, createdAt: D(createdAt), lastMessageAt: D(createdAt), messages: [], ...o,
});
let n = 0;
const ctx = (o: any = {}) => ({ tenantId: "T", locale: "en" as const, nextId: (k: "b" | "s") => `${k}${++n}`, ...o });
const Q = (o: any = {}) => normalizeQuery({ from: "2026-10-01", to: "2026-10-07", ...o }) as any;

beforeEach(() => {
  n = 0; H.wheres = []; H.intel = [];
  H.convs = [
    conv("1", "2026-10-01T09:00:00Z"),
    conv("2", "2026-10-01T22:30:00Z"), // 01:30 on 2 October in Jerusalem
    conv("3", "2026-10-06T10:00:00Z", { channel: "SHOPIFY_LIVE_CHAT", status: "OPEN", handledBy: "human" }),
    conv("4", "2026-10-06T11:00:00Z", { channel: "WEBCHAT", status: "WAITING", isHandedOver: true }),
    conv("5", "2026-10-06T12:00:00Z", { handledBy: null }),
    conv("rehearsal", "2026-10-03T10:00:00Z", { customerExternalId: "sandbox:ag:1" }),
    conv("test", "2026-10-03T10:00:00Z", { isTest: true }),
    conv("old", "2026-09-20T10:00:00Z"),
  ];
});

describe("workspace days", () => {
  it("a Jerusalem day starts at 21:00 UTC the day before (summer time)", () => {
    expect(dayStart("2026-10-02", "Asia/Jerusalem").toISOString()).toBe("2026-10-01T21:00:00.000Z");
    expect(dayOf(D("2026-10-01T22:30:00Z"), "Asia/Jerusalem")).toBe("2026-10-02");
  });
});

describe("★ the chart by day", () => {
  it("counts real conversations per workspace day; the peak is highlighted", async () => {
    const r = await queryConversations(ctx(), Q({ groupBy: "day" }));
    const chart: any = r.blocks[0];
    expect(chart).toMatchObject({ type: "chart", kind: "bar", sourceId: "s1", unit: "count", partial: null });
    expect(chart.x.values).toEqual(["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"]);
    // Rehearsal and test rows (3 October) are not traffic; conv 2 is 2 October.
    expect(chart.series[0].values).toEqual([1, 1, 0, 0, 0, 3, 0]);
    expect(chart.highlight).toEqual(["2026-10-06"]);
    expect(r.summary).toMatchObject({ ok: true, cite: "s1", total: 5 });
    // The model is told what is on screen, so it never says it lacks the by-day split.
    expect((r.summary as any).cards).toEqual(["Conversations by day: a bar chart over 7 days"]);
    expect(String((r.summary as any).shownAs)).toMatch(/never say you lack a breakdown a card shows/);
    expect(r.source).toMatchObject({ id: "s1", kind: "conversations", count: 5, query: { tool: "conversations", params: { from: "2026-10-01", to: "2026-10-07", groupBy: "day" } } });
  });

  it("the caller's visibility stays beside the other filters", async () => {
    await queryConversations(ctx({ viewer: { userId: "u1", role: "AGENT", departmentId: "sales" } }), Q({ channels: ["WHATSAPP"] }));
    const w = H.wheres[0];
    expect(w.AND?.[0]?.OR).toBeTruthy();
    expect(w).toMatchObject({ isTest: false, NOT: { customerExternalId: { startsWith: "sandbox:" } }, channel: { in: ["WHATSAPP"] } });
  });
});

describe("★ breakdowns in words", () => {
  it("by channel and by who handled them", async () => {
    const ch: any = (await queryConversations(ctx(), Q({ groupBy: "channel" }))).blocks[0];
    expect(ch.items.map((i: any) => [i.key, i.label, i.value])).toEqual([["WHATSAPP", "WhatsApp", 3], ["SHOPIFY_LIVE_CHAT", "Shopify live chat", 1], ["WEBCHAT", "Web chat", 1]]);
    expect(ch.items[0].share).toBeCloseTo(0.6);
    expect(ch.total).toBe(5);
    const who: any = (await queryConversations(ctx({ locale: "he" }), Q({ groupBy: "handler" }))).blocks[0];
    expect(Object.fromEntries(who.items.map((i: any) => [i.key, [i.label, i.value]]))).toEqual({ gotcha: ["GOTCHA", 2], team: ["הצוות", 2], none: ["לא טופלו", 1] });
  });

  it("★ intent with its coverage, in words; only the close analysis counts", async () => {
    const ours = { source: "close-analysis" };
    H.intel = [
      { conversationId: "1", detectedIntent: "billing_payment", sentiment: "negative", metadata: ours },
      { conversationId: "2", detectedIntent: "unknown", sentiment: "neutral", metadata: ours },
      { conversationId: "3", detectedIntent: "billing_payment", sentiment: null, metadata: ours },
      // The old keyword heuristics ("general" for any Hebrew text): not a recorded value.
      { conversationId: "4", detectedIntent: "general", sentiment: "neutral", metadata: null },
      { conversationId: "old", detectedIntent: "billing_payment", sentiment: "negative", metadata: ours },
    ];
    const b: any = (await queryConversations(ctx(), Q({ groupBy: "intent" }))).blocks[0];
    expect(b.items).toEqual([{ key: "billing_payment", label: "Billing and payment", value: 2, share: 1 }]);
    expect((await queryConversations(ctx({ locale: "he" }), Q({ groupBy: "intent" }))).blocks[0]).toMatchObject({ items: [{ label: "חיוב ותשלום" }] });
    expect(b.coverage).toEqual({ covered: 2, of: 5 });
    const r = await queryConversations(ctx(), Q({ groupBy: "sentiment" }));
    expect((r.blocks[0] as any).coverage).toEqual({ covered: 2, of: 5 });
    expect(r.summary).toMatchObject({ recordedFor: "2 of 5" });
  });
});

describe("★ a mention: what was said in the period", () => {
  beforeEach(() => {
    H.convs[2].messages = [{ createdAt: D("2026-10-06T10:01:00Z"), body: "The duvet runs SMALL" }];
    H.convs[0].messages = [{ createdAt: D("2026-10-01T09:01:00Z"), body: "too small for me" }];
    H.convs[7].messages = [{ createdAt: D("2026-09-20T10:01:00Z"), body: "small" }]; // outside the period
    H.convs[5].messages = [{ createdAt: D("2026-10-03T10:01:00Z"), body: "small" }]; // a rehearsal
  });

  it("finds them (any case), lists them with links, labels the source in words", async () => {
    const r = await queryConversations(ctx({ locale: "he" }), Q({ mention: "small", groupBy: "channel" }));
    expect(r.summary).toMatchObject({ total: 2 });
    const list: any = r.blocks.find((b) => b.type === "record_list");
    expect(list.items.map((i: any) => i.id)).toEqual(["3", "1"]);
    expect(list.items[0]).toMatchObject({ title: "Customer 3", deepLink: "/inbox?c=3" });
    // Dated by when it STARTED (the period's measure), not its last message.
    H.convs[2].lastMessageAt = D("2026-10-20T10:00:00Z");
    const again: any = (await queryConversations(ctx({ locale: "en" }), Q({ mention: "small" }))).blocks.find((b) => b.type === "record_list");
    expect(again.items[0].meta).toContain("6 October");
    expect(list.items[0].subtitle).toContain("צ'אט Shopify");
    expect(list).toMatchObject({ total: 2, hasMore: false, sourceId: "s1" });
    expect(r.source.label).toContain("2 שיחות שמזכירות “small”");
  });

  it("the source replays page by page", async () => {
    const r = await queryConversations(ctx(), Q({ mention: "small" }));
    const page = await listConversationsForSource("T", undefined, "en", r.source.query.params, null);
    expect(page.data.map((i) => i.id)).toEqual(["3", "1"]);
    expect(page.nextCursor).toBeNull();
  });
});

describe("links and limits", () => {
  it("★ until the inbox's All view is on dev, no period link (the default queue view shows far fewer rows)", async () => {
    expect(INBOX_VIEW_ALL_LIVE).toBe(false);
    expect((await queryConversations(ctx(), Q({ channels: ["WHATSAPP"] }))).source.deepLink).toBeNull();
    expect((await queryConversations(ctx(), Q({}))).source.deepLink).toBeNull();
  });

  it("★ with it: the All view, the period, and one channel (the inbox shows the same rows)", () => {
    const link = (o: any) => sourceLink(Q(o), true);
    expect(link({})).toBe("/inbox?view=all&from=2026-10-01&to=2026-10-07");
    expect(link({ channels: ["WHATSAPP"] })).toBe("/inbox?view=all&channel=WHATSAPP&from=2026-10-01&to=2026-10-07");
    expect(link({ channels: ["SHOPIFY_LIVE_CHAT"] })).toBe("/inbox?view=all&channel=SHOPIFY_LIVE_CHAT&from=2026-10-01&to=2026-10-07");
  });

  it("★ no link when the inbox would show different rows (a mention, a status, several channels, a channel it cannot filter)", () => {
    const link = (o: any) => sourceLink(Q(o), true);
    expect(link({ mention: "small" })).toBeNull();
    expect(link({ status: "OPEN" })).toBeNull();
    expect(link({ channels: ["WHATSAPP", "WEBCHAT"] })).toBeNull();
    expect(link({ channels: ["VOICE"] })).toBeNull();
  });

  it("a bad period is refused, not guessed", () => {
    expect(normalizeQuery({ from: "2026-10-07", to: "2026-10-01" })).toHaveProperty("error");
    expect(normalizeQuery({ from: "2026-01-01", to: "2026-10-01" })).toHaveProperty("error");
    expect(normalizeQuery({ from: "yesterday", to: "2026-10-01" })).toHaveProperty("error");
    expect(normalizeQuery({ from: "2026-10-01", to: "2026-10-07", channels: ["FAX", "whatsapp"] })).toMatchObject({ channels: ["WHATSAPP"] });
  });
});
