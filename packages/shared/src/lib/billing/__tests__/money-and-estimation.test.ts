import { describe, it, expect } from "vitest";
import {
  toMinor,
  money,
  toDecimalString,
  addMoney,
  multiplyMoney,
  roundToIncrement,
  convertMoney,
  formatMoney,
} from "../money";
import {
  estimateChannel,
  estimateDeclaredChannel,
  estimatePlanCapacity,
  estimatePricePerInteraction,
  estimateRemainingConversations,
  snapshotEstimation,
  ratiosFromSnapshot,
  FALLBACK_ESTIMATION,
  ESTIMATE_DISCLAIMER,
  type EstimationRatios,
} from "../estimation";

const RATIOS: EstimationRatios = {
  chatCreditsPerEstimatedConversation: 8,
  voiceCreditsPerEstimatedCall: 20,
  businessDaysPerMonth: 25,
  version: 1,
  configId: "cfg-1",
  scope: "GLOBAL",
};

describe("money — integer minor units", () => {
  it("parses Prisma Decimal, string and number identically", () => {
    expect(toMinor("149.00")).toBe(14_900);
    expect(toMinor(149)).toBe(14_900);
    expect(toMinor({ toFixed: (d: number) => (149).toFixed(d) })).toBe(14_900);
  });

  it("parses fractional cents without float drift", () => {
    // 0.145 * 100 is 14.499999999999998 in IEEE-754; string parsing is exact.
    expect(toMinor("0.145")).toBe(15); // half-up
    expect(toMinor("0.144")).toBe(14);
    expect(toMinor("1499.99")).toBe(149_999);
  });

  it("survives the classic 0.1 + 0.2 case", () => {
    const sum = addMoney(money("0.10"), money("0.20"));
    expect(sum.minor).toBe(30);
    expect(toDecimalString(sum)).toBe("0.30");
  });

  it("adds a hundred small amounts without accumulating error", () => {
    let acc = money("0.00");
    for (let i = 0; i < 100; i++) acc = addMoney(acc, money("0.07"));
    expect(toDecimalString(acc)).toBe("7.00");
  });

  it("round-trips through the decimal string", () => {
    for (const v of ["0.00", "0.01", "9.99", "149.00", "1499.50", "2299.00"]) {
      expect(toDecimalString(money(v))).toBe(v);
    }
  });

  it("formats whole units for pricing cards", () => {
    expect(formatMoney(money("149.00", "USD"))).toBe("$149");
    expect(formatMoney(money("555.00", "ILS"))).toBe("₪555");
    expect(formatMoney(money("1499.00", "USD"))).toBe("$1,499");
  });
});

describe("money — ILS upward rounding", () => {
  const ils = (v: string) => money(v, "ILS");

  it("rounds ₪151 up to ₪155 at a ₪5 increment", () => {
    expect(toDecimalString(roundToIncrement(ils("151.00"), 5, "UP"))).toBe("155.00");
  });

  it("rounds ₪498 up to ₪500 at a ₪5 increment", () => {
    expect(toDecimalString(roundToIncrement(ils("498.00"), 5, "UP"))).toBe("500.00");
  });

  it("leaves a value already on the increment alone", () => {
    expect(toDecimalString(roundToIncrement(ils("500.00"), 5, "UP"))).toBe("500.00");
    expect(toDecimalString(roundToIncrement(ils("155.00"), 5, "UP"))).toBe("155.00");
  });

  it("supports the ₪1 / ₪10 / ₪50 increments", () => {
    expect(toDecimalString(roundToIncrement(ils("151.20"), 1, "UP"))).toBe("152.00");
    expect(toDecimalString(roundToIncrement(ils("151.00"), 10, "UP"))).toBe("160.00");
    expect(toDecimalString(roundToIncrement(ils("151.00"), 50, "UP"))).toBe("200.00");
  });

  it("never rounds down when the mode is UP", () => {
    for (let cents = 50_000; cents < 50_500; cents += 7) {
      const before = { minor: cents, currency: "ILS" as const };
      const after = roundToIncrement(before, 5, "UP");
      expect(after.minor).toBeGreaterThanOrEqual(before.minor);
    }
  });
});

