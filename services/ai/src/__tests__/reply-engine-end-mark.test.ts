/**
 * The end mark (2026-11-19, Omer: conversations never got closed). The engine never closes: it marks the turn
 * whose customer message is an explicit end with nothing open, and the idle sweep closes the marked
 * conversation quietly a little later (incoming-worker bot-idle-automation.test.ts holds that half).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  endMarkFact, endMarkRefusal, endMarkTime, type EndMarkInput,
  closeCallRefusal, customerEnded, quietCloseRuns, closeWasDeferred, closeHeldBack,
  CLOSE_TOOL, CLOSE_DEFERRED, CLOSE_NOT_ALLOWED, CLOSE_DEFERRED_TEXT, CLOSE_NOT_ALLOWED_TEXT,
} from "../services/reply-engine/end-mark";
import { errorCodeOf } from "../services/reply-engine/tools";
import { ENDED_FACT, BOT_IDLE_SOURCE } from "@chatcenter/shared/src/lib/bot-idle";
import { TEAM_OPEN_MS } from "../services/reply-engine/state";

const T0 = Date.parse("2026-11-19T10:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const bot = (body: string, minutes: number, over: any = {}) => ({ direction: "OUTBOUND", senderName: "AI Bot", body, messageType: "text", createdAt: at(minutes), metadata: { source: "ai_bot" }, ...over });
const customer = (body: string, minutes: number, over: any = {}) => ({ direction: "INBOUND", senderName: "דנה", body, messageType: "text", createdAt: at(minutes), metadata: null, ...over });

/** The customer asked, the bot answered with a statement, and now this message arrives. */
const turn = (incoming: string, over: Partial<EndMarkInput> = {}): EndMarkInput => ({
  incoming,
  history: [customer("מתי ההזמנה שלי יוצאת?", 0), bot("ההזמנה יוצאת מחר בבוקר.", 1), customer(incoming, 5)],
  reply: "בשמחה!",
  handoff: false,
  awaitingApproval: false,
  pending: [],
  turnStartedAt: T0 + 6 * 60_000,
  now: T0 + 6 * 60_000,
  ...over,
});
const MARKED = { [ENDED_FACT]: at(5).toISOString() };

describe("the turn is marked as an end", () => {
  it("★ a thanks or a goodbye after the bot answered, nothing open: marked at the customer's message", () => {
    for (const said of ["תודה רבה", "תודה!", "סבבה תודה", "זהו, תודה", "ביי", "thanks, bye", "that's all, thank you", "شكرا"]) {
      expect([said, endMarkRefusal(turn(said))]).toEqual([said, null]);
      expect(endMarkFact(undefined, turn(said))).toEqual(MARKED);
    }
  });

  it("the bot says nothing this turn: still an end", () => {
    expect(endMarkFact(undefined, turn("תודה", { reply: "" }))).toEqual(MARKED);
    expect(endMarkFact(undefined, turn("תודה", { reply: null }))).toEqual(MARKED);
  });

  it("★ the idle reminder is not the bot's question: \"תודה\" after \"עדיין כאן?\" is an end", () => {
    const history = [customer("מתי ההזמנה יוצאת?", 0), bot("ההזמנה יוצאת מחר בבוקר.", 1), bot("עדיין כאן? אפשר להמשיך מכאן בכל רגע.", 12, { metadata: { source: BOT_IDLE_SOURCE.reminder } }), customer("תודה", 13)];
    expect(endMarkFact(undefined, turn("תודה", { history }))).toEqual({ [ENDED_FACT]: at(13).toISOString() });
  });

  it("a team question that was open more than three days ago no longer holds the conversation", () => {
    const old = new Date(T0 - TEAM_OPEN_MS - 60_000).toISOString();
    expect(endMarkRefusal(turn("תודה", { pending: [{ kind: "promise", text: "checking with the team: מלאי", at: old }] }))).toBeNull();
  });
});

