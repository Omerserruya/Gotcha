/**
 * Claims, checked against the facts those claims are about.
 *
 * The previous net asked "did ANY tool execute this turn", so reading an order
 * was evidence for "I have changed your address". It was widened four times in
 * one session, each round against a new phrasing of the same lie, and the
 * allowlist lost every round.
 *
 * These tests are adversarial on purpose: for each claim, a set of paraphrases
 * in active and passive voice, first person and impersonal, all of which must
 * fail against an empty outcome and all of which must pass once the
 * corresponding fact is true. A paraphrase nobody has seen still fails, because
 * facts do not change when the wording does.
 */
import { describe, it, expect } from "vitest";
import {
  buildOutcome,
  emptyOutcome,
  applyToolResult,
  validateOutcomeClaims,
  stripUnsupportedClaims,
  buildOutcomeFactBlock,
  type CustomerOutcome,
} from "../services/customer-outcome.service";

const executed = (tool: string, result: unknown) => ({
  tool,
  result: JSON.stringify(result),
  decision: "executed",
});

function facts(over: Partial<CustomerOutcome>): CustomerOutcome {
  return { ...emptyOutcome(), ...over };
}

describe("normalising tool results into facts", () => {
  it("a read is not an action, however much of it there is", () => {
    const o = buildOutcome([
      executed("shopify.get_order", { order_id: "1", name: "#1011" }),
      executed("shopify.get_fulfillment_status", { order_id: "1", fulfillment_status: null }),
      executed("shopify.get_customer", { customer_id: "27711594201457" }),
    ]);
    expect(o.orderResolved).toBe(true);
    expect(o.customerResolved).toBe(true);
    expect(o.actionSucceeded).toBe(false);
    expect(o.shippingAddressUpdated).toBe(false);
  });

  it("an address change counts only when the READ-BACK verified it", () => {
    const applied = buildOutcome([
      executed("shopify.update_order_shipping_address", { address_updated: true, verified: true, name: "#1011" }),
    ]);
    expect(applied.shippingAddressUpdated).toBe(true);

    const unverified = buildOutcome([
      executed("shopify.update_order_shipping_address", { address_updated: true, verified: false }),
    ]);
    expect(unverified.shippingAddressUpdated).toBe(false);
  });

  it("an exchange counts only when both flags are true, and carries the variants", () => {
    const o = buildOutcome([
      executed("shopify.exchange_order_item", {
        exchange_completed: true, verified: true,
        quote: { current_variant: "156", requested_variant: "159", price_difference: "0.00" },
      }),
    ]);
    expect(o.exchangeCompleted).toBe(true);
    expect(o.oldVariant).toBe("156");
    expect(o.newVariant).toBe("159");
  });

  it("a return needs an id, not just a flag", () => {
    expect(buildOutcome([executed("shopify.create_return", { return_created: true })]).returnCreated).toBe(false);
    const good = buildOutcome([
      executed("shopify.create_return", { return_created: true, return_id: "gid://shopify/Return/1" }),
    ]);
    expect(good.returnCreated).toBe(true);
    expect(good.returnId).toContain("Return/1");
  });

  it("send_invoice is a confirmation, NOT a tax invoice", () => {
    const o = buildOutcome([executed("shopify.send_invoice", { id: 5, to: "matan@example.com" })]);
    expect(o.confirmationSent).toBe(true);
    expect(o.documentSent).toBe(true);
    expect(o.invoiceSent).toBe(false);
  });

  it("an approval pause is not a completed action but IS a guaranteed update", () => {
    const o = buildOutcome([{ tool: "shopify.cancel_order", result: "{}", decision: "executed", sideEffect: "awaiting_approval" }]);
    expect(o.actionSucceeded).toBe(false);
    expect(o.approvalContinuationGuaranteed).toBe(true);
  });

  it("a gated or denied call contributes nothing", () => {
    const o = buildOutcome([
      { tool: "shopify.cancel_order", result: "{}", decision: "missing_required_inputs" },
      { tool: "shopify.get_order", result: "{}", decision: "executed", sideEffect: "denied" },
    ]);
    expect(o.actionAttempted).toBe(false);
    expect(o.orderResolved).toBe(false);
  });

  it("an error result is an attempt, never a success", () => {
    const o = applyToolResult(emptyOutcome(), executed("shopify.create_return", { ok: false, error: "shopify_422" }));
    expect(o.actionAttempted).toBe(true);
    expect(o.actionSucceeded).toBe(false);
    expect(o.safeFailureReason).toBe("shopify_422");
  });

  it("escalation is the one thing that makes a delegation claim true", () => {
    expect(buildOutcome([executed("escalate_to_human", { ok: true })]).handoffCreated).toBe(true);
  });
});

