/**
 * B3 (Smoovee 2026-11-09): a conversation only the AI employee answers gets a
 * reminder after the bot's last message, then a closing message and a close.
 * "idleAutomation" acted only on conversations a person holds. Never on a
 * conversation handed to a person; never after the customer replied.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const H = vi.hoisted(() => ({
  config: null as any, convs: [] as any[], msgs: [] as any[], queued: [] as any[], seq: 0, states: {} as Record<string, any>,
  events: [] as any[], reads: [] as any[], windows: {} as Record<string, Date | null>,
}));

function matches(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
    if (k === "OR") return (v as any[]).some((w) => matches(row, w));
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("in" in v) return v.in.includes(row[k]);
      if ("notIn" in v) return row[k] != null && !v.notIn.includes(row[k]);
      if ("not" in v) return v.not === null ? row[k] != null : row[k] !== v.not;
      if ("gte" in v) return row[k] != null && +new Date(row[k]) >= +new Date(v.gte);
      return true;
    }
    return (row[k] ?? null) === v;
  });
}

vi.mock("@chatcenter/shared", async () => ({
  prisma: {
    conversation: {
      findMany: vi.fn(async (a: any) => { H.reads.push(a); return H.convs.filter((c) => matches(c, a.where)).map((c) => ({ ...c, channelAccount: c.channelAccountId ? { id: c.channelAccountId, channel: c.channel } : null })); }),
      findFirst: vi.fn(async (a: any) => { const c = H.convs.find((x) => matches(x, a.where)); return c ? (a.include ? { ...c, assignedAgent: null } : c) : null; }),
      update: vi.fn(async (a: any) => { Object.assign(H.convs.find((c) => c.id === a.where.id), a.data); return {}; }),
      updateMany: vi.fn(async (a: any) => { const rows = H.convs.filter((c) => matches(c, a.where)); rows.forEach((c) => Object.assign(c, a.data)); return { count: rows.length }; }),
    },
    message: {
      findFirst: vi.fn(async (a: any) => {
        const rows = H.msgs.filter((m) => m.conversationId === a.where.conversationId && (a.where.messageType?.not ? m.messageType !== a.where.messageType.not : true) && (a.where.direction ? m.direction === a.where.direction : true));
        return rows.sort((x, y) => +y.createdAt - +x.createdAt)[0] ?? null;
      }),
      create: vi.fn(async (a: any) => { const m = { id: `m${++H.seq}`, createdAt: new Date(), ...a.data }; H.msgs.push(m); return m; }),
      findMany: vi.fn(async (a: any) => H.msgs.filter((m) => m.conversationId === a.where.conversationId && m.direction === a.where.direction && (!a.where.createdAt?.gte || m.createdAt >= a.where.createdAt.gte))),
    },
    conversationState: { findFirst: vi.fn(async (a: any) => (a.where.lane === "live" ? H.states[a.where.conversationId] ?? null : null)) },
  },
  createWorker: vi.fn(),
  idleConversationQueue: { add: vi.fn() },
  outgoingMessageQueue: { add: vi.fn(async (_n: string, d: any) => { H.queued.push(d); }) },
  publishEvent: vi.fn(async (e: any) => { H.events.push(e); }),
  readDurableSetting: vi.fn(async (_t: string, k: string) => (k === "botIdleAutomation" && H.config ? JSON.stringify(H.config) : null)),
  buildTemplateComponents: vi.fn(),
  renderTemplateText: vi.fn(),
}));
// The customer's 24h window: open unless a test closes it for a recipient.
vi.mock("@chatcenter/shared/src/lib/reply-window", async () => {
  const actual = await vi.importActual<any>("../../../../packages/shared/src/lib/reply-window");
  return { ...actual, lastInboundAtForRecipient: vi.fn(async (a: any) => (a.customerExternalId in H.windows ? H.windows[a.customerExternalId] : new Date())) };
});

import { botIdleForTenant, botIdleStep, closeByBot, SWEEP_PAGE } from "../workers/idle-conversation.worker";
import { BOT_CLOSE_REOPEN_DAYS, BOT_IDLE_DEFAULT_TEXTS as TXT, botIdleRuleFor, parseBotIdleRow, reopenBotClosed } from "@chatcenter/shared/src/lib/bot-idle";

const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms);
const A = "היי, עדיין כאן?";
const B = "סוגרת את השיחה בינתיים.";
// The one row that existed before the default: the website widget only.
const ROW = { reminderEnabled: true, reminderDelayMinutes: 10, reminderMessage: A, autoCloseEnabled: true, autoCloseDelayMinutes: 10, autoCloseMessage: B, channels: ["WEBCHAT"] };
const conv = (id: string, over: any = {}) => ({
  id, tenantId: "T", channel: "WEBCHAT", channelAccountId: "ca_web", customerExternalId: `sess_${id}`, status: "OPEN", detectedLocale: null,
  assignedAgentId: null, isHandedOver: false, automationRunId: null, handledBy: "ai_agent", lastMessageAt: new Date(), reminderSentAt: null, ...over,
});
const msg = (conversationId: string, direction: string, minutesAgo: number, over: any = {}) =>
  H.msgs.push({ id: `m${++H.seq}`, conversationId, direction, messageType: "text", body: direction === "OUTBOUND" ? "בשמחה!" : "שלום", createdAt: ago(minutesAgo * MIN), senderName: direction === "OUTBOUND" ? "AI Bot" : "Visitor", metadata: direction === "OUTBOUND" ? { source: "ai_bot" } : null, ...over });
const sent = (id: string) => H.queued.filter((q) => q.conversationId === id).map((q) => q.body);
const byId = (id: string) => H.convs.find((c) => c.id === id);
const systemOf = (id: string) => H.msgs.filter((m) => m.conversationId === id && m.messageType === "system").map((m) => m.metadata);
/** The engine's end mark: the stored time of the customer's newest message so far. */
const mark = (id: string, pending: any[] = []) => {
  const lastIn = H.msgs.filter((m) => m.conversationId === id && m.direction === "INBOUND").sort((x, y) => +y.createdAt - +x.createdAt)[0];
  H.states[id] = { pending, facts: { _endedAt: lastIn.createdAt.toISOString() } };
};
const defaultOn = () => { process.env.BOT_IDLE_DEFAULT_ON = "on"; };