describe("money — conversion", () => {
  it("converts USD to ILS deterministically at a decimal rate", () => {
    const usd = money("149.00", "USD");
    const ils = convertMoney(usd, "3.70", "ILS");
    expect(toDecimalString(ils)).toBe("551.30");
  });

  it("produces the same result on repeated calls", () => {
    const a = convertMoney(money("499.00", "USD"), "3.6512", "ILS");
    const b = convertMoney(money("499.00", "USD"), "3.6512", "ILS");
    expect(a.minor).toBe(b.minor);
  });

  it("rounds a converted price up to the ₪5 increment for display", () => {
    const ils = convertMoney(money("149.00", "USD"), "3.70", "ILS"); // ₪551.30
    expect(toDecimalString(roundToIncrement(ils, 5, "UP"))).toBe("555.00");
  });

  it("refuses to add two different currencies", () => {
    expect(() => addMoney(money("1.00", "USD"), money("1.00", "ILS"))).toThrow(/currency_mismatch/);
  });
});

describe("estimation — chat formula", () => {
  it("2,000 credits at 8 per chat is ~250 per month, ~10 per business day", () => {
    const e = estimateChannel(2000, 8, 25);
    expect(e.estimatedMonthly).toBe(250);
    expect(e.estimatedDaily).toBe(10);
  });

  it("scales with the allocation", () => {
    expect(estimateChannel(10_000, 8, 25).estimatedMonthly).toBe(1250);
    expect(estimateChannel(10_000, 8, 25).estimatedDaily).toBe(50);
    expect(estimateChannel(40_000, 8, 25).estimatedDaily).toBe(200);
  });

  it("honours a different business-day configuration", () => {
    expect(estimateChannel(2000, 8, 20).estimatedDaily).toBe(12.5);
  });

  it("returns zero rather than Infinity when the ratio is zero", () => {
    const e = estimateChannel(2000, 0, 25);
    expect(e.estimatedMonthly).toBe(0);
    expect(e.estimatedDaily).toBe(0);
    expect(Number.isFinite(e.estimatedMonthly)).toBe(true);
  });

  it("returns zero for a zero allocation", () => {
    expect(estimateChannel(0, 8, 25).estimatedMonthly).toBe(0);
  });
});

describe("estimation — voice formula", () => {
  it("5,000 voice credits at 20 per call is 250 calls, 10 per business day", () => {
    const e = estimateChannel(5000, 20, 25);
    expect(e.estimatedMonthly).toBe(250);
    expect(e.estimatedDaily).toBe(10);
  });

  it("calculates chat and voice from separate pools, never one shared pool", () => {
    const est = estimatePlanCapacity({ chatCredits: 2000, voiceCredits: 5000, ratios: RATIOS });
    expect(est.chat.estimatedDaily).toBe(10);
    expect(est.voice.estimatedDaily).toBe(10);
    expect(est.estimatedTotalInteractions).toBe(500);
  });

  it("does not claim voice capacity from a chat-only allocation", () => {
    const est = estimatePlanCapacity({ chatCredits: 2000, voiceCredits: 0, ratios: RATIOS });
    expect(est.chat.estimatedMonthly).toBe(250);
    expect(est.voice.estimatedMonthly).toBe(0);
  });
});

/**
 * The bug these guard: a plan SELLS "10 conversations per business day" and
 * separately carries a credit allowance. When an operator edits the allowance
 * without touching the tiers - 2,000 credits down to 750 - dividing by the
 * global 8-credit assumption answered ~94 a month, so the configurator
 * contradicted the selector the visitor had just moved.
 */
