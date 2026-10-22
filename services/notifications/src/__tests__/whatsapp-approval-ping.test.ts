/**
 * ★ The approver's WhatsApp ping, by its rendered text only (it reaches a
 * real number, so it is never sent from a test or from dev):
 *   - never a tool's raw name ("Action: propose_plan")
 *   - a plan is said as who asked, where, and its steps in the reader's words
 *   - in the approver's language; GOTCHA feminine; the reader without a gender
 *   - a plan's risk is its steps' own; high risk sends no one-tap buttons
 *   - the person who proposed a plan in Home is not sent it
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ sent: [] as any[], notify: [] as any[], recipient: { userId: "boss", phoneE164: "+972500000000" }, locale: "he" }));

vi.mock("@chatcenter/shared", async () => ({
  resolveEffectiveLocale: async () => ({ effective: H.locale }),
  readDurableSetting: async () => ({ timezone: "Asia/Jerusalem" }),
  parseBusinessHours: (v: any) => v,
  prisma: {
    approvalRequest: { updateMany: async (a: any) => { H.notify.push(a.data); return { count: 1 }; } },
    channelAccount: { findFirst: async () => ({ id: "wa", externalId: "+97230000000", credentials: { x: 1 } }) },
  },
  decryptCredentials: () => ({ token: "t" }),
  resolveApprovalRecipient: async () => ({ ok: true, recipient: H.recipient }),
  recipientRejectionMessage: () => "no",
  mintApprovalRefs: async () => ({ approve: "ref_a", reject: "ref_r" }),
  // A double that records what WOULD be sent; nothing leaves the test.
  getOutboundAdapter: () => ({
    sendTextMessage: async (_c: any, _f: any, to: string, text: string) => { H.sent.push({ to, text, buttons: null }); },
    sendInteractiveMessage: async (_c: any, _f: any, to: string, text: string, buttons: any[]) => { H.sent.push({ to, text, buttons }); },
  }),
}));

import { approvalPingText, notifyManagerOfApproval } from "../services/whatsapp-approval.service";

const NEUTRAL = "לשייך ל-Noa את השיחה של Omer Serruya (וואטסאפ)";
const TO_YOU = "לשייך אליך את השיחה של Omer Serruya (וואטסאפ)";
const plan = (o: any = {}) => ({ steps: [{ riskLevel: "low", target: { assigneeId: "noa" }, summary: NEUTRAL, summaryForAssignee: TO_YOU }], requester: { userId: "matan", name: "Matan" }, source: "home_assistant", ...o });
const DATA = { id: "apr1", tool: "propose_plan", summary: NEUTRAL, riskLevel: "medium", reason: "בקשה של Matan מ-GOTCHA ב-Home", expiresAt: "2026-10-08T15:30:00Z" };

beforeEach(() => { H.sent = []; H.notify = []; H.recipient = { userId: "boss", phoneE164: "+972500000000" }; H.locale = "he"; });

describe("★ the ping's words", () => {
  it("a plan: who asked, where, the steps for this reader; its own risk; no tool name, no requester line as a reason", () => {
    const boss = approvalPingText(DATA, plan(), { locale: "he", recipientUserId: "boss", timeZone: "Asia/Jerusalem" });
    expect(boss.text).toBe(["*נדרש אישור*", `Matan ביקש/ה מ-GOTCHA ב-Home: ${NEUTRAL}`, "סיכון: נמוך", "בתוקף עד: 8 באוקטובר בשעה 18:30"].join("\n"));
    expect(boss.buttons).toEqual({ approve: "לאשר", reject: "לדחות" });
    expect(approvalPingText(DATA, plan(), { locale: "he", recipientUserId: "noa" }).text).toContain(`Matan ביקש/ה מ-GOTCHA ב-Home: ${TO_YOU}`);
    expect(approvalPingText(DATA, plan({ source: "command_bar" }), { locale: "en", recipientUserId: "boss" }).text).toContain(`Matan asked GOTCHA in the command bar: ${NEUTRAL}`);
  });

  it("any other request: GOTCHA's (feminine) or an automation's, by its summary; its reason; never the tool", () => {
    const refund = { id: "r", tool: "shopify.refund_order", summary: "Refund order #1016 (₪250)", riskLevel: "medium", reason: "Customer asked within 24 hours" };
    const he = approvalPingText(refund, null, { locale: "he", recipientUserId: "boss" }).text;
    expect(he).toBe(["*נדרש אישור*", "GOTCHA מבקשת אישור: Refund order #1016 (₪250)", "סיבה: Customer asked within 24 hours", "סיכון: בינוני"].join("\n"));
    expect(approvalPingText({ ...refund, requestedBy: "flow:f1" }, null, { locale: "he", recipientUserId: "boss" }).text).toContain("אוטומציה מבקשת אישור: Refund order");
    expect(approvalPingText(refund, null, { locale: "en", recipientUserId: "boss" }).text).toContain("GOTCHA is asking for approval: Refund order");
    for (const t of [he, approvalPingText(DATA, plan(), { locale: "he", recipientUserId: "boss" }).text]) {
      expect(t).not.toMatch(/refund_order|propose_plan|Action:|אתה|יכול/);
    }
  });

  it("high risk: said so, in the reader's words, and no buttons", () => {
    const high = approvalPingText(DATA, plan({ steps: [{ riskLevel: "high", summary: NEUTRAL }] }), { locale: "he", recipientUserId: "boss" });
    expect(high.highRisk).toBe(true);
    expect(high.text).toContain("סיכון: גבוה");
    expect(high.text).toContain("זו פעולה בסיכון גבוה, ולכן מחליטים עליה ב-GOTCHA ולא כאן.");
  });
});

describe("★ who is sent it", () => {
  it("the approver, in their language, with buttons in that language", async () => {
    await notifyManagerOfApproval("T", DATA, plan());
    expect(H.sent).toHaveLength(1);
    expect(H.sent[0].text).toContain(`Matan ביקש/ה מ-GOTCHA ב-Home: ${NEUTRAL}`);
    expect(H.sent[0].buttons).toEqual([{ id: "ref_a", title: "לאשר" }, { id: "ref_r", title: "לדחות" }]);
  });

  it("never the person who proposed the plan in Home: recorded as skipped, nothing sent", async () => {
    H.recipient = { userId: "matan", phoneE164: "+972511111111" };
    await notifyManagerOfApproval("T", DATA, plan());
    expect(H.sent).toEqual([]);
    expect(H.notify.at(-1)).toMatchObject({ managerNotifyState: "skipped" });
    // Proposed elsewhere: the same person is still the approver to ask.
    await notifyManagerOfApproval("T", DATA, plan({ source: null }));
    expect(H.sent).toHaveLength(1);
  });
});