beforeEach(() => {
  H.convs = []; H.msgs = []; H.queued = []; H.seq = 0; H.states = {}; H.events = []; H.reads = []; H.windows = {};
  H.config = { ...ROW };
  delete process.env.BOT_IDLE_DEFAULT_ON;
});
afterEach(() => { delete process.env.BOT_IDLE_DEFAULT_ON; });

describe("waiting on the business: no reminder, no close (2026-11-18)", () => {
  it("★ the bot's last message passed it to the team: nothing", async () => {
    H.convs = [conv("tp")];
    msg("tp", "INBOUND", 13);
    msg("tp", "OUTBOUND", 12, { body: "העברתי את השאלה לצוות, והתשובה תגיע כאן בצ'אט." });
    await botIdleForTenant("T");
    expect(sent("tp")).toEqual([]);
  });
  it("★ an open team item in the engine's state: no reminder and, after one, no close", async () => {
    H.convs = [conv("oi"), conv("oi2")];
    H.states = { oi: { pending: [{ kind: "promise", text: "checking with the team: מלאי של נינג'ה שחור", at: new Date().toISOString() }] }, oi2: { pending: [{ kind: "promise", text: "checking with the team: x", at: new Date().toISOString() }] } };
    msg("oi", "INBOUND", 13);
    msg("oi", "OUTBOUND", 12, { body: "בדקתי." });
    msg("oi2", "OUTBOUND", 12, { body: A, metadata: { source: "idle_reminder" } });
    await botIdleForTenant("T");
    expect(sent("oi")).toEqual([]);
    expect(sent("oi2")).toEqual([]);
    expect(H.convs.find((c) => c.id === "oi2").status).toBe("OPEN");
  });
  it("★ a return asked for in the last days: nothing", async () => {
    H.convs = [conv("rt")];
    msg("rt", "INBOUND", 14, { body: "אני רוצה להחזיר את המשטח" });
    msg("rt", "OUTBOUND", 12, { body: "אשמח לעזור." });
    await botIdleForTenant("T");
    expect(sent("rt")).toEqual([]);
  });
  it("a team item older than 3 days no longer blocks", async () => {
    H.convs = [conv("old")];
    H.states = { old: { pending: [{ kind: "promise", text: "checking with the team: x", at: new Date(Date.now() - 4 * 24 * 3600_000).toISOString() }] } };
    msg("old", "INBOUND", 13);
    msg("old", "OUTBOUND", 12, { body: "בדקתי." });
    await botIdleForTenant("T");
    expect(sent("old")).toEqual([A]);
  });
});

describe("the bot's conversation: reminder, then close", () => {
  it("10 minutes after the bot: the reminder (tagged), not yet closed; 10 after the reminder: B and closed", async () => {
    H.convs = [conv("bot")];
    msg("bot", "INBOUND", 13);
    msg("bot", "OUTBOUND", 12);
    expect(await botIdleForTenant("T")).toEqual({ reminders: 1, closes: 0 });
    expect(sent("bot")).toEqual([A]);
    expect(H.msgs.at(-1)).toMatchObject({ body: A, metadata: { source: "idle_reminder" }, senderName: "AI Bot" });
    expect(H.convs[0].status).toBe("OPEN");
    // The next sweep, five minutes on: the reminder is too fresh to close on.
    H.msgs.at(-1).createdAt = ago(5 * MIN);
    expect(await botIdleForTenant("T")).toEqual({ reminders: 0, closes: 0 });
    // Ten minutes after the reminder.
    H.msgs.at(-1).createdAt = ago(11 * MIN);
    expect(await botIdleForTenant("T")).toEqual({ reminders: 0, closes: 1 });
    expect(sent("bot")).toEqual([A, B]);
    expect(H.convs[0].status).toBe("CLOSED");
    expect(H.msgs.find((m) => m.messageType === "system")?.metadata).toEqual({ systemEvent: "auto_closed", reason: "bot_idle" });
    // Closed: nothing more.
    expect(await botIdleForTenant("T")).toEqual({ reminders: 0, closes: 0 });
  });

  it("not yet 10 minutes: nothing", async () => {
    H.convs = [conv("fresh")];
    msg("fresh", "OUTBOUND", 9);
    expect(await botIdleForTenant("T")).toEqual({ reminders: 0, closes: 0 });
  });
});

