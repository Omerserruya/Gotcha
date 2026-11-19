/**
 * Bot idle, the shared rules (2026-11-19, Omer: conversations never got closed; one business had a row,
 * every other one had none). The numbers, who a row rules, the texts by language, the settings view, the
 * marked end and the reopen.
 */
import { describe, it, expect } from "vitest";
import {
  BOT_CLOSE_REOPEN_DAYS, BOT_IDLE_CHANNELS, BOT_IDLE_DEFAULT_MINUTES, BOT_IDLE_DEFAULT_TEXTS, BOT_IDLE_DELAY_MAX_MINUTES,
  MARKED_END_CLOSE_MINUTES, botIdleDefaultOn, botIdleGroupOf, botIdleLang, botIdleRuleFor, botIdleRules, botIdleText,
  botIdleView, botIdleWithGroups, markedEndStep, parseBotIdleRow, reopenBotClosed,
} from "../lib/bot-idle";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
// The one row that existed before the default: the website widget only, 10 + 10 minutes.
const FLAT = { reminderEnabled: true, reminderDelayMinutes: 10, reminderMessage: "היי, עדיין כאן?", autoCloseEnabled: true, autoCloseDelayMinutes: 10, autoCloseMessage: "סוגרת את השיחה בינתיים.", channels: ["WEBCHAT"] };
const row = (v: unknown) => parseBotIdleRow(v == null ? null : JSON.stringify(v));
const group = (over: Record<string, unknown> = {}) => ({ enabled: true, reminderAfterMinutes: 45, closeAfterReminderMinutes: 20, reminderText: "עוד כאן?", closeText: "", ...over });

describe("the numbers (Omer 2026-11-19)", () => {
  it("live chat 10 + 10, messaging 30 + 15, a marked end 10, reopen inside 7 days, a week at most", () => {
    expect(BOT_IDLE_DEFAULT_MINUTES).toEqual({ liveChat: { reminderAfter: 10, closeAfterReminder: 10 }, messaging: { reminderAfter: 30, closeAfterReminder: 15 } });
    expect(MARKED_END_CLOSE_MINUTES).toBe(10);
    expect(BOT_CLOSE_REOPEN_DAYS).toBe(7);
    expect(BOT_IDLE_DELAY_MAX_MINUTES).toBe(10080);
  });
  it("the groups: the two chat widgets; the three messaging channels; nothing else", () => {
    expect(["WEBCHAT", "SHOPIFY_LIVE_CHAT"].map(botIdleGroupOf)).toEqual(["liveChat", "liveChat"]);
    expect(["WHATSAPP", "INSTAGRAM", "MESSENGER"].map(botIdleGroupOf)).toEqual(["messaging", "messaging", "messaging"]);
    expect(["EMAIL", "SMS", "", null, undefined].map(botIdleGroupOf)).toEqual([null, null, null, null, null]);
    expect([...BOT_IDLE_CHANNELS].sort()).toEqual(["INSTAGRAM", "MESSENGER", "SHOPIFY_LIVE_CHAT", "WEBCHAT", "WHATSAPP"]);
  });
  it("the default texts name nobody as closing, in either gender", () => {
    for (const t of [BOT_IDLE_DEFAULT_TEXTS.he.reminder, BOT_IDLE_DEFAULT_TEXTS.he.close]) expect(t).not.toMatch(/סוגרת|סוגר(?![א-ת])|היי/);
    expect(BOT_IDLE_DEFAULT_TEXTS.he.close).toBe("סגרנו את השיחה בינתיים. אפשר לכתוב כאן שוב בכל רגע.");
    expect(BOT_IDLE_DEFAULT_TEXTS.en.reminder).toBe("Still here? You can pick this up any time.");
  });
});

describe("the one switch", () => {
  it("unset, empty, off words or anything else: off; an on word: on", () => {
    for (const v of [undefined, "", " ", "off", "0", "false", "no", "enabled"]) expect(botIdleDefaultOn({ BOT_IDLE_DEFAULT_ON: v })).toBe(false);
    for (const v of ["on", "1", "true", "yes", "ON", " on "]) expect(botIdleDefaultOn({ BOT_IDLE_DEFAULT_ON: v })).toBe(true);
    expect(botIdleDefaultOn({})).toBe(false);
  });
});