describe("the turn is not an end", () => {
  it("★ the customer's message is not an explicit end", () => {
    expect(endMarkRefusal(turn("תודה, ומתי זה מגיע?"))).toBe("question");
    expect(endMarkRefusal(turn("תודה אבל רציתי לשאול משהו"))).toBe("new_need");
    expect(endMarkRefusal(turn("אוקיי"))).toBe("not_an_end");
    expect(endMarkRefusal(turn("תודה רבה על העזרה אני אבדוק עם בעלי ואחזור אליכם מחר בבוקר"))).toBe("too_long");
    for (const said of ["תודה, ומתי זה מגיע?", "אוקיי", ""]) expect(endMarkFact(undefined, turn(said))).toEqual({});
  });

  it("★ a first message, or one the bot never answered in words: not an end", () => {
    expect(endMarkRefusal(turn("תודה", { history: [customer("תודה", 5)] }))).toBe("no_reply_yet");
    // A holding line, an interim acknowledgement, a product card, a person's message and the idle texts are not the bot's answer.
    const notAnswers = [
      bot("רגע, בודקת.", 1, { metadata: { kind: "interim_ack" } }), bot("עדיין בודקים, נחזור אליך.", 2, { metadata: { kind: "holding" } }),
      bot("חולצה כחולה - 120 ILS", 2, { messageType: "shopify_product" }), bot("אני בודקת ומיד חוזרת", 3, { senderName: "dana@shop.co.il" }),
      bot("היי, מה שלומך", 3, { metadata: { source: "whatsapp_business_app" } }), bot("סגרנו את השיחה בינתיים.", 4, { metadata: { source: BOT_IDLE_SOURCE.close } }), bot("  ", 4),
    ];
    expect(endMarkRefusal(turn("תודה", { history: [customer("יש לכם חולצות?", 0), ...notAnswers, customer("תודה", 5)] }))).toBe("no_reply_yet");
  });

  it("★ \"כן תודה\" after the bot's own question is a yes, not a goodbye", () => {
    const history = [customer("איפה ההזמנה שלי?", 0), bot("רוצה שאבדוק מה המצב של ההזמנה?", 1), customer("כן תודה", 5)];
    expect(endMarkRefusal(turn("כן תודה", { history }))).toBe("answers_our_question");
    expect(endMarkFact(undefined, turn("כן תודה", { history }))).toEqual({});
    // Only the bot's LAST spoken message counts: a question further back does not hold the end.
    const later = [customer("איפה ההזמנה?", 0), bot("רוצה שאבדוק?", 1), customer("כן", 2), bot("ההזמנה יוצאת מחר בבוקר.", 3), customer("תודה", 5)];
    expect(endMarkRefusal(turn("תודה", { history: later }))).toBeNull();
  });

  it("★ the reply of this turn asks something: the bot is waiting for an answer", () => {
    expect(endMarkRefusal(turn("תודה", { reply: "בשמחה! רוצה שאשלח גם את מדריך המידות?" }))).toBe("reply_asks");
    expect(endMarkRefusal(turn("thanks", { reply: "You're welcome. Anything else?" }))).toBe("reply_asks");
  });

  it("★ something is open: a handoff, an approval, a question with the team", () => {
    expect(endMarkRefusal(turn("תודה", { handoff: true }))).toBe("handoff");
    expect(endMarkRefusal(turn("תודה", { awaitingApproval: true }))).toBe("approval");
    expect(endMarkRefusal(turn("תודה", { pending: [{ kind: "approval", text: "refund", at: at(2).toISOString() }] }))).toBe("approval");
    expect(endMarkRefusal(turn("תודה", { pending: [{ kind: "promise", text: "checking with the team: האם יש מלאי במידה 42", at: at(2).toISOString() }] }))).toBe("open_team_item");
    // A team item with no readable time is held as open.
    expect(endMarkRefusal(turn("תודה", { pending: [{ kind: "promise", text: "checking with the team: מלאי" }] }))).toBe("open_team_item");
    // The model's own note of a plain promise is not a team item.
    expect(endMarkRefusal(turn("תודה", { pending: [{ kind: "promise", text: "send the size guide", at: at(2).toISOString() }] }))).toBeNull();
  });
});

describe("an earlier mark", () => {
  it("★ a later turn that is not an end empties it; with no mark standing, nothing is written", () => {
    const history = [customer("מתי זה יוצא?", 0), bot("מחר בבוקר.", 1), customer("תודה", 5), bot("בשמחה!", 6), customer("רגע, יש משלוח לאילת?", 8)];
    const next = turn("רגע, יש משלוח לאילת?", { history });
    expect(endMarkFact(MARKED[ENDED_FACT], next)).toEqual({ [ENDED_FACT]: "" });
    expect(endMarkFact("", next)).toEqual({});
    expect(endMarkFact(undefined, next)).toEqual({});
  });

  it("a second goodbye moves the mark to the newer message", () => {
    const history = [customer("מתי זה יוצא?", 0), bot("מחר בבוקר.", 1), customer("תודה", 5), bot("בשמחה!", 6), customer("יום טוב", 9)];
    expect(endMarkFact(MARKED[ENDED_FACT], turn("יום טוב", { history }))).toEqual({ [ENDED_FACT]: at(9).toISOString() });
  });
});

