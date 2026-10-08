/**
 * ★ What the assistant's tools hand the model is written for people, so the
 * answer is too (live: a Hebrew weekly summary said "WEBCHAT",
 * "SHOPIFY_LIVE_CHAT", "2026-10-01" and talked about "the system"):
 *   - recent activity: channel names in the interface language, dates as
 *     people say them, no enum key, no ISO; when each conversation started;
 *     missing text is null, not ""
 *   - conversation summary and customer search: the same
 *   - the thread's period reaches the model in words as well
 *   - the prompt: a manager's voice, no talk about the system, no guessing at
 *     technical causes, contradictions explained in business terms
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const D = (iso: string) => new Date(iso);

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const conv = (channel: string, created: string, name: string | null) => ({ customerName: name, customerExternalId: "972500000000", channel, createdAt: D(created) });
  return {
    ...actual,
    readDurableSetting: async () => JSON.stringify({ timezone: "Asia/Jerusalem", schedule: {} }),
    prisma: {
      message: {
        findMany: async (a: any) => a.where.direction === "INBOUND"
          ? [
              { conversationId: "c1", body: "Is the lamp in stock?", createdAt: D("2026-10-07T11:05:00Z"), conversation: conv("WEBCHAT", "2026-10-07T11:00:00Z", "Dana") },
              { conversationId: "c2", body: "", createdAt: D("2026-10-06T09:00:00Z"), conversation: conv("SHOPIFY_LIVE_CHAT", "2026-09-20T08:00:00Z", null) },
              { conversationId: "c3", body: "hi", createdAt: D("2026-10-01T07:00:00Z"), conversation: conv("WHATSAPP", "2026-10-01T06:00:00Z", "Avi") },
            ]
          : [{ direction: "INBOUND", body: null, createdAt: D("2026-10-07T11:05:00Z"), senderName: "Dana" }],
      },
      conversation: { findFirst: async () => ({ id: "c1" }), findMany: async () => [] },
      conversationIntelligence: { findFirst: async () => null },
      contact: { findMany: async () => [{ id: "k1", displayName: "Dana", channel: "SHOPIFY_LIVE_CHAT", externalId: "k1", email: null, phone: null, personId: null, updatedAt: D("2026-10-07T11:00:00Z") }] },
      inboundExclusion: { findMany: async () => [] },
    },
  };
});

import { dispatchSystemToolCall } from "../services/system-tools.service";
import { threadSystemLines } from "../services/assistant-threads.service";

const call = (name: string, args: any = {}) => ({ id: "tc", function: { name, arguments: JSON.stringify(args) } });
const run = async (name: string, args: any = {}, locale: "he" | "en" = "he") =>
  JSON.parse((await dispatchSystemToolCall(call(name, args), { tenantId: "T", userId: "u1", locale } as any)).content);
const RAW = /\b(WEBCHAT|SHOPIFY_LIVE_CHAT|WHATSAPP|INBOUND|OUTBOUND)\b|\d{4}-\d{2}-\d{2}/;

describe("★ recent activity reads like a manager's report", () => {
  it("channel names and dates in Hebrew, no enum key and no ISO date", async () => {
    const r = await run("system_recent_activity");
    const text = JSON.stringify(r.results.map(({ conversationId: _c, ...x }: any) => x));
    expect(text).not.toMatch(RAW);
    expect(r.results.map((x: any) => x.channel)).toEqual(["צ'אט באתר", "צ'אט Shopify", "וואטסאפ"]);
    // In the workspace's timezone (Jerusalem, UTC+3): 11:05Z is 14:05.
    expect(r.results[0].when).toMatch(/7 באוקטובר/);
    expect(r.results[0].when).toMatch(/14:05/);
  });

  it("when each conversation started, and missing text as null", async () => {
    const r = await run("system_recent_activity");
    expect(r).toMatchObject({ messageCount: 3, conversationCount: 3 });
    expect(r.results.map((x: any) => x.conversationStarted)).toEqual(["7 באוקטובר", "20 בספטמבר", "1 באוקטובר"]);
    expect(r.results[1].text).toBeNull();
    expect(r.results[1].customer).toBe("972500000000");
  });

  it("English reads in English", async () => {
    const r = await run("system_recent_activity", {}, "en");
    expect(r.results[0]).toMatchObject({ channel: "Web chat" });
    expect(r.results[0].when).toMatch(/7 October/);
  });
});

describe("★ the other tools too", () => {
  it("conversation summary: dates in words, missing text null", async () => {
    // A by-id read needs a viewer (it fails closed without one): an admin here.
    const r = JSON.parse((await dispatchSystemToolCall(call("system_summarize_conversation", { conversationId: "c1" }), { tenantId: "T", userId: "u1", locale: "he", viewer: { userId: "u1", role: "ADMIN" } } as any)).content);
    expect(JSON.stringify(r.messages)).not.toMatch(RAW);
    expect(r.messages[0]).toMatchObject({ role: "customer", text: null });
  });

  it("customer search: the channel's name", async () => {
    const r = await (async () => JSON.parse((await dispatchSystemToolCall(call("system_find_customers", { queries: ["Dana"] }), { tenantId: "T", userId: "u1", locale: "he", canReadContacts: true } as any)).content))();
    expect(r.customers[0].channels).toEqual(["צ'אט Shopify"]);
  });

  it("a count label's date is in words", async () => {
    // count needs prisma.conversation.count: covered through the label alone.
    const { stepText } = await import("../services/system-tools.service");
    // "since" is when the conversations STARTED, and the label says so.
    expect(stepText("system_count_conversations", { status: "CLOSED", sinceISO: "2026-10-01T00:00:00.000Z" }, "he")).toBe("סופרת שיחות שנסגרו (נפתחו מאז 1 באוקטובר)");
    expect(stepText("system_count_conversations", { status: "CLOSED", sinceISO: "2026-10-01T00:00:00.000Z" }, "en")).toBe("Counting closed conversations (started since 1 October)");
  });
});

describe("★ no tool speaks as \"the system\"", () => {
  it("tool descriptions talk about the business, not the system or the tenant", async () => {
    const { buildSystemAgentTools } = await import("../services/system-tools.service");
    const tools: any[] = await buildSystemAgentTools({ tenantId: "T", aiAgentId: null } as any).catch(() => []);
    const text = JSON.stringify(tools.filter((t) => String(t.function?.name).startsWith("system_")).map((t) => t.function.description));
    expect(text.length).toBeGreaterThan(100);
    expect(text).not.toMatch(/\btenant\b|the system|as the screens show|report/i);
  });
});

describe("★ GOTCHA speaks of herself in the feminine (Hebrew)", () => {
  const MASCULINE = /^(סופר|בודק|קורא|מסתכל|מחפש|מריץ|מכין|לומד|כותב|שולח|מעביר|מנתח) /;
  it("every Hebrew step label", async () => {
    const { stepText } = await import("../services/system-tools.service");
    const tools = ["system_count_conversations", "system_get_metric", "system_search_customers", "system_summarize_conversation", "system_recent_activity", "system_query_conversations", "system_query_orders", "system_product_stock", "propose_plan", "integration_hubspot_create_contact"];
    const metrics = ["waiting_for_person", "pending_approvals", "open_conversations", "closed_today", "inbound_messages_24h"];
    const labels = [
      ...tools.map((t) => stepText(t, {}, "he")),
      ...metrics.map((m) => stepText("system_get_metric", { metric: m }, "he")),
      stepText("system_count_conversations", { status: "OPEN" }, "he"),
      stepText("system_query_conversations", { mention: "מידה" }, "he"),
    ];
    for (const l of labels) expect(l, l).not.toMatch(MASCULINE);
    expect(labels).toContain("סופרת שיחות");
    expect(labels).toContain("מריצה hubspot create contact");
  });

  it("the prompt tells the model so", () => {
    const prompt = readFileSync(join(__dirname, "../prompts/system-copilot.md"), "utf-8");
    expect(prompt).toMatch(/In Hebrew you speak of yourself in the feminine/);
    expect(prompt).toContain('"אני בודקת"');
  });

  it("a Hebrew prefix joins a Hebrew word; a hyphen only before Latin or digits (\"מ-צ'אט Shopify\" in a suggestion, 2026-10-08)", () => {
    const prompt = readFileSync(join(__dirname, "../prompts/system-copilot.md"), "utf-8");
    expect(prompt).toContain(`"מצ'אט Shopify"`);
    expect(prompt).toMatch(/A hyphen only before Latin\s+letters or digits: "מ-WhatsApp"/);
    expect(prompt).toMatch(/in the suggestions too/);
  });
});

describe("★ the thread's period and the prompt", () => {
  it("the period reaches the model in words in the interface language", () => {
    const [scope] = threadSystemLines({ range: "last_7", channels: "all" }, "he", new Date("2026-10-07T12:00:00Z"));
    expect(scope).toContain('"1 באוקטובר - 7 באוקטובר"');
  });

  it("★ the cards are on screen, and only real abilities are offered (both surfaced live)", () => {
    const lines = threadSystemLines({ range: "last_7", channels: "all" }, "en").join("\n");
    // It said "I don't have a day-by-day table" beside a by-day chart.
    expect(lines).toMatch(/never say you lack a breakdown a card shows/);
    // It offered a CSV export and a "stock sync" it has no tool for.
    expect(lines).toMatch(/Never offer an export, a CSV or other file, a sync/);
  });

  it("★ the supervisor's live check: no layout words, money as given, follow-ups only as buttons", () => {
    const lines = threadSystemLines({ range: "last_7", channels: "all" }, "he").join("\n");
    // "the breakdown is in the card on the side of the screen": the cards are below.
    expect(lines).toMatch(/without describing where they appear on the screen/);
    expect(lines).not.toMatch(/beside your answer/);
    // "10,539.69 ILS"
    expect(lines).toMatch(/Write money exactly as a tool's text gives it/);
    // "want me to check: 1... 2... 3..." duplicated the suggestion chips.
    expect(lines).toMatch(/Follow-up questions go ONLY in the \[\[suggestions\]\] line/);
    expect(lines).toMatch(/Never list them, or any "want me to\.\.\." menu/);
  });

  it("★ one call per split, not one per channel (it made 8 calls live)", async () => {
    const { buildSystemAgentTools } = await import("../services/system-tools.service");
    const tools: any[] = await buildSystemAgentTools({ tenantId: "T", aiAgentId: null } as any);
    const d = String(tools.find((t: any) => t.function?.name === "system_query_conversations")?.function.description);
    expect(d).toMatch(/ONE call with groupBy channel, never one call per channel/);
  });

  it("the prompt asks for a manager's voice and forbids guessing at technical causes", () => {
    const prompt = readFileSync(join(__dirname, "../prompts/system-copilot.md"), "utf-8");
    expect(prompt).toMatch(/Speak like the business's manager/);
    expect(prompt).toMatch(/Never mention "the system"/);
    expect(prompt).toMatch(/Do not guess at technical causes/);
    expect(prompt).toMatch(/explain them in business terms/);
    expect(prompt).toMatch(/never as 2026-10-01/);
    // ★ The example against "the system reports" (it surfaced live despite the rule).
    expect(prompt).toContain('Not "המערכת מדווחת על 0 שיחות');
    expect(prompt).toContain('"לא נפתחו שיחות חדשות השבוע"');
    expect(prompt).toMatch(/Say what happened, not who reported it/);
  });
});