describe("never touched", () => {
  it("handed to a person, assigned, a flow's, awaiting approval, or another channel: nothing", async () => {
    H.convs = [
      conv("handed", { isHandedOver: true, handledBy: "human", status: "WAITING" }),
      // The widget's "talk to a person" sets isHandedOver + WAITING and leaves handledBy.
      conv("asked", { isHandedOver: true, status: "WAITING" }),
      conv("assigned", { assignedAgentId: "u1" }),
      conv("flow", { automationRunId: "run1", handledBy: "flow" }),
      conv("approval", { handledBy: "awaiting_approval" }),
      conv("wa", { channel: "WHATSAPP" }),
    ];
    for (const c of H.convs) msg(c.id, "OUTBOUND", 30);
    expect(await botIdleForTenant("T")).toEqual({ reminders: 0, closes: 0 });
    expect(H.queued).toHaveLength(0);
  });

  it("the customer replied after the bot, or a person wrote last: nothing", async () => {
    H.convs = [conv("replied"), conv("person")];
    msg("replied", "OUTBOUND", 40);
    msg("replied", "INBOUND", 30);
    msg("person", "OUTBOUND", 30, { senderName: "dana@shop.co.il", metadata: null });
    expect(await botIdleForTenant("T")).toEqual({ reminders: 0, closes: 0 });
  });

  it("the customer replied after the reminder: no close", async () => {
    H.convs = [conv("answered")];
    msg("answered", "OUTBOUND", 30);
    msg("answered", "OUTBOUND", 15, { metadata: { source: "idle_reminder" } });
    msg("answered", "INBOUND", 12);
    expect(await botIdleForTenant("T")).toEqual({ reminders: 0, closes: 0 });
    expect(H.convs[0].status).toBe("OPEN");
  });

  it("handed over between the check and the send: nothing sent", async () => {
    H.convs = [conv("race")];
    msg("race", "OUTBOUND", 30);
    const { prisma } = (await import("@chatcenter/shared")) as any;
    prisma.conversation.findFirst.mockImplementationOnce(async () => { H.convs[0].isHandedOver = true; return null; });
    expect(await botIdleForTenant("T")).toEqual({ reminders: 0, closes: 0 });
    expect(H.queued).toHaveLength(0);
  });

  it("no setting, or both steps off: nothing read further", async () => {
    H.config = null;
    H.convs = [conv("bot")];
    msg("bot", "OUTBOUND", 30);
    expect(await botIdleForTenant("T")).toEqual({ reminders: 0, closes: 0 });
    expect(H.reads).toHaveLength(0);
    H.config = { ...ROW, reminderEnabled: false, autoCloseEnabled: false };
    expect(await botIdleForTenant("T")).toEqual({ reminders: 0, closes: 0 });
    expect(H.reads).toHaveLength(0);
  });
});

describe("the step rule", () => {
  const cfg = botIdleRuleFor("WEBCHAT", parseBotIdleRow(JSON.stringify(ROW)), false)!;
  const m = (minutes: number, over: any = {}) => ({ direction: "OUTBOUND", createdAt: ago(minutes * MIN), metadata: { source: "ai_bot" }, senderName: "AI Bot", ...over });
  it("bot → remind; reminder → close; our close → never again; a customer → null", () => {
    expect(botIdleStep(m(11), cfg)).toBe("remind");
    expect(botIdleStep(m(11, { metadata: { source: "idle_reminder" } }), cfg)).toBe("close");
    expect(botIdleStep(m(60, { metadata: { source: "idle_close" } }), cfg)).toBeNull();
    expect(botIdleStep({ direction: "INBOUND", createdAt: ago(60 * MIN) }, cfg)).toBeNull();
  });
  it("no reminder step: the close counts from the bot", () => {
    const closeOnly = { ...cfg, reminderEnabled: false };
    expect(botIdleStep(m(11), closeOnly)).toBe("close");
    expect(botIdleStep(m(9), closeOnly)).toBeNull();
  });
});

