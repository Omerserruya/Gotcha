/**
 * Where an unpaid organization's browser is sent.
 *
 * The rule that failed in production: every not-yet-active tenant was routed to
 * /setup, including the ones that owed money - and finishing setup used to
 * activate them. So the paid plan was, in practice, optional, and the customer
 * never saw a payment screen at all.
 *
 * PENDING_PAYMENT must therefore be answered BEFORE the generic
 * not-yet-active rule, and these tests pin that ordering.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getMyCheckout = vi.fn();
vi.mock("@/lib/api-checkout", () => ({ getMyCheckout: (...a: unknown[]) => getMyCheckout(...a) }));

import { destinationForTenantStatus, isPaymentRequiredError, paymentRedirectTarget } from "../payment-gate";

beforeEach(() => {
  getMyCheckout.mockReset();
  getMyCheckout.mockResolvedValue({ reference: "chk_abc123", expiresAt: "2026-08-01T00:00:00Z" });
});

describe("an organization that owes money", () => {
  it("goes to the payment screen, not setup", async () => {
    const to = await destinationForTenantStatus("PENDING_PAYMENT", {
      authToken: "t",
      pathname: "/setup",
    });
    expect(to).toBe("/checkout/payment-required?ref=chk_abc123");
  });

  it("is sent there from anywhere in the paid product", async () => {
    for (const from of ["/conversations", "/ai-studio", "/channels", "/integrations", "/"]) {
      const to = await destinationForTenantStatus("PENDING_PAYMENT", { authToken: "t", pathname: from });
      expect(to, from).toBe("/checkout/payment-required?ref=chk_abc123");
    }
  });

  it("is left alone once it is already inside checkout", async () => {
    // The checkout pages route among themselves from the server's status.
    // Redirecting them from out here would fight that dispatcher.
    for (const at of ["/checkout", "/checkout/processing", "/checkout/completed"]) {
      expect(await destinationForTenantStatus("PENDING_PAYMENT", { authToken: "t", pathname: at }), at).toBeNull();
    }
  });

  it("falls back to the checkout entry when no checkout can be resolved", async () => {
    // Rather than a payment page with nothing to pay for.
    getMyCheckout.mockResolvedValue(null);
    expect(await destinationForTenantStatus("PENDING_PAYMENT", { authToken: "t", pathname: "/" })).toBe("/checkout");
  });

  it("does not strand the customer when billing is unreachable", async () => {
    getMyCheckout.mockRejectedValue(new Error("boom"));
    expect(await destinationForTenantStatus("PENDING_PAYMENT", { authToken: "t", pathname: "/" })).toBe("/checkout");
  });

  it("puts only the opaque reference in the URL", async () => {
    const to = await paymentRedirectTarget("t");
    expect(to).toContain("chk_abc123");
    for (const forbidden of ["tenant", "token=", "Bearer"]) {
      expect(to).not.toContain(forbidden);
    }
  });
});

describe("every other status", () => {
  it("still sends a not-yet-active organization to setup", async () => {
    for (const status of ["PENDING_ADMIN_SETUP", "PENDING_ONBOARDING"]) {
      expect(await destinationForTenantStatus(status, { authToken: "t", pathname: "/" }), status).toBe("/setup");
    }
  });

  it("leaves an active organization where it is", async () => {
    expect(await destinationForTenantStatus("ACTIVE", { authToken: "t", pathname: "/conversations" })).toBeNull();
  });

  it("does not bounce setup to itself", async () => {
    expect(await destinationForTenantStatus("PENDING_ONBOARDING", { authToken: "t", pathname: "/setup" })).toBeNull();
  });

  it("never asks billing about a tenant that does not owe anything", async () => {
    await destinationForTenantStatus("ACTIVE", { authToken: "t", pathname: "/" });
    await destinationForTenantStatus("PENDING_ONBOARDING", { authToken: "t", pathname: "/" });
    expect(getMyCheckout).not.toHaveBeenCalled();
  });
});

describe("recognizing the server's refusal", () => {
  it("accepts only a 402 carrying the policy's own code", () => {
    expect(isPaymentRequiredError({ status: 402, body: { code: "TENANT_PAYMENT_REQUIRED" } })).toBe(true);
  });

  it("ignores anything else, rather than guessing", () => {
    // A 402 from somewhere unrelated, or a 403 that merely mentions payment,
    // would send someone to a checkout that is not theirs.
    expect(isPaymentRequiredError({ status: 402, body: { code: "SOMETHING_ELSE" } })).toBe(false);
    expect(isPaymentRequiredError({ status: 403, body: { code: "TENANT_PAYMENT_REQUIRED" } })).toBe(false);
    expect(isPaymentRequiredError(null)).toBe(false);
    expect(isPaymentRequiredError(new Error("nope"))).toBe(false);
  });
});