describe("the mark's time is the stored time of the customer's message", () => {
  it("★ the newest customer row when it is this turn's message; the closing system row is not a customer message", () => {
    const history = [bot("מחר בבוקר.", 1), customer("תודה", 5), { direction: "INBOUND", senderName: "System", body: "", messageType: "system", createdAt: at(5.5), metadata: { systemEvent: "auto_closed" } }];
    expect(endMarkTime({ incoming: " תודה ", history, turnStartedAt: T0 + 6 * 60_000 })).toBe(at(5).toISOString());
    expect(endMarkTime({ incoming: "תודה", history: [bot("מחר.", 1), customer("תודה", 5, { createdAt: at(5).toISOString() })], turnStartedAt: T0 })).toBe(at(5).toISOString());
  });

  it("★ several messages answered as one turn, or no stored row: the time the turn began", () => {
    const began = T0 + 6 * 60_000;
    expect(endMarkTime({ incoming: "אוקיי\nתודה", history: [bot("מחר.", 1), customer("אוקיי", 4), customer("תודה", 5)], turnStartedAt: began })).toBe(new Date(began).toISOString());
    expect(endMarkTime({ incoming: "תודה", history: [bot("מחר.", 1)], turnStartedAt: began })).toBe(new Date(began).toISOString());
    expect(endMarkTime({ incoming: "תודה", history: [customer("תודה", 5, { createdAt: "not a date" })], turnStartedAt: began })).toBe(new Date(began).toISOString());
  });
});

/**
 * The model's own close_conversation (2026-11-22). On dev a customer wrote "תודה רבה, זה הכל" after the bot's
 * "יש גופיית ריב בגווני שחור ואקרו, אבל לא בלבן." and the model closed the conversation at once. That close
 * writes no closing event, so nothing reopens it. The engine holds the call back instead.
 */