describe("the envelope a tool result arrives in", () => {
  // Live (2026-08-02): add_order_note wrote the note, Shopify showed it, the
  // ledger committed it - and the fact block said nothing had happened, because
  // `note_added` sat one level down inside `{ ok, result }`. The model read the
  // fact block and told the customer the note had not been added. A correct
  // mechanism reporting the inverse of the truth.
  it("reads the adapter path's { ok, result } envelope", () => {
    const o = buildOutcome([
      executed("shopify.add_order_note", { ok: true, result: { order_id: 1, name: "#1011", note_added: true, tags_added: [] } }),
    ]);
    expect(o.noteAdded).toBe(true);
    expect(o.actionSucceeded).toBe(true);
  });

  it("reads the catalog path's { ok, output } envelope", () => {
    const o = buildOutcome([
      executed("integration_add_order_note", { ok: true, output: { order_id: 1, note_added: true, tags_added: [] } }),
    ]);
    expect(o.noteAdded).toBe(true);
  });

  it("still reads a bare, unwrapped result", () => {
    expect(buildOutcome([executed("shopify.add_order_note", { note_added: true })]).noteAdded).toBe(true);
  });

  it("keeps ok:false at the envelope level from becoming a success", () => {
    const o = buildOutcome([executed("shopify.add_order_note", { ok: false, reason: "shopify_422", result: null })]);
    expect(o.noteAdded).toBe(false);
    expect(o.actionAttempted).toBe(true);
    expect(o.safeFailureReason).toBe("shopify_422");
  });

  it("does not mistake an ARRAY result for an envelope", () => {
    const o = buildOutcome([executed("shopify.get_order_items", { ok: true, result: [{ id: 1 }] })]);
    expect(o.actionSucceeded).toBe(false);
  });
});

describe("Hebrew paraphrases cannot outrun the facts", () => {
  const cases: Array<{ claim: string; supported: Partial<CustomerOutcome>; phrases: string[] }> = [
    {
      claim: "delegated",
      supported: { handoffCreated: true },
      phrases: [
        "העברתי את הבקשה לצוות",
        "אעביר את המצב לצוות התמיכה",
        "אעביר את הפרטים לצוות שילווה אותך",
        "נשלח לצוות המשלוחים",
        "הצוות קיבל את הפנייה",
        "הטיפול עבר למחלקה הרלוונטית",
        "פתחתי קריאה",
        "the team will handle it",
      ],
    },
    {
      claim: "address_changed",
      supported: { shippingAddressUpdated: true },
      phrases: [
        "שיניתי את הכתובת",
        "עדכנתי את כתובת המשלוח",
        "הכתובת שונתה בהזמנה",
        "כתובת המשלוח עודכנה",
        "I updated the shipping address",
      ],
    },
    {
      claim: "exchanged",
      supported: { exchangeCompleted: true },
      phrases: ["החלפתי את המידה", "המידה הוחלפה", "הפריט הוחלף", "swapped it for you"],
    },
    {
      claim: "return_opened",
      supported: { returnCreated: true, returnId: "gid://shopify/Return/1" },
      phrases: ["פתחתי החזרה", "נפתחה בקשת החזרה", "opened a return"],
    },
    {
      claim: "document_sent",
      supported: { documentSent: true },
      phrases: ["שלחתי את החשבונית", "נשלחה חשבונית", "החשבונית נשלחה", "I have sent you the receipt"],
    },
    {
      claim: "profile_updated",
      supported: { customerUpdated: true },
      phrases: ["עדכנתי את המייל", "הטלפון שונה", "updated your email"],
    },
    {
      claim: "note_added",
      supported: { noteAdded: true },
      phrases: ["הוספתי הערה בהזמנה", "ההערה נוספה", "added a note"],
    },
    {
      claim: "performed",
      supported: { actionSucceeded: true },
      phrases: ["ביצעתי את הבקשה", "בקשתך עודכנה", "סידרתי לך את זה", "טיפלתי בזה", "זה בוצע"],
    },
    {
      claim: "followup",
      supported: { followUpScheduled: true },
      phrases: ["אעדכן אותך כשיהיה שינוי", "נחזור אליך", "I'll get back to you"],
    },
    {
      claim: "refunded",
      supported: { refundCreated: true },
      phrases: ["ביצעתי את ההחזר הכספי", "ההחזר הכספי בוצע", "processed the refund"],
    },
    {
      claim: "cancelled",
      supported: { orderCancelled: true },
      phrases: ["ביטלתי את ההזמנה", "ההזמנה בוטלה", "cancelled your order"],
    },
  ];

  for (const c of cases) {
    it(`${c.claim}: every phrasing is blocked with nothing behind it`, () => {
      for (const p of c.phrases) {
        const v = validateOutcomeClaims(p, emptyOutcome());
        expect(v.ok, `"${p}" should be rejected`).toBe(false);
        expect(v.unsupported.map((u) => u.claim), p).toContain(c.claim);
      }
    });

    it(`${c.claim}: every phrasing is allowed once the fact is true`, () => {
      for (const p of c.phrases) {
        const v = validateOutcomeClaims(p, facts(c.supported));
        const stillRejected = v.unsupported.filter((u) => u.claim === c.claim);
        expect(stillRejected, `"${p}" should be allowed`).toEqual([]);
      }
    });
  }
});