describe("who rules a channel", () => {
  it("★ no row, the switch off: nothing runs anywhere (exactly as before)", () => {
    expect(botIdleRules(row(null), false)).toEqual({});
    expect(botIdleRuleFor("WHATSAPP", row(null), false)).toBeNull();
  });
  it("★ no row, the switch on: every channel of the two groups, with its group's numbers", () => {
    const rules = botIdleRules(row(null), true);
    expect(Object.keys(rules).sort()).toEqual(["INSTAGRAM", "MESSENGER", "SHOPIFY_LIVE_CHAT", "WEBCHAT", "WHATSAPP"]);
    expect(rules.WEBCHAT).toMatchObject({ reminderEnabled: true, reminderDelayMinutes: 10, autoCloseEnabled: true, autoCloseDelayMinutes: 10, source: "default" });
    expect(rules.SHOPIFY_LIVE_CHAT).toMatchObject({ reminderDelayMinutes: 10, autoCloseDelayMinutes: 10 });
    for (const ch of ["WHATSAPP", "INSTAGRAM", "MESSENGER"]) expect(rules[ch]).toMatchObject({ reminderDelayMinutes: 30, autoCloseDelayMinutes: 15, source: "default" });
    expect(botIdleRuleFor("EMAIL", row(null), true)).toBeNull();
  });
  it("★ the row that existed (WEBCHAT only): it rules WEBCHAT with its own words, switch on or off; the default rules the rest only when on", () => {
    expect(botIdleRules(row(FLAT), false)).toEqual({ WEBCHAT: { reminderEnabled: true, reminderDelayMinutes: 10, reminderMessage: "היי, עדיין כאן?", autoCloseEnabled: true, autoCloseDelayMinutes: 10, autoCloseMessage: "סוגרת את השיחה בינתיים.", source: "custom" } });
    const on = botIdleRules(row(FLAT), true);
    expect(on.WEBCHAT).toMatchObject({ reminderMessage: "היי, עדיין כאן?", source: "custom" });
    expect(on.SHOPIFY_LIVE_CHAT).toMatchObject({ source: "default", reminderDelayMinutes: 10 });
    expect(on.WHATSAPP).toMatchObject({ source: "default", reminderDelayMinutes: 30 });
  });
  it("★ a row with both steps off means off for the channels it lists: the default does not step in there", () => {
    const off = row({ ...FLAT, reminderEnabled: false, autoCloseEnabled: false, channels: ["WEBCHAT", "WHATSAPP"] });
    const rules = botIdleRules(off, true);
    expect(rules.WEBCHAT).toBeUndefined();
    expect(rules.WHATSAPP).toBeUndefined();
    expect(Object.keys(rules).sort()).toEqual(["INSTAGRAM", "MESSENGER", "SHOPIFY_LIVE_CHAT"]);
    expect(botIdleRules(off, false)).toEqual({});
  });
  it("a row without channels lists the website widget; one step alone stays as the row says", () => {
    const { channels: _c, ...noChannels } = FLAT;
    expect(Object.keys(botIdleRules(row(noChannels), false))).toEqual(["WEBCHAT"]);
    expect(botIdleRuleFor("WEBCHAT", row({ ...FLAT, reminderEnabled: false }), false)).toMatchObject({ reminderEnabled: false, autoCloseEnabled: true });
  });
  it("★ a saved group rules every channel of the group, ahead of the first shape; off means off", () => {
    const saved = row({ ...FLAT, groups: { liveChat: group() } });
    expect(botIdleRuleFor("WEBCHAT", saved, false)).toEqual({ reminderEnabled: true, reminderDelayMinutes: 45, reminderMessage: "עוד כאן?", autoCloseEnabled: true, autoCloseDelayMinutes: 20, autoCloseMessage: "", source: "custom" });
    expect(botIdleRuleFor("SHOPIFY_LIVE_CHAT", saved, false)).toMatchObject({ reminderDelayMinutes: 45, source: "custom" });
    expect(botIdleRuleFor("WHATSAPP", saved, false)).toBeNull();
    expect(botIdleRuleFor("WHATSAPP", saved, true)).toMatchObject({ source: "default" });
    const off = row({ ...FLAT, groups: { liveChat: group({ enabled: false }), messaging: group({ enabled: false }) } });
    expect(botIdleRules(off, true)).toEqual({});
  });
  it("an unreadable row, or a group without its on/off, is no row and no group", () => {
    expect(parseBotIdleRow("{not json")).toEqual({ flat: null, groups: {}, raw: {} });
    expect(parseBotIdleRow("[1]").flat).toBeNull();
    expect(row({ groups: { liveChat: { reminderAfterMinutes: 5 } } }).groups).toEqual({});
    expect(row({ groups: { messaging: { enabled: true, reminderAfterMinutes: 0, closeAfterReminderMinutes: "x" } } }).groups.messaging)
      .toEqual({ enabled: true, reminderAfterMinutes: 30, closeAfterReminderMinutes: 15, reminderText: "", closeText: "" });
  });
});

