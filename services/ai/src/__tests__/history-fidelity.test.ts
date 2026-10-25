/**
 * The transcript says who wrote what, and when (2026-10-25, P1), and the
 * per-turn state note carries what the model should not have to infer.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@chatcenter/shared", () => ({ prisma: {} }));

import { historyChatMessages, buildStateNote, isHumanAgent, HISTORY_WINDOW } from "../services/conversation-history.service";

const T = Date.UTC(2026, 9, 25, 11, 0, 0); // 13:00 in Asia/Jerusalem (winter time from 25 Oct)
const row = (o: any) => ({ direction: "INBOUND", body: "", messageType: "text", senderName: null, ...o });

describe("★ who wrote it", () => {
  it("a human colleague's message is on the customer's side, labelled, never as the employee's own", () => {
    const chat = historyChatMessages([
      row({ body: "מתי זה יגיע?", createdAt: new Date(T) }),
      row({ direction: "OUTBOUND", senderName: "dana.levi@shop.co.il", body: "נשלח לך מחר קוד מעקב", createdAt: new Date(T + 60_000) }),
    ]);
    expect(chat[1]).toEqual({ role: "user", content: "[Human team member Dana, not you, wrote to the customer]: נשלח לך מחר קוד מעקב" });
  });
  it("the employee's own messages stay assistant, whatever name it signs with", () => {
    for (const senderName of ["AI Bot", "Noa", null]) {
      expect(historyChatMessages([row({ direction: "OUTBOUND", senderName, body: "יש ב-M" })])).toEqual([{ role: "assistant", content: "יש ב-M" }]);
    }
    expect(isHumanAgent(row({ direction: "OUTBOUND", senderName: "Noa" }))).toBe(false);
  });
});

describe("★ media and cards", () => {
  it("a photo with no caption: a marker that says the content is unseen", () => {
    const [m] = historyChatMessages([row({ messageType: "image", body: "[Image]" })]);
    expect(m.role).toBe("user");
    expect(m.content).toMatch(/^\[The customer sent a photo\. You cannot see or hear its content; never say or imply that you did\.\]$/);
  });
  it("a caption is kept, a voice note is named", () => {
    expect(historyChatMessages([row({ messageType: "image", body: "זה הצבע?" })])[0].content).toContain('Their caption: "זה הצבע?"');
    expect(historyChatMessages([row({ messageType: "audio", body: "[Voice message]" })])[0].content).toContain("a voice or audio message");
  });
  it("product cards read as cards shown, not as text the employee typed", () => {
    expect(historyChatMessages([row({ direction: "OUTBOUND", senderName: "AI Bot", messageType: "woo_product_carousel", body: "Chunky Cardigan - 529 ILS\nKnit Slip Dress - 299 ILS" })]))
      .toEqual([{ role: "assistant", content: "[Product cards shown to the customer: Chunky Cardigan - 529 ILS; Knit Slip Dress - 299 ILS]" }]);
  });
});

describe("★ time", () => {
  it("a silence over 6 hours gets a note before the next message; a short one does not", () => {
    const chat = historyChatMessages([
      row({ body: "היי", createdAt: new Date(T) }),
      row({ direction: "OUTBOUND", senderName: "AI Bot", body: "היי!", createdAt: new Date(T + 60_000) }),
      row({ body: "חזרתי", createdAt: new Date(T + 3 * 86_400_000) }),
    ]);
    expect(chat.map((m) => m.role)).toEqual(["user", "assistant", "system", "user"]);
    expect(chat[2].content).toMatch(/^\[3 days passed with no messages\. The next message is from /);
  });
  it("the model reads the last 40 verbatim; what is older becomes a note of facts", () => {
    const rows = Array.from({ length: 45 }, (_, i) => row({ body: `m${i + 1}`, createdAt: new Date(T + i * 1000) }));
    rows[0] = row({ body: "יש מעיל במידה M?", createdAt: new Date(T) });
    rows[1] = row({ direction: "OUTBOUND", senderName: "AI Bot", messageType: "woo_product", body: "Cotton Trench Coat - 799 ILS", createdAt: new Date(T + 500) });
    const chat = historyChatMessages(rows);
    expect(chat).toHaveLength(HISTORY_WINDOW + 1);
    expect(chat[0].role).toBe("system");
    expect(chat[0].content).toContain("- products shown: Cotton Trench Coat - 799 ILS");
    expect(chat[0].content).toContain('"יש מעיל במידה M?"');
    expect(chat[1].content).toBe("m6");
    expect(chat.at(-1)!.content).toBe("m45");
  });
});

describe("★ the state note", () => {
  const convo = [
    row({ body: "היי", createdAt: new Date(T) }),
    row({ direction: "OUTBOUND", senderName: "AI Bot", body: "היי! מה מחפשים היום?", createdAt: new Date(T + 30_000) }),
    row({ body: "קרדיגן חום", createdAt: new Date(T + 60_000) }),
    row({ direction: "OUTBOUND", senderName: "AI Bot", body: "כן, יש Chunky Cardigan ב-M", createdAt: new Date(T + 90_000) }),
    row({ body: "כמה עולה?", createdAt: new Date(T + 120_000) }),
  ];
  it("already spoke today: do not greet; the last two openers are named", () => {
    const note = buildStateNote({ rows: convo, now: T + 125_000 });
    expect(note).toContain("Local time: Sun, 25 Oct, 13:02 (Asia/Jerusalem)");
    expect(note).toContain("already spoke to the customer today (from 13:00). Do NOT greet");
    expect(note).toContain('Your last replies began with "היי! מה" and "כן, יש"');
    expect(note).toContain("never greet twice");
  });
  it("first reply: a short greeting is fine", () => {
    expect(buildStateNote({ rows: [convo[0]], now: T + 5000 })).toContain("This is the first reply in the conversation");
  });
  it("a new day: one short greeting allowed, and the gap is stated", () => {
    const note = buildStateNote({ rows: [...convo.slice(0, 4), row({ body: "שוב אני", createdAt: new Date(T + 2 * 86_400_000) })], now: T + 2 * 86_400_000 + 5000 });
    expect(note).toContain("Nothing was said to the customer yet today");
    expect(note).toContain("previous message was 2 days before this one");
  });
  it("the customer's form only from their own words, else neutral", () => {
    expect(buildStateNote({ rows: convo, now: T, customerForm: { form: "feminine", confidence: "explicit" } })).toContain("in the feminine form");
    expect(buildStateNote({ rows: convo, now: T, customerForm: { form: "feminine", confidence: "unknown" } })).toContain("address them neutrally");
    expect(buildStateNote({ rows: convo, now: T })).toContain("address them neutrally");
  });
  it("a colleague's commitment is listed as one to honour", () => {
    const note = buildStateNote({ rows: [...convo, row({ direction: "OUTBOUND", senderName: "dana@shop.co.il", body: "אעדכן אותך מחר בבוקר", createdAt: new Date(T + 130_000) })], now: T + 140_000 });
    expect(note).toContain("Commitments already made");
    expect(note).toContain('a human colleague (Dana): "אעדכן אותך מחר בבוקר"');
  });
});