describe("the model's own close: refused, deferred, or let through", () => {
  const STOCK = "יש גופיית ריב בגווני שחור ואקרו, אבל לא בלבן.";
  const after = (botLine: string, incoming: string) => [customer("יש גופיית ריב בלבן?", 0), bot(botLine, 1), customer(incoming, 5)];
  const call = (incoming: string, quietClose: boolean, history = after(STOCK, incoming)) => closeCallRefusal(CLOSE_TOOL, { incoming, history, quietClose });

  it("★ the dev case: a goodbye after an answer, the quiet close runs here: deferred", () => {
    expect(call("תודה רבה, זה הכל", true)).toBe(CLOSE_DEFERRED_TEXT);
    for (const said of ["תודה רבה", "לא תודה, זה הכל", "thanks, that's all", "ביי", "شكرا"]) expect([said, call(said, true)]).toEqual([said, CLOSE_DEFERRED_TEXT]);
  });

  it("★ a goodbye after the bot's own question is deferred too: the model called the close, the words are an end", () => {
    const history = after("יש בשחור ובאקרו. עוד משהו שאוכל לעזור בו?", "לא תודה, זה הכל");
    expect(call("לא תודה, זה הכל", true, history)).toBe(CLOSE_DEFERRED_TEXT);
  });

  it("★ a goodbye where no quiet close runs: the close goes through, because nothing else would close it", () => {
    for (const said of ["תודה רבה, זה הכל", "לא תודה, זה הכל", "thanks, that's all"]) expect([said, call(said, false)]).toEqual([said, null]);
  });

  it("★ the customer has not ended it: refused, whether or not the quiet close runs", () => {
    for (const quiet of [true, false]) {
      for (const said of ["מתי יחזרו למלאי?", "תודה, אבל עוד שאלה", "אוקיי", "יש גם בכחול", "", "תודה רבה על העזרה אני אבדוק עם בעלי ואחזור אליכם מחר בבוקר"]) {
        expect([quiet, said, call(said, quiet)]).toEqual([quiet, said, CLOSE_NOT_ALLOWED_TEXT]);
      }
    }
  });

  it("★ a first message, or a goodbye the bot never answered in words: refused", () => {
    for (const quiet of [true, false]) {
      expect(closeCallRefusal(CLOSE_TOOL, { incoming: "תודה", history: [customer("תודה", 0)], quietClose: quiet })).toBe(CLOSE_NOT_ALLOWED_TEXT);
      // A person's message and the idle reminder are not the bot's answer.
      const person = [customer("יש בלבן?", 0), bot("בודקת ומעדכנת", 1, { senderName: "roni@shop.example", metadata: null }), customer("תודה", 5)];
      expect(closeCallRefusal(CLOSE_TOOL, { incoming: "תודה", history: person, quietClose: quiet })).toBe(CLOSE_NOT_ALLOWED_TEXT);
      const reminderOnly = [customer("יש בלבן?", 0), bot("עדיין כאן?", 12, { metadata: { source: BOT_IDLE_SOURCE.reminder } }), customer("תודה", 13)];
      expect(closeCallRefusal(CLOSE_TOOL, { incoming: "תודה", history: reminderOnly, quietClose: quiet })).toBe(CLOSE_NOT_ALLOWED_TEXT);
    }
  });

  it("only the close tool: every other call is none of this rule's business", () => {
    for (const tool of ["escalate_to_human", "woocommerce.list_products", "schedule_followup", "close", "crm.close_conversation", "close_conversation_now", ""]) {
      expect([tool, closeCallRefusal(tool, { incoming: "מתי יחזרו למלאי?", history: after(STOCK, "מתי יחזרו למלאי?"), quietClose: true })]).toEqual([tool, null]);
      expect([tool, closeCallRefusal(tool, { incoming: "תודה", history: after(STOCK, "תודה"), quietClose: true })]).toEqual([tool, null]);
    }
  });

  it("customerEnded is the mark's own test: the same words, the same count of the bot's spoken messages", () => {
    expect(customerEnded("תודה רבה, זה הכל", after(STOCK, "תודה רבה, זה הכל"))).toBe(true);
    expect(customerEnded("מתי יחזרו למלאי?", after(STOCK, "מתי יחזרו למלאי?"))).toBe(false);
    expect(customerEnded("תודה", [customer("תודה", 0)])).toBe(false);
    expect(customerEnded(null, after(STOCK, ""))).toBe(false);
    expect(customerEnded(undefined, [])).toBe(false);
  });

  it("★ the words the model reads back, exactly (model-facing only), and the code the audit line carries", () => {
    expect(CLOSE_DEFERRED_TEXT).toBe(
      "close_deferred: the customer said goodbye. Do not close now: the conversation closes by itself a few minutes after a goodbye and stays open for a late message. " +
      "Answer the customer as you would answer any goodbye, and do not call close_conversation again.",
    );
    expect(CLOSE_NOT_ALLOWED_TEXT).toBe(
      "close_not_allowed: do NOT close this conversation. The customer has not ended it (an explicit thanks, bye or that's all after their need was met). " +
      "Answer their latest message and keep the conversation open.",
    );
    const record = (reason: string) => ({ tool: CLOSE_TOOL, decision: "deny", outcome: "denied", content: JSON.stringify({ ok: false, failure: "refused", reason }) });
    expect(errorCodeOf(record(CLOSE_DEFERRED_TEXT))).toBe("refused:close_deferred");
    expect(errorCodeOf(record(CLOSE_NOT_ALLOWED_TEXT))).toBe("refused:close_not_allowed");
    expect([CLOSE_TOOL, CLOSE_DEFERRED, CLOSE_NOT_ALLOWED]).toEqual(["close_conversation", "close_deferred", "close_not_allowed"]);
  });
});

