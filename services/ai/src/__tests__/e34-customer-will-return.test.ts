/**
 * Smoovee prod 2026-11-13, WhatsApp conv cmweyp0940r1wkdj39ue69ui0:
 *   customer: "נתכתב בעזרת השם ביום ראשון"
 *   bot:      "נשאר רק לדעת איזו שעה ביום ראשון נוחה לך?"
 *   customer: "9 בבוקר"
 *   bot:      "אין לנו אפשרות לתאם זמן מכאן, רוצים שאעביר..."
 * The hour fed nothing. The customer said THEY would write, so there was
 * nothing of ours to schedule. The redundant-info corrective ("collect what is
 * still missing") and the follow-up flow (pin an hour for a date-only
 * deferral) both pushed for an hour anyway.
 *
 * Omer: the right answer is a short warm acknowledgement, no question and no
 * gathering of a time, e.g. "אין בעיה, נשמח לעמוד לרשותך בראשון".
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeBehaviorState, deriveTriggeredActions } from "../services/behavior-engine.service";
import { customerWillReturn, returnWhenHe, replyAsks, acknowledgementOnly, returnAcknowledgementCorrective } from "../services/customer-return.service";

const SAID = "נתכתב בעזרת השם ביום ראשון";
const BOT_ASKED = "נשאר רק לדעת איזו שעה ביום ראשון נוחה לך?";
const identity = { userType: "new" as const, crmRecord: { hasLead: false, hasContact: false } } as any;
const state = (lastMessage: string) => computeBehaviorState({ mode: "agent", identity, request: { lastMessage, messageCount: 6, previousAssistantText: "היי! איזה משטח מחפשים?" } } as any);

describe("★ the customer will write again", () => {
  it("is told apart from asking us to come back", () => {
    for (const t of [SAID, "אחזור אליכם מחר", "נדבר בשבוע הבא", "אעדכן אתכם", "נהיה בקשר", "I'll get back to you on Monday", "talk soon"]) {
      expect(customerWillReturn(t), t).toBe(true);
    }
    for (const t of ["תחזרו אליי ביום ראשון", "תתקשרו אליי ונדבר", "call me and we'll talk", "תתקשרו אליי מחר ב-10", "call me back at 3", "remind me tomorrow", "9 בבוקר", "אעדכן את הכתובת למשלוח", "כמה עולה אליס?"]) {
      expect(customerWillReturn(t), t).toBe(false);
    }
  });

  it("★ this exchange: posture customer_will_return, nothing required (no question, no follow-up), no follow_up trigger", () => {
    const s = state(SAID);
    expect(s.closurePosture).toBe("customer_will_return");
    expect(s.requiredActions).toEqual([]);
    expect(s.requiredActions).not.toContain("ask_question");
    expect(s.requiredActions).not.toContain("schedule_followup");
    expect(deriveTriggeredActions({ lastMessage: "let me think about it and i'll get back to you", closurePosture: "customer_will_return" })).not.toContain("follow_up");
  });

  it("control: asking US to come back on Sunday is still the follow-up flow", () => {
    expect(state("תחזרו אליי ביום ראשון").closurePosture).toBe("needs_followup");
    expect(state("call me tomorrow at 10").requiredActions).toContain("schedule_followup");
  });

  it("★ the expected outcome: the bot's question becomes the acknowledgement Omer asked for", () => {
    expect(replyAsks(BOT_ASKED)).toBe(true);
    const out = acknowledgementOnly(BOT_ASKED, "he", SAID);
    expect(out).toBe("אין בעיה, נשמח לעמוד לרשותך בראשון.");
    expect(replyAsks(out)).toBe(false);
    expect(out).not.toMatch(/שעה|מתי|טלפון|לצוות|להעביר/);
  });

  it("a reply that already acknowledges keeps its words, only the question goes", () => {
    expect(acknowledgementOnly("מעולה, נשמח לשמוע ממך בראשון! באיזו שעה נוח לך?", "he", SAID)).toBe("מעולה, נשמח לשמוע ממך בראשון!");
    expect(acknowledgementOnly("Sure! What time works?", "en", "talk soon")).toBe("Sure!");
    expect(acknowledgementOnly("What time works?", "en", "talk soon")).toBe("No problem, we'll be here whenever you're ready.");
  });

  it("the day in the customer's words, or none", () => {
    expect(returnWhenHe(SAID)).toBe("בראשון");
    expect(returnWhenHe("נדבר בשלישי")).toBe("בשלישי");
    expect(returnWhenHe("אחזור אליכם מחר")).toBe("מחר");
    expect(returnWhenHe("נהיה בקשר")).toBeNull();
    expect(acknowledgementOnly("?", "he", "נהיה בקשר")).toBe("אין בעיה, נשמח לעמוד לרשותך.");
  });

  it("the corrective asks for an acknowledgement and forbids a question or any detail", () => {
    const c = returnAcknowledgementCorrective("he");
    expect(c).toContain("אין בעיה, נשמח לעמוד לרשותך בראשון");
    expect(c).toMatch(/No question at all/);
    expect(c).toMatch(/Do not ask for a time, an hour, a phone number/);
    expect(c).not.toMatch(/still missing/);
  });
});

describe("★ the wiring: no gate turns the acknowledgement back into a question", () => {
  const bot = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
  const prompt = readFileSync(join(__dirname, "../services/prompt-builder.service.ts"), "utf8");

  it("the prompt has an acknowledge-only block for this posture", () => {
    const at = prompt.indexOf('closurePosture === "customer_will_return"');
    expect(at).toBeGreaterThan(0);
    const block = prompt.slice(at, at + 1200);
    expect(block).toContain("אין בעיה, נשמח לעמוד לרשותך בראשון");
    expect(block).toMatch(/No question at all/);
    expect(block).toMatch(/Do NOT call schedule_followup/);
  });

  it("the redundant-info gate acknowledges instead of 'collect what is still missing'", () => {
    expect(bot).toMatch(/content: customerReturns\s*\? returnAcknowledgementCorrective\(conversationLang\(\)\)/);
  });

  it("the passive-closer gate and the team offer leave it alone", () => {
    expect(bot).toMatch(/!customerIsClosing\(opts\.incomingMessage\) &&\s*!customerReturns &&/);
    expect(bot).toMatch(/if \(replyText && noKnowledgeMatch && !customerReturns &&/);
  });

  it("a question is regenerated once, and the reply sent never asks", () => {
    expect(bot).toMatch(/if \(replyText && customerReturns && !awaitingApproval && !pendingEscalation && replyAsks\(replyText\)\) \{\s*console\.warn\(`\[ai-bot\] customer-return: the reply asked a question/);
    expect(bot).toMatch(/customer-return: removed a question from the final reply/);
    // The final check sits after the team offer and the unbacked-offer rewrite.
    expect(bot.indexOf("removed a question from the final reply")).toBeGreaterThan(bot.indexOf("no knowledge match: the team offer added"));
    expect(bot.indexOf("removed a question from the final reply")).toBeGreaterThan(bot.indexOf("unbacked ${u.kind"));
  });
});
