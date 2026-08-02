/**
 * "תרשמו בהזמנה ש..." - scenario 26, which never called the tool it needed.
 *
 * The failure is worth stating precisely because it defeated every guard we
 * had. Asked to record a callback request on order #1011, the model reached for
 * `create_note`, which writes the CUSTOMER profile. A note really was saved.
 * The honesty check saw a successful write and allowed "ההערה נוספה להזמנה
 * 1011". Shopify's order still read note: null.
 *
 * A true claim about the wrong object is harder to catch than a false one.
 */
import { describe, it, expect } from "vitest";
import {
  detectOrderNoteIntent,
  buildOrderNoteDirective,
} from "../services/product-intent.service";
import {
  buildOutcome,
  validateOutcomeClaims,
  emptyOutcome,
} from "../services/customer-outcome.service";

const executed = (tool: string, result: unknown) => ({
  tool,
  result: JSON.stringify(result),
  decision: "executed",
});

describe("detecting a request to record something on an order", () => {
  it("fires on the ways customers ask", () => {
    for (const s of [
      "תכתבו בהזמנה שאני מבקש שיחזרו אליי",
      "תוסיפו הערה שהמוצר הגיע פגום",
      "תתעדו שחסר פריט",
      "add a note to my order",
    ]) {
      expect(detectOrderNoteIntent(s), s).toBe(true);
    }
  });
});

describe("the order-note directive", () => {
  it("names the right tool AND the wrong one it kept picking", () => {
    const d = buildOrderNoteDirective();
    expect(d).toContain("add_order_note");
    expect(d).toContain("NOT create_note");
    expect(d).toContain("leaves the order blank");
  });

  it("says what a note is not", () => {
    const d = buildOrderNoteDirective();
    expect(d).toContain("It does not notify anyone");
    expect(d).toContain("does not create a task");
    expect(d).toContain("does not guarantee a callback");
  });

  it("forbids describing it as reaching a team", () => {
    const d = buildOrderNoteDirective();
    expect(d).toContain("do NOT say or imply that a team, agent or department has been told");
    expect(d).toContain("that is a separate handoff you must actually perform");
  });

  it("requires the tool to succeed before the claim", () => {
    const d = buildOrderNoteDirective();
    expect(d).toContain("Only after it returns successfully");
    expect(d).toContain("Never describe an unwritten note as written");
  });
});

describe("a note on the ORDER, in the outcome facts", () => {
  it("records the note when add_order_note verified it", () => {
    const o = buildOutcome([executed("shopify.add_order_note", { order_id: 1, name: "#1011", note_added: true, tags_added: [] })]);
    expect(o.noteAdded).toBe(true);
    expect(o.actionSucceeded).toBe(true);
  });

  it("records a tag from the ARRAY shape this tool returns", () => {
    const o = buildOutcome([executed("shopify.add_order_note", { order_id: 1, note_added: false, tags_added: ["callback"] })]);
    expect(o.tagAdded).toBe(true);
  });

  it("reads the legacy camelCase shape too", () => {
    const o = buildOutcome([executed("shopify.update_order_fulfillment", { order_id: 1, noteAdded: true, tagAdded: true, notificationSent: false })]);
    expect(o.noteAdded).toBe(true);
    expect(o.tagAdded).toBe(true);
  });

  it("a note on the CUSTOMER does not license an order-note claim", () => {
    const o = buildOutcome([executed("shopify.create_note", { id: 7, note: "wants a callback" })]);
    expect(o.noteAdded).toBe(false);
    expect(o.customerUpdated).toBe(true);
    expect(validateOutcomeClaims("ההערה נוספה להזמנה", o).ok).toBe(false);
  });

  it("a written note does NOT license a team-notification claim", () => {
    const o = buildOutcome([executed("shopify.add_order_note", { order_id: 1, note_added: true, tags_added: [] })]);
    expect(validateOutcomeClaims("ההערה נוספה להזמנה #1011.", o).ok).toBe(true);
    expect(validateOutcomeClaims("העברתי לצוות.", o).ok).toBe(false);
  });

  it("with no tool call at all, the claim is blocked", () => {
    expect(validateOutcomeClaims("הוספתי הערה בהזמנה", emptyOutcome()).ok).toBe(false);
  });
});