describe("the text of a step follows the conversation's language", () => {
  const def = botIdleRuleFor("WHATSAPP", row(null), true)!;
  it("★ the default wording: Hebrew for a Hebrew conversation, English for an English one", () => {
    expect(botIdleText(def, "reminder", "he")).toBe("עדיין כאן? אפשר להמשיך מכאן בכל רגע.");
    expect(botIdleText(def, "close", "he")).toBe("סגרנו את השיחה בינתיים. אפשר לכתוב כאן שוב בכל רגע.");
    expect(botIdleText(def, "reminder", "en")).toBe("Still here? You can pick this up any time.");
    expect(botIdleText(def, "close", "en")).toBe("We've closed this chat for now. You can write here again any time.");
  });
  it("★ the default wording saved unchanged from the screen (in the workspace's language) still follows the conversation", () => {
    const saved = botIdleRuleFor("WHATSAPP", row({ groups: { messaging: group({ reminderText: BOT_IDLE_DEFAULT_TEXTS.he.reminder, closeText: BOT_IDLE_DEFAULT_TEXTS.he.close }) } }), false)!;
    expect(botIdleText(saved, "reminder", "en")).toBe(BOT_IDLE_DEFAULT_TEXTS.en.reminder);
    expect(botIdleText(saved, "close", "en")).toBe(BOT_IDLE_DEFAULT_TEXTS.en.close);
  });
  it("★ a text the business wrote goes out as written, in any conversation; an empty close text stays empty", () => {
    const own = botIdleRuleFor("WEBCHAT", row(FLAT), false)!;
    expect(botIdleText(own, "reminder", "en")).toBe("היי, עדיין כאן?");
    expect(botIdleText(own, "close", "en")).toBe("סוגרת את השיחה בינתיים.");
    expect(botIdleText(botIdleRuleFor("WEBCHAT", row({ groups: { liveChat: group() } }), false)!, "close", "he")).toBe("");
  });
  it("the language: the detected one; with none, the letters of the last message", () => {
    expect(botIdleLang("he", "thanks")).toBe("he");
    expect(botIdleLang("iw-IL", "")).toBe("he");
    expect(botIdleLang("en", "תודה")).toBe("en");
    expect(botIdleLang("ru", "спасибо")).toBe("en");
    expect(botIdleLang(null, "תודה רבה")).toBe("he");
    expect(botIdleLang("", "thanks a lot")).toBe("en");
    expect(botIdleLang(undefined, null)).toBe("en");
  });
});

describe("what the settings screen reads", () => {
  it("★ no row: both groups are the default, on only when the switch is on, texts in the workspace's language", () => {
    expect(botIdleView(row(null), true, "he")).toEqual({
      liveChat: { enabled: true, reminderAfterMinutes: 10, closeAfterReminderMinutes: 10, reminderText: BOT_IDLE_DEFAULT_TEXTS.he.reminder, closeText: BOT_IDLE_DEFAULT_TEXTS.he.close, source: "default" },
      messaging: { enabled: true, reminderAfterMinutes: 30, closeAfterReminderMinutes: 15, reminderText: BOT_IDLE_DEFAULT_TEXTS.he.reminder, closeText: BOT_IDLE_DEFAULT_TEXTS.he.close, source: "default" },
    });
    const off = botIdleView(row(null), false, "en");
    expect(off.liveChat).toMatchObject({ enabled: false, source: "default", reminderText: BOT_IDLE_DEFAULT_TEXTS.en.reminder });
    expect(off.messaging).toMatchObject({ enabled: false, source: "default", reminderAfterMinutes: 30 });
  });
  it("★ the row that existed reads as the live chat group's own values; messaging stays the default", () => {
    const v = botIdleView(row(FLAT), true, "he");
    expect(v.liveChat).toEqual({ enabled: true, reminderAfterMinutes: 10, closeAfterReminderMinutes: 10, reminderText: "היי, עדיין כאן?", closeText: "סוגרת את השיחה בינתיים.", source: "custom" });
    expect(v.messaging.source).toBe("default");
    expect(botIdleView(row({ ...FLAT, reminderEnabled: false, autoCloseEnabled: false }), true, "he").liveChat).toMatchObject({ enabled: false, source: "custom" });
  });
  it("a saved group reads back as saved", () => {
    expect(botIdleView(row({ groups: { messaging: group({ enabled: false }) } }), true, "en").messaging).toEqual({ ...group({ enabled: false }), source: "custom" });
  });
});