describe("switching it on never sweeps up old silences (dev 2026-11-09: 495 two-week-old conversations reminded and closed)", () => {
  it("a bot message 2 weeks old, or a reminder 3 hours old: nothing; just due: acted on", async () => {
    H.convs = [conv("old"), conv("old_reminded"), conv("due")];
    msg("old", "OUTBOUND", 14 * 24 * 60);
    msg("old_reminded", "OUTBOUND", 180, { metadata: { source: "idle_reminder" } });
    msg("due", "OUTBOUND", 11);
    expect(await botIdleForTenant("T")).toEqual({ reminders: 1, closes: 0 });
    expect(H.queued.map((q) => q.conversationId)).toEqual(["due"]);
  });
  it("the step rule: due from the delay until an hour past it", () => {
    const cfg = botIdleRuleFor("WEBCHAT", parseBotIdleRow(JSON.stringify(ROW)), false)!;
    const at = (minutes: number, source = "ai_bot") => ({ direction: "OUTBOUND", createdAt: ago(minutes * MIN), metadata: { source }, senderName: "AI Bot" });
    expect(botIdleStep(at(69), cfg)).toBe("remind");
    expect(botIdleStep(at(71), cfg)).toBeNull();
    expect(botIdleStep(at(69, "idle_reminder"), cfg)).toBe("close");
    expect(botIdleStep(at(71, "idle_reminder"), cfg)).toBeNull();
  });
});