describe("does the quiet close run for this conversation: the sweep's own two conditions", () => {
  const raw = (v: unknown) => JSON.stringify(v);
  const group = (enabled: boolean) => ({ enabled, reminderAfterMinutes: 45, closeAfterReminderMinutes: 20, reminderText: "", closeText: "" });
  const flat = (channels: string[], on = true) => ({ reminderEnabled: on, reminderDelayMinutes: 10, reminderMessage: "", autoCloseEnabled: on, autoCloseDelayMinutes: 10, autoCloseMessage: "", channels });

  it("★ no saved setting, the default on: every channel of the two groups, and no other", () => {
    for (const ch of ["WEBCHAT", "SHOPIFY_LIVE_CHAT", "WHATSAPP", "INSTAGRAM", "MESSENGER"]) expect([ch, quietCloseRuns(ch, null, true)]).toEqual([ch, true]);
    for (const ch of ["EMAIL", "SMS", "TELEGRAM", "", null, undefined]) expect([ch, quietCloseRuns(ch, null, true)]).toEqual([ch, false]);
  });

  it("★ the default off: never, whatever the business saved (the sweep closes a marked end only with it on)", () => {
    for (const row of [null, "", raw({ groups: { liveChat: group(true), messaging: group(true) } }), raw(flat(["WEBCHAT", "EMAIL"]))]) {
      for (const ch of ["WEBCHAT", "WHATSAPP", "EMAIL"]) expect([row, ch, quietCloseRuns(ch, row, false)]).toEqual([row, ch, false]);
    }
  });

  it("★ a business that switched its group off: nothing runs on that group's channels, the other group is untouched", () => {
    const row = raw({ groups: { liveChat: group(false) } });
    expect(quietCloseRuns("WEBCHAT", row, true)).toBe(false);
    expect(quietCloseRuns("SHOPIFY_LIVE_CHAT", row, true)).toBe(false);
    expect(quietCloseRuns("WHATSAPP", row, true)).toBe(true);
    expect(quietCloseRuns("WEBCHAT", raw({ groups: { liveChat: group(true) } }), true)).toBe(true);
    expect(quietCloseRuns("WHATSAPP", raw({ groups: { messaging: group(false) } }), true)).toBe(false);
  });

  it("the older flat setting: the channels it lists with a step on; both steps off is off", () => {
    expect(quietCloseRuns("EMAIL", raw(flat(["EMAIL"])), true)).toBe(true);
    expect(quietCloseRuns("EMAIL", raw(flat(["EMAIL"], false)), true)).toBe(false);
    expect(quietCloseRuns("WEBCHAT", raw(flat(["WEBCHAT"], false)), true)).toBe(false);
    // A channel the flat setting does not list follows the default.
    expect(quietCloseRuns("WHATSAPP", raw(flat(["WEBCHAT"], false)), true)).toBe(true);
    expect(quietCloseRuns("SMS", raw(flat(["WEBCHAT"])), true)).toBe(false);
  });

  it("an unreadable setting is no setting", () => {
    for (const row of ["{not json", "[]", "null", "7"]) expect([row, quietCloseRuns("WEBCHAT", row, true), quietCloseRuns("EMAIL", row, true)]).toEqual([row, true, false]);
  });
});

describe("a held-back close in the turn's records", () => {
  const rec = (over: Record<string, unknown> = {}) => ({ tool: CLOSE_TOOL, decision: "deny", content: JSON.stringify({ ok: false, failure: "refused", reason: CLOSE_DEFERRED_TEXT }), ...over });
  const notAllowed = rec({ content: JSON.stringify({ ok: false, failure: "refused", reason: CLOSE_NOT_ALLOWED_TEXT }) });

  it("★ deferred is deferred; refused is held back but not deferred", () => {
    expect([closeWasDeferred(rec()), closeHeldBack(rec())]).toEqual([true, true]);
    expect([closeWasDeferred(notAllowed), closeHeldBack(notAllowed)]).toEqual([false, true]);
  });

  it("★ anything else is neither: another tool, a close that ran, a policy denial, another refusal, a broken result", () => {
    const others = [
      rec({ tool: "woocommerce.add_order_note" }),
      rec({ decision: "allow" }),
      rec({ decision: "approval" }),
      rec({ decision: "simulated" }),
      rec({ content: JSON.stringify({ ok: false, status: "denied", error: "Tool disabled by tenant" }) }),
      rec({ content: JSON.stringify({ ok: false, failure: "refused", reason: "not_asked: the customer did not ask for this" }) }),
      rec({ content: JSON.stringify({ ok: false, failure: "errored", reason: CLOSE_DEFERRED_TEXT }) }),
      rec({ content: JSON.stringify({ ok: false, failure: "refused", reason: "close_deferred_later: x" }) }),
      rec({ content: JSON.stringify({ ok: true, closed: true }) }),
      rec({ content: "not json" }),
      rec({ content: "" }),
      {},
    ];
    for (const r of others) expect([JSON.stringify(r), closeWasDeferred(r as any), closeHeldBack(r as any)]).toEqual([JSON.stringify(r), false, false]);
  });
});