describe("estimation — a declared volume outranks the ratio", () => {
  it("reports the volume the plan sells, not the volume its credits imply", () => {
    const e = estimateDeclaredChannel(750, { daily: 10, monthly: 250 }, 25);
    expect(e.estimatedMonthly).toBe(250);
    expect(e.estimatedDaily).toBe(10);
    expect(e.basis).toBe("DECLARED_VOLUME");
  });

  it("reports the credits-per-conversation that volume implies", () => {
    // 750 credits over 250 conversations is 3 each - not the configured 8.
    expect(estimateDeclaredChannel(750, { daily: 10, monthly: 250 }, 25).creditsPerUnit).toBe(3);
  });

  it("derives the monthly figure from daily x business days when unset", () => {
    const e = estimateDeclaredChannel(2000, { daily: 10, monthly: 0 }, 25);
    expect(e.estimatedMonthly).toBe(250);
    expect(e.estimatedDaily).toBe(10);
  });

  it("falls back to the ratio for a channel that declares nothing", () => {
    const est = estimatePlanCapacity({ chatCredits: 750, voiceCredits: 0, ratios: RATIOS });
    expect(est.chat.basis).toBe("CREDIT_RATIO");
    expect(est.chat.estimatedMonthly).toBe(93.75);
  });

  it("applies the declared volume per channel, independently", () => {
    const est = estimatePlanCapacity({
      chatCredits: 750,
      voiceCredits: 5000,
      ratios: RATIOS,
      chatVolume: { daily: 10, monthly: 250 },
    });
    expect(est.chat.estimatedMonthly).toBe(250);
    expect(est.chat.basis).toBe("DECLARED_VOLUME");
    // Voice declared nothing, so it still divides its own pool by its own ratio.
    expect(est.voice.estimatedMonthly).toBe(250);
    expect(est.voice.basis).toBe("CREDIT_RATIO");
  });

  it("ignores an empty declaration rather than reporting zero capacity", () => {
    const est = estimatePlanCapacity({
      chatCredits: 2000,
      voiceCredits: 0,
      ratios: RATIOS,
      chatVolume: { daily: 0, monthly: 0 },
    });
    expect(est.chat.estimatedMonthly).toBe(250);
    expect(est.chat.basis).toBe("CREDIT_RATIO");
  });

  it("prices per conversation against the volume actually sold", () => {
    const est = estimatePlanCapacity({
      chatCredits: 750,
      voiceCredits: 0,
      ratios: RATIOS,
      chatVolume: { daily: 10, monthly: 250 },
    });
    const p = estimatePricePerInteraction(money("39.00", "USD"), est);
    // $39 over the 250 sold, not over the 94 the credit ratio would have claimed.
    expect(toDecimalString(p.pricePerChat!)).toBe("0.16");
  });
});

describe("estimation — price per interaction", () => {
  it("divides the monthly price across estimated chats", () => {
    const est = estimatePlanCapacity({ chatCredits: 2000, voiceCredits: 0, ratios: RATIOS });
    const p = estimatePricePerInteraction(money("149.00", "USD"), est);
    // $149 / 250 chats = $0.596
    expect(toDecimalString(p.pricePerChat!)).toBe("0.60");
    expect(p.pricePerCall).toBeNull();
  });

  it("splits the price proportionally between chat and voice", () => {
    const est = estimatePlanCapacity({ chatCredits: 2000, voiceCredits: 5000, ratios: RATIOS });
    const p = estimatePricePerInteraction(money("1499.00", "USD"), est);
    // 250 chats + 250 calls: each channel carries half of $1,499 over 250 units.
    expect(toDecimalString(p.pricePerChat!)).toBe("3.00");
    expect(toDecimalString(p.pricePerCall!)).toBe("3.00");
    expect(toDecimalString(p.pricePerInteraction!)).toBe("3.00");
  });

  it("returns null instead of dividing by zero", () => {
    const est = estimatePlanCapacity({ chatCredits: 0, voiceCredits: 0, ratios: RATIOS });
    const p = estimatePricePerInteraction(money("149.00", "USD"), est);
    expect(p.pricePerChat).toBeNull();
    expect(p.pricePerCall).toBeNull();
    expect(p.pricePerInteraction).toBeNull();
  });
});