describe("default on: a business with no row (2026-11-19, Omer: conversations never got closed)", () => {
  beforeEach(() => { H.config = null; });

  it("★ the switch unset: a business with no row is not touched, on any channel", async () => {
    H.convs = [conv("web"), conv("wa", { channel: "WHATSAPP", channelAccountId: "ca_wa" })];
    msg("web", "OUTBOUND", 11);
    msg("wa", "OUTBOUND", 31);
    expect(await botIdleForTenant("T")).toEqual({ reminders: 0, closes: 0 });
    expect(H.queued).toHaveLength(0);
    expect(H.reads).toHaveLength(0);
  });

  it("★ live chat: the reminder 10 minutes after the bot, the close 10 after the reminder, on both widgets, in the conversation's language", async () => {
    defaultOn();
    H.convs = [conv("web", { detectedLocale: "he" }), conv("shop", { channel: "SHOPIFY_LIVE_CHAT", channelAccountId: "ca_shop", detectedLocale: "en" }), conv("early")];
    msg("web", "OUTBOUND", 11);
    msg("shop", "OUTBOUND", 11, { body: "Sure, here it is." });
    msg("early", "OUTBOUND", 9, { body: "Yes, it is in stock." });
    expect(await botIdleForTenant("T")).toEqual({ reminders: 2, closes: 0 });
    expect(sent("web")).toEqual([TXT.he.reminder]);
    expect(sent("shop")).toEqual([TXT.en.reminder]);
    expect(sent("early")).toEqual([]);
    // Eleven minutes on: the two reminders are due for the close, and the third conversation for its reminder.
    for (const m of H.msgs) m.createdAt = ago((m.metadata?.source === "idle_reminder" ? 11 : m.conversationId === "early" ? 20 : 22) * MIN);
    expect(await botIdleForTenant("T")).toEqual({ reminders: 1, closes: 2 });
    expect(sent("early")).toEqual([TXT.en.reminder]);
    expect(sent("web")).toEqual([TXT.he.reminder, TXT.he.close]);
    expect(sent("shop")).toEqual([TXT.en.reminder, TXT.en.close]);
    expect(byId("web").status).toBe("CLOSED");
    expect(byId("shop").status).toBe("CLOSED");
    expect(systemOf("web")).toEqual([{ systemEvent: "auto_closed", reason: "bot_idle" }]);
  });

  it("★ messaging: nothing at 29 minutes, the reminder at 30; nothing 14 minutes after it, the close at 15", async () => {
    defaultOn();
    H.convs = [
      conv("wa29", { channel: "WHATSAPP", channelAccountId: "ca_wa" }), conv("wa", { channel: "WHATSAPP", channelAccountId: "ca_wa" }),
      conv("ig", { channel: "INSTAGRAM", channelAccountId: "ca_ig" }), conv("fb", { channel: "MESSENGER", channelAccountId: "ca_fb" }),
    ];
    msg("wa29", "OUTBOUND", 29);
    msg("wa", "OUTBOUND", 31, { body: "המשלוח יוצא מחר." });
    msg("ig", "OUTBOUND", 31, { body: "It ships tomorrow." });
    msg("fb", "OUTBOUND", 11);
    expect(await botIdleForTenant("T")).toEqual({ reminders: 2, closes: 0 });
    // No detected language: the letters of the bot's last message decide.
    expect(sent("wa")).toEqual([TXT.he.reminder]);
    expect(sent("ig")).toEqual([TXT.en.reminder]);
    expect(sent("wa29")).toEqual([]);
    expect(sent("fb")).toEqual([]);
    const reminders = H.msgs.filter((x) => x.metadata?.source === "idle_reminder");
    for (const m of reminders) m.createdAt = ago(14 * MIN);
    for (const id of ["wa29", "fb"]) H.msgs.filter((x) => x.conversationId === id).forEach((x) => { x.createdAt = ago(1 * MIN); });
    expect(await botIdleForTenant("T")).toEqual({ reminders: 0, closes: 0 });
    for (const m of reminders) m.createdAt = ago(15.5 * MIN);
    expect(await botIdleForTenant("T")).toEqual({ reminders: 0, closes: 2 });
    expect(sent("wa")).toEqual([TXT.he.reminder, TXT.he.close]);
    expect(sent("ig")).toEqual([TXT.en.reminder, TXT.en.close]);
    expect(H.queued.find((q) => q.conversationId === "wa")).toMatchObject({ channel: "WHATSAPP", channelAccountId: "ca_wa", recipientExternalId: "sess_wa", senderName: "AI Bot" });
  });

  it("★ a row rules the channels it lists, in its own words; the default rules the rest", async () => {
    defaultOn();
    H.config = { ...ROW };
    H.convs = [conv("web"), conv("wa", { channel: "WHATSAPP", channelAccountId: "ca_wa", detectedLocale: "he" })];
    msg("web", "OUTBOUND", 11);
    msg("wa", "OUTBOUND", 31);
    expect(await botIdleForTenant("T")).toEqual({ reminders: 2, closes: 0 });
    expect(sent("web")).toEqual([A]);
    expect(sent("wa")).toEqual([TXT.he.reminder]);
  });

  it("★ a business that switched it off: a row with both steps off is off for its channels, the default does not step in", async () => {
    defaultOn();
    H.config = { ...ROW, reminderEnabled: false, autoCloseEnabled: false, channels: ["WEBCHAT", "WHATSAPP"] };
    H.convs = [conv("web"), conv("wa", { channel: "WHATSAPP", channelAccountId: "ca_wa" }), conv("ig", { channel: "INSTAGRAM", channelAccountId: "ca_ig" })];
    msg("web", "OUTBOUND", 11);
    msg("wa", "OUTBOUND", 31);
    msg("ig", "OUTBOUND", 31);
    expect(await botIdleForTenant("T")).toEqual({ reminders: 1, closes: 0 });
    expect(H.queued.map((q) => q.conversationId)).toEqual(["ig"]);
    // Both groups saved off: nothing anywhere, nothing read.
    H.config = { groups: { liveChat: { enabled: false, reminderAfterMinutes: 10, closeAfterReminderMinutes: 10, reminderText: "x", closeText: "" }, messaging: { enabled: false, reminderAfterMinutes: 30, closeAfterReminderMinutes: 15, reminderText: "x", closeText: "" } } };
    H.reads = []; H.queued = [];
    H.msgs.filter((x) => x.metadata?.source === "idle_reminder").forEach((x) => { x.createdAt = ago(16 * MIN); });
    expect(await botIdleForTenant("T")).toEqual({ reminders: 0, closes: 0 });
    expect(H.reads).toHaveLength(0);
  });

  it("★ a saved group: its own numbers on every channel of the group; an empty close text closes with no message", async () => {
    H.config = { ...ROW, groups: { liveChat: { enabled: true, reminderAfterMinutes: 3, closeAfterReminderMinutes: 4, reminderText: "עוד כאן?", closeText: "" } } };
    H.convs = [conv("web"), conv("shop", { channel: "SHOPIFY_LIVE_CHAT", channelAccountId: "ca_shop" }), conv("wa", { channel: "WHATSAPP", channelAccountId: "ca_wa" })];
    msg("web", "OUTBOUND", 3.5);
    msg("shop", "OUTBOUND", 3.5);
    msg("wa", "OUTBOUND", 31);
    expect(await botIdleForTenant("T")).toEqual({ reminders: 2, closes: 0 });
    expect(sent("web")).toEqual(["עוד כאן?"]);
    expect(sent("shop")).toEqual(["עוד כאן?"]);
    for (const m of H.msgs) if (m.conversationId !== "wa") m.createdAt = ago((m.metadata?.source === "idle_reminder" ? 4.5 : 8) * MIN);
    expect(await botIdleForTenant("T")).toEqual({ reminders: 0, closes: 2 });
    expect(sent("web")).toEqual(["עוד כאן?"]);
    expect(byId("web").status).toBe("CLOSED");
    expect(byId("wa").status).toBe("OPEN");
    expect(sent("wa")).toEqual([]);
  });

  it("★ old backlog: switching the default on reminds and closes nothing that fell due long ago", async () => {
    defaultOn();
    H.convs = [
      conv("week", { channel: "WHATSAPP", channelAccountId: "ca_wa" }), conv("stale", { channel: "WHATSAPP", channelAccountId: "ca_wa", lastMessageAt: ago(3 * 24 * 60 * MIN) }),
      conv("hours", { channel: "INSTAGRAM", channelAccountId: "ca_ig" }), conv("reminded", {}), conv("ended", {}),
    ];
    msg("week", "OUTBOUND", 7 * 24 * 60);
    msg("stale", "OUTBOUND", 3 * 24 * 60);
    msg("hours", "OUTBOUND", 95);
    msg("reminded", "OUTBOUND", 75, { metadata: { source: "idle_reminder" } });
    msg("ended", "INBOUND", 3 * 60 + 1, { body: "תודה" });
    msg("ended", "OUTBOUND", 3 * 60);
    mark("ended");
    expect(await botIdleForTenant("T")).toEqual({ reminders: 0, closes: 0 });
    expect(H.queued).toHaveLength(0);
    expect(H.convs.every((c) => c.status === "OPEN")).toBe(true);
    // The conversation quiet for days is not even read (its last message is older than any step could be).
    expect(H.reads[0].where.lastMessageAt.gte).toBeInstanceOf(Date);
    expect(H.reads.slice(1).flatMap((r) => r.where.id.in)).not.toContain("stale");
  });
});

