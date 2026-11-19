/**
 * The end mark (2026-11-19, Omer: conversations never got closed). The engine never closes: it marks the turn
 * whose customer message is an explicit end with nothing open, and the idle sweep closes the marked
 * conversation quietly a little later (incoming-worker bot-idle-automation.test.ts holds that half).
 */
import { describe, it, expect } from "vitest";
import { endMarkFact, endMarkRefusal, endMarkTime, type EndMarkInput } from "../services/reply-engine/end-mark";
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
