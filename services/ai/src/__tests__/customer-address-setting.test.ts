/**
 * Omer 2026-11-23 (B): a per-employee setting "פנייה ללקוח", style.customerAddress, "neutral" (default) or "feminine".
 * With "feminine" the style gate allows and expects the feminine: only the masculine is a gendered address, neutral
 * wording is always fine. Neutral stays the default everywhere.
 */
import { describe, it, expect } from "vitest";
import { checkReplyStyle, styleCustomerAddress } from "../services/reply-style-check.service";
import { buildStateNote } from "../services/conversation-history.service";
import { buildStablePrefix } from "../services/reply-engine/prompt";

const ctx = (o: any = {}): any => ({ locale: "he", isFirstReply: false, incomingMessage: "יש ב-M?", customerForm: null, employeeGender: null, employeeName: "Noa", productFactsAvailable: true, shopFloor: true, toolsOffered: [], customerClosing: false, ...o });
const gendered = (t: string, o?: any) => checkReplyStyle(t, ctx(o)).filter((v: any) => v.kind === "gendered_address").length;

describe("★ style.customerAddress", () => {
  it("is read from the employee's style, object or string; anything else is the neutral default", () => {
    expect(styleCustomerAddress({ customerAddress: "feminine" })).toBe("feminine");
    expect(styleCustomerAddress(JSON.stringify({ useEmojis: true, customerAddress: "feminine" }))).toBe("feminine");
    for (const s of [{}, { customerAddress: "neutral" }, { customerAddress: "masculine" }, null, "not json", undefined]) expect(styleCustomerAddress(s)).toBeNull();
  });
  it("feminine: the feminine is allowed, the masculine is still a fault, neutral is fine", () => {
    const fem = { addressForm: "feminine" };
    expect(gendered("תרצי לראות עוד דגמים?", fem)).toBe(0);
    expect(gendered("את מחפשת משהו לחתונה?", fem)).toBe(0);
    expect(gendered("שלחי לי תמונה, ואחזור אלייך עם התאמה.", fem)).toBe(0);
    expect(gendered("תרצה לראות עוד דגמים?", fem)).toBe(1);
    expect(gendered("מה בא לך?", fem)).toBe(0);
  });
  it("the default stays neutral: both forms are faults", () => {
    expect(gendered("תרצי לראות עוד דגמים?")).toBe(1);
    expect(gendered("תרצה לראות עוד דגמים?")).toBe(1);
  });
  it("the legacy state note and the v2 prompt say it, only when it is set", () => {
    const rows: any[] = [{ direction: "INBOUND", body: "היי", createdAt: new Date() }];
    expect(buildStateNote({ rows, now: Date.now(), addressForm: "feminine" })).toMatch(/Address the customer in the feminine form/);
    expect(buildStateNote({ rows, now: Date.now() })).toMatch(/Address the customer neutrally/);
    const base: any = { agent: { name: "נועה", role: "sales" }, company: null, locale: "he", skills: [], channel: "WEBCHAT", cardsChannel: false };
    expect(buildStablePrefix({ ...base, customerAddress: "feminine" })).toMatch(/addresses its customers in the feminine form/);
    expect(buildStablePrefix(base)).not.toMatch(/addresses its customers in the feminine form/);
  });
});
