/**
 * The OFF state of the payment capability switches.
 *
 * The suite as a whole runs with all three ON, because most of what is worth
 * testing is the charging path. That makes the off state the one nothing else
 * covers - and it is the state that ships. A switch whose off position has
 * never been exercised is a switch nobody should trust.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  paymentCapabilityEnabled,
  assertPaymentCapability,
  PaymentCapabilityDisabledError,
} from "../providers/icount-config";

const VARS = [
  "ICOUNT_CHECKOUT_ENABLED",
  "ICOUNT_TOKENIZATION_ENABLED",
  "ICOUNT_STORED_CARD_CHARGE_ENABLED",
] as const;

const ORIGINAL: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const v of VARS) ORIGINAL[v] = process.env[v];
});
afterEach(() => {
  for (const v of VARS) {
    if (ORIGINAL[v] === undefined) delete process.env[v];
    else process.env[v] = ORIGINAL[v];
  }
});

describe("a capability nobody configured is off", () => {
  it("is off when the variable is absent", () => {
    for (const v of VARS) delete process.env[v];
    expect(paymentCapabilityEnabled("checkout")).toBe(false);
    expect(paymentCapabilityEnabled("tokenization")).toBe(false);
    expect(paymentCapabilityEnabled("stored_card_charge")).toBe(false);
  });

  it("refuses with a message naming the variable to set", () => {
    delete process.env.ICOUNT_STORED_CARD_CHARGE_ENABLED;
    try {
      assertPaymentCapability("stored_card_charge");
      throw new Error("should have refused");
    } catch (err) {
      expect(err).toBeInstanceOf(PaymentCapabilityDisabledError);
      // An operator reading this should not have to go and find the name.
      expect((err as Error).message).toContain("ICOUNT_STORED_CARD_CHARGE_ENABLED");
    }
  });
});

describe("only an explicit yes counts", () => {
  it.each(["false", "0", "no", "off", "", "  ", "TRUE_ISH", "1"])(
    "treats %o as off",
    (value) => {
      process.env.ICOUNT_CHECKOUT_ENABLED = value;
      // Truthiness would read "false", "0" and "no" as ON - each of them
      // something an operator would plausibly write meaning the opposite.
      expect(paymentCapabilityEnabled("checkout")).toBe(false);
    },
  );

  it.each(["true", "TRUE", " True "])("treats %o as on", (value) => {
    process.env.ICOUNT_CHECKOUT_ENABLED = value;
    expect(paymentCapabilityEnabled("checkout")).toBe(true);
  });
});

describe("the switches are independent", () => {
  it("lets cards be collectable while charging them stays closed", () => {
    process.env.ICOUNT_TOKENIZATION_ENABLED = "true";
    process.env.ICOUNT_STORED_CARD_CHARGE_ENABLED = "false";
    // The reason these are three switches and not one.
    expect(() => assertPaymentCapability("tokenization")).not.toThrow();
    expect(() => assertPaymentCapability("stored_card_charge")).toThrow(
      PaymentCapabilityDisabledError,
    );
  });
});