describe("estimation — remaining conversations", () => {
  it("floors so we never promise a conversation the balance cannot fund", () => {
    expect(estimateRemainingConversations(100, RATIOS)).toBe(12); // 100/8 = 12.5
    expect(estimateRemainingConversations(7, RATIOS)).toBe(0);
  });

  it("uses the voice ratio for voice", () => {
    expect(estimateRemainingConversations(100, RATIOS, "voice")).toBe(5);
  });

  it("returns zero for a zero or negative balance", () => {
    expect(estimateRemainingConversations(0, RATIOS)).toBe(0);
    expect(estimateRemainingConversations(-50, RATIOS)).toBe(0);
  });
});

describe("estimation — snapshots", () => {
  it("captures the ratios and reads them back", () => {
    const snap = snapshotEstimation(RATIOS);
    expect(snap.chatCreditsPerEstimatedConversation).toBe(8);
    expect(snap.configId).toBe("cfg-1");
    expect(snap.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const later: EstimationRatios = { ...RATIOS, chatCreditsPerEstimatedConversation: 12, version: 2 };
    // A published ratio change does NOT restate the snapshotted subscription.
    expect(ratiosFromSnapshot(snap, later).chatCreditsPerEstimatedConversation).toBe(8);
    expect(ratiosFromSnapshot(snap, later).version).toBe(1);
  });

  it("falls through to the current ratios when there is no snapshot", () => {
    expect(ratiosFromSnapshot(null, RATIOS)).toEqual(RATIOS);
    expect(ratiosFromSnapshot({}, RATIOS)).toEqual(RATIOS);
    expect(ratiosFromSnapshot({ chatCreditsPerEstimatedConversation: 0 }, RATIOS)).toEqual(RATIOS);
  });

  it("an estimate rendered from a snapshot keeps the agreed capacity", () => {
    const snap = snapshotEstimation(RATIOS);
    const drifted: EstimationRatios = { ...RATIOS, chatCreditsPerEstimatedConversation: 16 };
    const asAgreed = estimatePlanCapacity({ chatCredits: 2000, voiceCredits: 0, ratios: ratiosFromSnapshot(snap, drifted) });
    const asNewCustomer = estimatePlanCapacity({ chatCredits: 2000, voiceCredits: 0, ratios: drifted });
    expect(asAgreed.chat.estimatedMonthly).toBe(250);
    expect(asNewCustomer.chat.estimatedMonthly).toBe(125);
  });
});

describe("estimation — honesty guarantees", () => {
  it("the fallback is a configured constant, not an analytics-derived value", () => {
    expect(FALLBACK_ESTIMATION.scope).toBe("FALLBACK");
    expect(FALLBACK_ESTIMATION.chatCreditsPerEstimatedConversation).toBe(8);
    expect(FALLBACK_ESTIMATION.configId).toBeNull();
  });

  it("the disclaimer never attributes the estimate to other customers", () => {
    for (const copy of [ESTIMATE_DISCLAIMER.en, ESTIMATE_DISCLAIMER.he]) {
      expect(copy).not.toMatch(/average|platform|other customers|ממוצע|לקוחות אחרים/i);
    }
    expect(ESTIMATE_DISCLAIMER.en).toMatch(/based on the plan configuration/i);
  });

  it("never exposes a token count in an estimate", () => {
    const est = estimatePlanCapacity({ chatCredits: 2000, voiceCredits: 5000, ratios: RATIOS });
    expect(JSON.stringify(est)).not.toMatch(/token/i);
  });
});
