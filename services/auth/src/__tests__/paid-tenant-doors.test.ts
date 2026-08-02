/**
 * A paid organization has two front doors, and only one of them asks for money.
 *
 * This is the bug these tests exist for, reconstructed from the dev database
 * rather than imagined. Tenant "Urban Supply" was created PENDING_PAYMENT with
 * a checkout at 06:56 and its payment email sent. At 07:24 an operator clicked
 * Resend onboarding, which sent the OTHER email - an Authentik setup link whose
 * own text says "no login required" - and the customer followed it, created
 * their account, landed in the setup wizard, and never saw a payment screen.
 * The tenant reached ACTIVE with its checkout still PENDING.
 *
 * So the rule under test is: while an organization owes money, the door that
 * does not ask for it must be shut, and the operator must be told which door to
 * use instead.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

const system = read("routes/system.ts");
const onboarding = read("routes/onboarding.ts");

/** The route body, from its handler to the next router registration. */
function routeBody(src: string, path: string): string {
  const at = src.indexOf(`"${path}"`);
  if (at < 0) throw new Error(`route ${path} not found`);
  const next = src.indexOf("\nrouter.", at + 1);
  return src.slice(at, next < 0 ? src.length : next);
}

describe("the onboarding door refuses an unpaid paid tenant", () => {
  const resend = routeBody(system, "/tenants/:id/resend-onboarding");

  it("checks the tenant is not awaiting payment", () => {
    expect(resend).toContain("PENDING_PAYMENT");
  });

  it("refuses with a code a caller can act on, not a generic error", () => {
    expect(resend).toContain("TENANT_AWAITING_PAYMENT");
    expect(resend).toMatch(/409/);
  });

  it("names the door that IS correct", () => {
    // An operator who is refused needs to know what to click instead;
    // otherwise they try the same button again, which is what happened.
    expect(resend).toMatch(/Resend payment link/i);
  });

  it("still refuses an already-active tenant, which was the only check before", () => {
    expect(resend).toContain("already completed onboarding");
  });
});

describe("finishing setup does not activate an unpaid organization", () => {
  it("skips the ACTIVE write while payment is outstanding", () => {
    // The tenant.update must sit inside the awaitingPayment branch. If it were
    // unconditional, completing the wizard would hand over the paid product -
    // which is exactly what it used to do.
    expect(onboarding).toContain("const awaitingPayment = tenant.status === \"PENDING_PAYMENT\"");
    expect(onboarding).toMatch(/awaitingPayment[\s\S]{0,120}\?\s*\[\]/);
  });

  it("records the onboarding work anyway", () => {
    // Their setup is real. Making them redo it after paying would punish them
    // for the order they happened to do things in.
    expect(onboarding).toContain("tenantOnboarding.upsert");
  });

  it("holds back the activation email for a workspace that has not opened", () => {
    expect(onboarding).toMatch(/if \(!awaitingPayment\)[\s\S]{0,200}sendActivationConfirmation/);
  });

  it("tells the client payment is required, so it can route rather than guess", () => {
    expect(onboarding).toContain("paymentRequired: awaitingPayment");
  });
});

describe("the paid email points somewhere real", () => {
  const notification = read("services/notification.service.ts");

  it("links to the checkout entry route, with reference and token", () => {
    // A link to a route that does not exist is how this failed once already.
    expect(notification).toContain("/checkout");
    expect(notification).toContain("ref=");
    expect(notification).toContain("token=");
  });

  it("carries no tenant id, user id or api credential in the URL", () => {
    const fn = notification.slice(notification.indexOf("export async function sendPaidOnboardingEmail"));
    const url = fn.slice(fn.indexOf("const continuationUrl"), fn.indexOf("const he ="));
    for (const forbidden of ["tenantId", "adminUserId", "apiKey", "Bearer", "checkoutId"]) {
      expect(url, `${forbidden} must not appear in the emailed URL`).not.toContain(forbidden);
    }
  });
});
