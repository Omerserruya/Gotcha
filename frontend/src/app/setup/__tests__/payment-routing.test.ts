/**
 * Where setup sends a customer when it finishes.
 *
 * Setup used to end with `router.replace(SETUP_HUB)` for everybody. For a
 * paid organization that is a workspace where every API call answers 402,
 * so the customer arrives somewhere that looks like the product and behaves
 * like a wall - with no mention of payment anywhere.
 *
 * Asserted against the source, following the precedent in
 * lib/__tests__/system-paid-tenant.test.ts. The page is ~2000 lines with a
 * scan poller, an OAuth round-trip and nine movements; rendering it to
 * observe one redirect would test the harness more than the behaviour.
 * These lock the ORDER and the DESTINATION, which is what actually broke.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const page = fs.readFileSync(path.resolve(__dirname, "../page.tsx"), "utf8");

describe("finishing setup for a paid organization", () => {
  it("checks paymentRequired before sending anyone to the workspace", () => {
    const paymentBranch = page.indexOf("done?.data?.paymentRequired");
    const hubRedirect = page.indexOf("router.replace(next || SETUP_HUB)");
    expect(paymentBranch).toBeGreaterThan(-1);
    expect(hubRedirect).toBeGreaterThan(-1);
    expect(paymentBranch).toBeLessThan(hubRedirect);
  });

  it("returns out of the flow rather than falling through to the workspace", () => {
    // Without the return, a paid tenant would be redirected twice and land
    // in the product anyway.
    expect(page).toMatch(/paymentRequired\)[\s\S]{0,600}return;/);
  });

  it("sends the customer to payment-required with their own reference", () => {
    expect(page).toContain("/checkout/payment-required?ref=");
    expect(page).toContain("encodeURIComponent(ref.reference)");
  });

  it("still has a destination when the reference cannot be fetched", () => {
    // The entry page explains the state; a dead end would not.
    expect(page).toMatch(/router\.replace\(ref \?[\s\S]{0,160}: "\/checkout"\)/);
  });

  it("does not arm the product tour for a workspace that has not opened", () => {
    const paymentBranch = page.indexOf("done?.data?.paymentRequired");
    const tour = page.indexOf("onboarding.launchTour");
    expect(paymentBranch).toBeLessThan(tour);
  });
});

describe("while setup is still in progress", () => {
  it("says the organization is waiting for payment, in both languages", () => {
    // Sprung at the end, this reads as a bait and switch. Said up front, it
    // is just the state of things.
    expect(page).toContain("This organization is waiting for payment");
    expect(page).toContain("הארגון ממתין לתשלום");
  });

  it("offers a way to pay from inside setup", () => {
    expect(page).toMatch(/awaitingPayment && \([\s\S]{0,1200}checkout\/payment-required\?ref=/);
    expect(page).toContain("Go to payment");
    expect(page).toContain("למסך התשלום");
  });

  it("learns the state from membership, not from the URL", () => {
    // The customer may have arrived by any route, including a fresh login
    // long after the email was deleted.
    expect(page).toContain("getMyCheckout({ authToken: token })");
    expect(page).not.toMatch(/awaitingPayment[\s\S]{0,200}searchParams\.get\("ref"\)/);
  });

  it("never blocks setup on the billing lookup", () => {
    // A billing hiccup must not stop somebody configuring their workspace.
    expect(page).toMatch(/getMyCheckout\(\{ authToken: token \}\)[\s\S]{0,220}\.catch\(/);
  });
});