describe("the customer ended it: the engine's mark, a quiet close (2026-11-19)", () => {
  beforeEach(() => { H.config = null; defaultOn(); });

  it("★ \"תודה\" marked, the bot's \"בשמחה!\" last, 10 quiet minutes: closed with no reminder and no message", async () => {
    H.convs = [conv("web"), conv("wa", { channel: "WHATSAPP", channelAccountId: "ca_wa" })];
    for (const id of ["web", "wa"]) { msg(id, "INBOUND", 12, { body: "תודה רבה" }); msg(id, "OUTBOUND", 11); mark(id); }
    expect(await botIdleForTenant("T")).toEqual({ reminders: 0, closes: 2 });
    expect(H.queued).toHaveLength(0);
    expect(H.msgs.filter((m) => m.direction === "OUTBOUND")).toHaveLength(2);
    expect(byId("web")).toMatchObject({ status: "CLOSED", closedAt: expect.any(Date) });
    expect(byId("wa").status).toBe("CLOSED");
    expect(systemOf("web")).toEqual([{ systemEvent: "auto_closed", reason: "customer_ended" }]);
    expect(systemOf("wa")).toEqual([{ systemEvent: "auto_closed", reason: "customer_ended" }]);
  });

  it("★ not yet 10 minutes: nothing, and the conversation is still open for \"ועוד שאלה\"", async () => {
    H.convs = [conv("web")];
    msg("web", "INBOUND", 6, { body: "תודה" }); msg("web", "OUTBOUND", 5); mark("web");
    expect(await botIdleForTenant("T")).toEqual({ reminders: 0, closes: 0 });
    expect(byId("web").status).toBe("OPEN");
  });

  it("★ never a reminder after a goodbye: where the reminder would be due, the marked conversation closes quietly or is left alone", async () => {
    H.convs = [conv("wa31", { channel: "WHATSAPP", channelAccountId: "ca_wa" }), conv("wa75", { channel: "WHATSAPP", channelAccountId: "ca_wa" }), conv("plain", { channel: "WHATSAPP", channelAccountId: "ca_wa" })];
    msg("wa31", "INBOUND", 32, { body: "bye, thanks" }); msg("wa31", "OUTBOUND", 31); mark("wa31");
    // The sweep was down for a while: the close fell due more than an hour ago.
    msg("wa75", "INBOUND", 76, { body: "תודה" }); msg("wa75", "OUTBOUND", 75); mark("wa75");
    msg("plain", "INBOUND", 32); msg("plain", "OUTBOUND", 31);
    expect(await botIdleForTenant("T")).toEqual({ reminders: 1, closes: 1 });
    expect(H.queued.map((q) => q.conversationId)).toEqual(["plain"]);
    expect(byId("wa31").status).toBe("CLOSED");
    expect(byId("wa75").status).toBe("OPEN");
  });

  it("★ the bot did not answer the goodbye: the customer's message is last, the same quiet close", async () => {
    H.convs = [conv("web")];
    msg("web", "OUTBOUND", 20); msg("web", "INBOUND", 12, { body: "תודה, זה הכל" }); mark("web");
    expect(await botIdleForTenant("T")).toEqual({ reminders: 0, closes: 1 });
    expect(H.queued).toHaveLength(0);
    expect(systemOf("web")).toEqual([{ systemEvent: "auto_closed", reason: "customer_ended" }]);
  });

  it("★ the customer wrote again after the mark: the mark is void; the usual rule decides", async () => {
    H.convs = [conv("again"), conv("waiting")];
    msg("again", "INBOUND", 30, { body: "תודה" }); mark("again");
    msg("again", "OUTBOUND", 29); msg("again", "INBOUND", 13, { body: "רגע, עוד שאלה: יש משלוח לאילת?" }); msg("again", "OUTBOUND", 11, { body: "כן, יש." });
    msg("waiting", "INBOUND", 30, { body: "תודה" }); mark("waiting");
    msg("waiting", "OUTBOUND", 29); msg("waiting", "INBOUND", 12, { body: "ומה לגבי אחריות?" });
    expect(await botIdleForTenant("T")).toEqual({ reminders: 1, closes: 0 });
    expect(sent("again")).toEqual([TXT.he.reminder]);
    expect(byId("waiting").status).toBe("OPEN");
    expect(sent("waiting")).toEqual([]);
  });

  it("★ the whole way round: marked, closed quietly, a new subject reopens the same conversation, and the old mark never closes it again", async () => {
    // The inbound path's reopen (the real helper) over this file's rows.
    const db = {
      conversation: {
        findFirst: async (a: any) => H.convs.find((c) => matches(c, a.where)) ?? null,
        updateMany: async (a: any) => { const rows = H.convs.filter((c) => matches(c, a.where)); rows.forEach((c) => Object.assign(c, a.data)); return { count: rows.length }; },
      },
      message: { findFirst: async (a: any) => H.msgs.filter((m) => m.conversationId === a.where.conversationId && m.messageType === a.where.messageType).sort((x, y) => +y.createdAt - +x.createdAt)[0] ?? null },
    };
    H.convs = [conv("c", { channel: "WHATSAPP", channelAccountId: "ca_wa" })];
    msg("c", "INBOUND", 12, { body: "תודה רבה, זה הכל" }); msg("c", "OUTBOUND", 11); mark("c");
    expect(await botIdleForTenant("T")).toEqual({ reminders: 0, closes: 1 });
    expect(systemOf("c")).toEqual([{ systemEvent: "auto_closed", reason: "customer_ended" }]);

    // Two days later the customer writes about something else: the same conversation, open again.
    const later = (ms: number) => {
      for (const m of H.msgs) m.createdAt = new Date(+m.createdAt - ms);
      if (byId("c").closedAt) byId("c").closedAt = new Date(+byId("c").closedAt - ms);
      H.states.c.facts._endedAt = new Date(Date.parse(H.states.c.facts._endedAt) - ms).toISOString();
    };
    later(2 * 24 * 60 * MIN);
    expect(await reopenBotClosed(db, { tenantId: "T", conversationId: "c", maxDays: BOT_CLOSE_REOPEN_DAYS })).toBe(true);
    expect(byId("c")).toMatchObject({ status: "OPEN", closedAt: null });
    expect(H.convs).toHaveLength(1);

    // The new question is waiting for its answer; the old mark is still in the engine's state.
    msg("c", "INBOUND", 12, { body: "היי, יש לכם משלוחים לחו\"ל?" });
    expect(H.states.c.facts._endedAt).toBeTruthy();
    expect(await botIdleForTenant("T")).toEqual({ reminders: 0, closes: 0 });
    expect(byId("c").status).toBe("OPEN");

    // The bot answered and 31 quiet minutes passed: the usual reminder, not the mark's quiet close.
    later(20 * MIN);
    msg("c", "OUTBOUND", 31, { body: "כן, יש משלוח לחו\"ל." });
    expect(await botIdleForTenant("T")).toEqual({ reminders: 1, closes: 0 });
    expect(sent("c")).toEqual([TXT.he.reminder]);
    expect(byId("c").status).toBe("OPEN");
    expect(systemOf("c")).toHaveLength(1);
  });

  it("★ waiting on the business: a marked conversation with a return asked for, a team pass or an open team item is not closed", async () => {
    H.convs = [conv("ret"), conv("pass"), conv("item")];
    msg("ret", "INBOUND", 14, { body: "אני רוצה להחזיר את החולצה" }); msg("ret", "OUTBOUND", 13); msg("ret", "INBOUND", 12, { body: "תודה" }); msg("ret", "OUTBOUND", 11); mark("ret");
    msg("pass", "OUTBOUND", 13, { body: "העברתי את השאלה לצוות, והתשובה תגיע כאן בצ'אט." }); msg("pass", "INBOUND", 12, { body: "תודה" }); mark("pass");
    msg("item", "INBOUND", 12, { body: "תודה" }); msg("item", "OUTBOUND", 11);
    mark("item", [{ kind: "promise", text: "checking with the team: מלאי", at: new Date().toISOString() }]);
    expect(await botIdleForTenant("T")).toEqual({ reminders: 0, closes: 0 });
    expect(H.convs.every((c) => c.status === "OPEN")).toBe(true);
    expect(H.queued).toHaveLength(0);
  });

  it("★ a person holds it, or it was handed over: the mark closes nothing", async () => {
    H.convs = [conv("held", { assignedAgentId: "u1" }), conv("handed", { isHandedOver: true, status: "WAITING" }), conv("person_last")];
    for (const id of ["held", "handed"]) { msg(id, "INBOUND", 12, { body: "תודה" }); msg(id, "OUTBOUND", 11); mark(id); }
    msg("person_last", "INBOUND", 12, { body: "תודה" }); mark("person_last");
    msg("person_last", "OUTBOUND", 11, { senderName: "dana@shop.co.il", metadata: null });
    expect(await botIdleForTenant("T")).toEqual({ reminders: 0, closes: 0 });
    expect(H.convs.every((c) => c.status !== "CLOSED")).toBe(true);
  });

  it("★ the switch off: the mark is not read; a business with its own row gets its usual reminder", async () => {
    delete process.env.BOT_IDLE_DEFAULT_ON;
    H.config = { ...ROW };
    H.convs = [conv("web")];
    msg("web", "INBOUND", 12, { body: "תודה" }); msg("web", "OUTBOUND", 11); mark("web");
    expect(await botIdleForTenant("T")).toEqual({ reminders: 1, closes: 0 });
    expect(sent("web")).toEqual([A]);
    expect(byId("web").status).toBe("OPEN");
  });

  it("the customer replied between the check and the close: nothing", async () => {
    H.convs = [conv("race")];
    msg("race", "INBOUND", 12, { body: "תודה" }); msg("race", "OUTBOUND", 11); mark("race");
    const { prisma } = (await import("@chatcenter/shared")) as any;
    prisma.conversation.findFirst.mockImplementationOnce(async () => { msg("race", "INBOUND", 0, { body: "רגע" }); return H.convs[0]; });
    expect(await botIdleForTenant("T")).toEqual({ reminders: 0, closes: 0 });
    expect(byId("race").status).toBe("OPEN");
  });
});