describe("a save of one group or both", () => {
  it("★ one group saved: the other group and the first shape stay as they were", () => {
    const first = botIdleWithGroups(JSON.stringify(FLAT), { messaging: group() });
    expect(JSON.parse(first)).toEqual({ ...FLAT, groups: { messaging: group() } });
    const second = botIdleWithGroups(first, { liveChat: group({ enabled: false }) });
    expect(JSON.parse(second)).toEqual({ ...FLAT, groups: { messaging: group(), liveChat: group({ enabled: false }) } });
    // The saved live chat group now rules WEBCHAT, ahead of the first shape.
    expect(botIdleRules(parseBotIdleRow(second), false)).toEqual({ WHATSAPP: expect.any(Object), INSTAGRAM: expect.any(Object), MESSENGER: expect.any(Object) });
  });
  it("no row yet, or an unreadable one: the row is the groups alone", () => {
    expect(JSON.parse(botIdleWithGroups(null, { liveChat: group() }))).toEqual({ groups: { liveChat: group() } });
    expect(JSON.parse(botIdleWithGroups("{oops", { liveChat: group() }))).toEqual({ groups: { liveChat: group() } });
  });
});

describe("the marked end", () => {
  const now = Date.parse("2026-11-19T12:00:00.000Z");
  const at = (minutesAgo: number) => new Date(now - minutesAgo * MIN);
  const bot = (minutesAgo: number, over: Record<string, unknown> = {}) => ({ direction: "OUTBOUND", createdAt: at(minutesAgo), botOutbound: true, idleSource: false, ...over });
  const customer = (minutesAgo: number) => ({ direction: "INBOUND", createdAt: at(minutesAgo), botOutbound: false, idleSource: false });
  const step = (a: Partial<Parameters<typeof markedEndStep>[0]>) => markedEndStep({ endedAt: at(12).toISOString(), last: bot(11), lastInboundAt: at(12), lateMinutes: 60, now, ...a });

  it("★ \"תודה\" marked, the bot's \"בשמחה\" last, 10 minutes of quiet: close", () => {
    expect(step({})).toBe("close");
    expect(step({ last: bot(10) })).toBe("close");
  });
  it("★ not yet 10 minutes: wait (no reminder either)", () => {
    expect(step({ last: bot(9.9) })).toBe("wait");
    expect(step({ endedAt: at(3).toISOString(), last: bot(2), lastInboundAt: at(3) })).toBe("wait");
  });
  it("★ the bot said nothing after the goodbye: the customer's message is last, the same rule", () => {
    expect(step({ last: customer(12) })).toBe("close");
    expect(step({ endedAt: at(5).toISOString(), last: customer(5), lastInboundAt: at(5) })).toBe("wait");
  });
  it("★ the customer wrote again after the mark: the mark is void, the usual rule decides", () => {
    expect(step({ lastInboundAt: at(11.5), last: bot(11) })).toBeNull();
    expect(step({ lastInboundAt: at(1), last: customer(1) })).toBeNull();
  });
  it("★ long past due (an old backlog): wait, never a close and never a reminder", () => {
    expect(step({ endedAt: at(71).toISOString(), last: bot(70), lastInboundAt: at(71) })).toBe("wait");
    expect(step({ endedAt: at(14 * 24 * 60).toISOString(), last: bot(14 * 24 * 60 - 1), lastInboundAt: at(14 * 24 * 60) })).toBe("wait");
    expect(step({ endedAt: at(70).toISOString(), last: bot(69.9), lastInboundAt: at(70) })).toBe("close");
  });
  it("a person wrote last, or our own reminder is last: the mark does not act", () => {
    expect(step({ last: bot(11, { botOutbound: false }) })).toBeNull();
    expect(step({ last: bot(11, { idleSource: true }) })).toBeNull();
  });
  it("no mark, an emptied one, an unreadable one, no last message, no customer message: null", () => {
    for (const endedAt of [undefined, null, "", "soon", 12, {}]) expect(step({ endedAt })).toBeNull();
    expect(step({ last: null })).toBeNull();
    expect(step({ lastInboundAt: null })).toBeNull();
  });
});