describe("the mark on a turn whose close was deferred", () => {
  const ASKED = "יש בשחור ובאקרו. עוד משהו שאוכל לעזור בו?";
  const asked = (incoming: string, over: Partial<EndMarkInput> = {}) => turn(incoming, { history: [customer("יש גופיית ריב בלבן?", 0), bot(ASKED, 1), customer(incoming, 5)], ...over });

  it("★ the dev case needs no flag: the bot's message before \"תודה רבה, זה הכל\" asked nothing", () => {
    const plain = turn("תודה רבה, זה הכל", { history: [customer("יש גופיית ריב בלבן?", 0), bot("יש גופיית ריב בגווני שחור ואקרו, אבל לא בלבן.", 1), customer("תודה רבה, זה הכל", 5)] });
    expect(endMarkFact(undefined, plain)).toEqual(MARKED);
    expect(endMarkFact(undefined, { ...plain, closeDeferred: true })).toEqual(MARKED);
  });

  it("★ after the bot's question: no mark without a deferred close, the mark with one", () => {
    expect(endMarkRefusal(asked("לא תודה, זה הכל"))).toBe("answers_our_question");
    expect(endMarkFact(undefined, asked("לא תודה, זה הכל"))).toEqual({});
    expect(endMarkRefusal(asked("לא תודה, זה הכל", { closeDeferred: false }))).toBe("answers_our_question");
    expect(endMarkRefusal(asked("לא תודה, זה הכל", { closeDeferred: true }))).toBeNull();
    expect(endMarkFact(undefined, asked("לא תודה, זה הכל", { closeDeferred: true }))).toEqual(MARKED);
  });

  it("★ a deferred close skips only that one test: everything else still holds the conversation open", () => {
    const d = { closeDeferred: true };
    expect(endMarkRefusal(asked("לא תודה, זה הכל", { ...d, reply: "בשמחה! רוצה שאשלח קישור?" }))).toBe("reply_asks");
    expect(endMarkRefusal(asked("לא תודה, זה הכל", { ...d, handoff: true }))).toBe("handoff");
    expect(endMarkRefusal(asked("לא תודה, זה הכל", { ...d, awaitingApproval: true }))).toBe("approval");
    expect(endMarkRefusal(asked("לא תודה, זה הכל", { ...d, pending: [{ kind: "approval", text: "waiting for approval: x" }] }))).toBe("approval");
    expect(endMarkRefusal(asked("לא תודה, זה הכל", { ...d, pending: [{ kind: "promise", text: "checking with the team: מלאי", at: new Date(T0).toISOString() }] }))).toBe("open_team_item");
    // The words themselves still have to be an end.
    expect(endMarkRefusal(asked("כן, ומתי זה מגיע?", d))).toBe("question");
    expect(endMarkRefusal(asked("אוקיי", d))).toBe("not_an_end");
    expect(endMarkRefusal(turn("תודה", { ...d, history: [customer("תודה", 5)] }))).toBe("no_reply_yet");
  });
});

/**
 * The ai service defers the close, the incoming worker does the quiet close. If only the ai service had the
 * switch on, a deferred close would never be followed by anything.
 */
describe("the switch reaches both services with one value, in both compose files", () => {
  const valueOf = (file: string, service: string): string | null => {
    const lines = readFileSync(resolve(__dirname, "../../../..", file), "utf8").split("\n");
    const start = lines.indexOf(`  ${service}:`);
    if (start < 0) return null;
    for (const l of lines.slice(start + 1)) {
      if (/^  \S.*:\s*$/.test(l)) return null;
      const m = l.match(/^\s+BOT_IDLE_DEFAULT_ON:\s*(\S.*?)\s*$/);
      if (m) return m[1];
    }
    return null;
  };

  it("★ ai and incoming-worker read the same variable with the same default", () => {
    for (const file of ["docker-compose.yml", "docker-compose.prod.yml"]) {
      expect([file, valueOf(file, "ai"), valueOf(file, "incoming-worker")]).toEqual([file, "${BOT_IDLE_DEFAULT_ON:-off}", "${BOT_IDLE_DEFAULT_ON:-off}"]);
    }
  });

  it("the reader finds a line only inside the named service", () => {
    expect(valueOf("docker-compose.yml", "no-such-service")).toBeNull();
    expect(valueOf("docker-compose.yml", "conversation")).toBeNull();
  });
});