describe("the reply window is closed (messaging)", () => {
  beforeEach(() => { H.config = null; defaultOn(); });
  const DAY_AGO = 26 * 60 * MIN;

  it("★ a reminder that cannot be sent: nothing is written, the conversation is as it was", async () => {
    H.convs = [conv("wa", { channel: "WHATSAPP", channelAccountId: "ca_wa" })];
    H.windows.sess_wa = ago(DAY_AGO);
    msg("wa", "OUTBOUND", 31);
    const before = { ...byId("wa") };
    expect(await botIdleForTenant("T")).toEqual({ reminders: 0, closes: 0 });
    expect(H.queued).toHaveLength(0);
    expect(H.msgs).toHaveLength(1);
    expect(byId("wa")).toEqual(before);
    expect(H.events).toHaveLength(0);
  });

  it("★ the window closed between the reminder and the close: closed with no message", async () => {
    H.convs = [conv("wa", { channel: "WHATSAPP", channelAccountId: "ca_wa" })];
    H.windows.sess_wa = ago(DAY_AGO);
    msg("wa", "OUTBOUND", 46);
    msg("wa", "OUTBOUND", 16, { body: TXT.he.reminder, metadata: { source: "idle_reminder" } });
    expect(await botIdleForTenant("T")).toEqual({ reminders: 0, closes: 1 });
    expect(H.queued).toHaveLength(0);
    expect(byId("wa").status).toBe("CLOSED");
  });
});