describe("reopen: the customer's next message carries on the conversation the bot closed", () => {
  const now = Date.parse("2026-11-19T12:00:00.000Z");
  function db(conv: any, events: any[]) {
    const calls: any[] = [];
    return {
      calls,
      conv,
      conversation: {
        findFirst: async (a: any) => (conv && conv.id === a.where.id && conv.tenantId === a.where.tenantId && conv.status === a.where.status ? { id: conv.id, closedAt: conv.closedAt } : null),
        updateMany: async (a: any) => {
          calls.push(a);
          if (!conv || conv.id !== a.where.id || conv.tenantId !== a.where.tenantId || conv.status !== a.where.status) return { count: 0 };
          Object.assign(conv, a.data);
          return { count: 1 };
        },
      },
      message: {
        findFirst: async (a: any) => {
          expect(a.where).toMatchObject({ tenantId: "T", conversationId: "c1", messageType: "system" });
          expect(a.orderBy).toEqual({ createdAt: "desc" });
          return [...events].sort((x, y) => +y.createdAt - +x.createdAt)[0] ?? null;
        },
      },
    };
  }
  const closed = (daysAgo: number, over: any = {}) => ({ id: "c1", tenantId: "T", status: "CLOSED", closedAt: new Date(now - daysAgo * DAY), reminderSentAt: new Date(now - daysAgo * DAY - 10 * MIN), ...over });
  const event = (daysAgo: number, reason: string | undefined, systemEvent = "auto_closed", shiftMs = 0) => ({ createdAt: new Date(now - daysAgo * DAY + shiftMs), metadata: { systemEvent, ...(reason ? { reason } : {}) } });
  const run = (d: any, over: any = {}) => reopenBotClosed(d, { tenantId: "T", conversationId: "c1", maxDays: BOT_CLOSE_REOPEN_DAYS, now, ...over });

  it("★ closed for silence two days ago: open again, the close time and the reminder mark cleared", async () => {
    const d = db(closed(2), [event(2, "bot_idle", "auto_closed", 800)]);
    expect(await run(d)).toBe(true);
    expect(d.conv).toMatchObject({ status: "OPEN", closedAt: null, reminderSentAt: null });
    expect(d.calls[0].where).toEqual({ id: "c1", tenantId: "T", status: "CLOSED" });
  });
  it("★ closed because the customer ended it: reopened the same way", async () => {
    expect(await run(db(closed(0.01), [event(0.01, "customer_ended")]))).toBe(true);
  });
  it("★ a person closed it (no close event at all): stays closed, a new conversation starts", async () => {
    const d = db(closed(1), []);
    expect(await run(d)).toBe(false);
    expect(d.conv.status).toBe("CLOSED");
    expect(d.calls).toHaveLength(0);
  });
  it("★ the bot closed it, the customer came back, and then a person closed it: the old bot event does not reopen it", async () => {
    // The newest system event is still the bot's close of five days ago; the conversation closed again today.
    expect(await run(db(closed(0.1), [event(5, "bot_idle")]))).toBe(false);
  });
  it("another automatic close (the person-idle one), or another system event after it: stays closed", async () => {
    expect(await run(db(closed(1), [event(1, "idle")]))).toBe(false);
    expect(await run(db(closed(1), [event(1, undefined)]))).toBe(false);
    expect(await run(db(closed(1), [event(1, "bot_idle"), event(0.999, undefined, "handoff")]))).toBe(false);
  });
  it("★ inside 7 days: reopened; past them: a new conversation; no limit given: reopened whenever", async () => {
    expect(await run(db(closed(6.9), [event(6.9, "bot_idle")]))).toBe(true);
    expect(await run(db(closed(7.1), [event(7.1, "bot_idle")]))).toBe(false);
    expect(await run(db(closed(40), [event(40, "bot_idle")]), { maxDays: null })).toBe(true);
    expect(await run(db(closed(40), [event(40, "bot_idle")]), { maxDays: undefined })).toBe(true);
  });
  it("not closed, another tenant's, or reopened by someone else in the meantime: false", async () => {
    expect(await run(db(closed(1, { status: "OPEN" }), [event(1, "bot_idle")]))).toBe(false);
    expect(await run(db(closed(1, { tenantId: "other" }), [event(1, "bot_idle")]))).toBe(false);
    const raced = db(closed(1), [event(1, "bot_idle")]);
    raced.conversation.updateMany = async () => ({ count: 0 });
    expect(await run(raced)).toBe(false);
  });
});