describe("the facts a claim rests on are the RIGHT facts", () => {
  it("a successful refund does not license an address claim", () => {
    const v = validateOutcomeClaims("שיניתי את הכתובת", facts({ refundCreated: true, actionSucceeded: true }));
    expect(v.unsupported.map((u) => u.claim)).toContain("address_changed");
  });

  it("reading an order does not license a completed write", () => {
    const o = buildOutcome([executed("shopify.get_order", { order_id: "1", name: "#1011" })]);
    expect(validateOutcomeClaims("ביצעתי את הבקשה", o).ok).toBe(false);
  });

  it("a note does not license a delegation claim", () => {
    const v = validateOutcomeClaims("העברתי לצוות", facts({ noteAdded: true, actionSucceeded: true }));
    expect(v.unsupported.map((u) => u.claim)).toContain("delegated");
  });

  it("a pending approval DOES license a promise to come back", () => {
    expect(validateOutcomeClaims("אעדכן אותך ברגע שיהיה עדכון", facts({ approvalContinuationGuaranteed: true })).ok).toBe(true);
  });

  it("says WHAT would have made the claim true", () => {
    const v = validateOutcomeClaims("פתחתי החזרה", emptyOutcome());
    expect(v.unsupported[0].requires).toContain("provider return id");
  });
});

describe("removing the unsupported sentence and keeping the rest", () => {
  it("keeps the true half of a reply", () => {
    const text = "ההזמנה שלך #1011 עדיין לא נשלחה. העברתי את הבקשה לצוות.";
    const v = validateOutcomeClaims(text, emptyOutcome());
    const cleaned = stripUnsupportedClaims(text, v);
    expect(cleaned).toContain("#1011");
    expect(cleaned).not.toContain("לצוות");
  });

  it("returns null when nothing had to go", () => {
    expect(stripUnsupportedClaims("ההזמנה בדרך אליך.", validateOutcomeClaims("ההזמנה בדרך אליך.", emptyOutcome()))).toBeNull();
  });

  it("returns null when EVERYTHING would go - an empty reply is not an improvement", () => {
    const text = "העברתי לצוות.";
    expect(stripUnsupportedClaims(text, validateOutcomeClaims(text, emptyOutcome()))).toBeNull();
  });
});

describe("the fact block the model writes from", () => {
  it("is absent when the turn did nothing at all", () => {
    expect(buildOutcomeFactBlock(emptyOutcome())).toBeNull();
  });

  it("says plainly that nothing changed when an action failed", () => {
    const b = buildOutcomeFactBlock(facts({ actionAttempted: true }))!;
    expect(b).toContain("Nothing was changed");
    expect(b).toContain("You may NOT say anything was done");
  });

  it("lists only what completed, and forbids everything else", () => {
    const b = buildOutcomeFactBlock(facts({ refundCreated: true, refundAmount: "150", refundCurrency: "USD" }))!;
    expect(b).toContain("A refund was created: 150 USD");
    expect(b).toContain("Anything not on this list did NOT happen");
    expect(b).not.toContain("return was opened");
  });

  it("names both variants on a completed exchange", () => {
    const b = buildOutcomeFactBlock(facts({ exchangeCompleted: true, oldVariant: "156", newVariant: "159" }))!;
    expect(b).toContain("156 → 159");
  });

  it("carries the return id, which is what a customer is actually given", () => {
    const b = buildOutcomeFactBlock(facts({ returnCreated: true, returnId: "#R1" }))!;
    expect(b).toContain("#R1");
  });
});