describe("the bot's close is the inbox's Resolve, said to be automatic", () => {
  it("★ conversation:closed carries the whole row (as a person's Resolve does) and why it closed", async () => {
    H.convs = [conv("web", { customerName: "דנה" })];
    msg("web", "OUTBOUND", 30);
    msg("web", "OUTBOUND", 11, { body: A, metadata: { source: "idle_reminder" } });
    expect(await botIdleForTenant("T")).toEqual({ reminders: 0, closes: 1 });
    const closed = H.events.filter((e) => e.event === "conversation:closed");
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ tenantId: "T", data: { id: "web", status: "CLOSED", channel: "WEBCHAT", customerExternalId: "sess_web", customerName: "דנה", assignedAgent: null, closeReason: "bot_idle" } });
    expect(closed[0].data.closedAt).toBeInstanceOf(Date);
    expect(H.msgs.find((m) => m.messageType === "system")).toMatchObject({ tenantId: "T", conversationId: "web", direction: "INBOUND", senderName: "System", body: "", metadata: { systemEvent: "auto_closed", reason: "bot_idle" } });
  });

  it("★ a person took it, or it is closed already: nothing is closed, no event, no system message", async () => {
    H.convs = [conv("taken", { assignedAgentId: "u1" }), conv("handed", { isHandedOver: true }), conv("done", { status: "CLOSED" }), conv("email", { channel: "EMAIL" }), conv("other_tenant", { tenantId: "T2" })];
    for (const c of H.convs) expect(await closeByBot("T", c.id, ["WEBCHAT"], "bot_idle")).toBe(false);
    expect(H.events).toHaveLength(0);
    expect(H.msgs).toHaveLength(0);
    expect(byId("taken").status).toBe("OPEN");
    expect(byId("other_tenant").status).toBe("OPEN");
  });

  it("the reminder publishes conversation:updated and marks the conversation", async () => {
    H.convs = [conv("web")];
    msg("web", "OUTBOUND", 11);
    await botIdleForTenant("T");
    expect(H.events).toEqual([{ event: "conversation:updated", tenantId: "T", data: { id: "web" } }]);
    expect(byId("web").reminderSentAt).toBeInstanceOf(Date);
  });
});

describe("every candidate is looked at, a page at a time", () => {
  it("★ 450 due conversations: all 450 reminded (the first 500 were the limit before; the rows are read 200 at a time)", async () => {
    const n = SWEEP_PAGE * 2 + 50;
    H.convs = Array.from({ length: n }, (_, i) => conv(`c${i}`));
    for (const c of H.convs) msg(c.id, "OUTBOUND", 11);
    expect(await botIdleForTenant("T")).toEqual({ reminders: n, closes: 0 });
    expect(new Set(H.queued.map((q) => q.conversationId)).size).toBe(n);
    expect(H.reads[0].select).toEqual({ id: true });
    expect(H.reads[0].take).toBeUndefined();
    expect(H.reads.slice(1).map((r) => r.where.id.in.length)).toEqual([SWEEP_PAGE, SWEEP_PAGE, 50]);
    expect(H.reads.slice(1).every((r) => r.where.tenantId === "T")).toBe(true);
  });
});
