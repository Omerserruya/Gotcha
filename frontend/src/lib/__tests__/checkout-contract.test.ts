/**
 * The checkout status contract, which two packages maintain by memory.
 *
 * The backend builds a response object; the frontend declares an interface for
 * it. Nothing connects them. Add a field on one side and forget the other and
 * you get either a UI reading `undefined` - rendering blanks, or `NaN` where a
 * price should be - or a type promising data that never arrives. TypeScript is
 * satisfied either way, because it is checking the frontend against the
 * frontend.
 *
 * Three fields were added to both sides by hand while building the dual-currency
 * flow, which is exactly the situation where one gets missed.
 *
 * Deliberately compares FIELD NAMES only. Types would need real schema sharing;
 * names catch the mistake people actually make.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "../..");
const REPO = join(SRC, "../..");

const route = readFileSync(join(REPO, "services/billing/src/routes/checkout.ts"), "utf8");
const client = readFileSync(join(SRC, "lib/api-checkout.ts"), "utf8");

/**
 * Keys of the object the status route returns.
 *
 * Handles shorthand (`charge,`) as well as `name: value`. A first pass at this
 * missed the shorthand and reported two fields as absent that were present all
 * along - the kind of false alarm that trains people to ignore a check.
 */
function responseFields(): string[] {
  const start = route.indexOf("res.json({");
  expect(start, "the status route no longer returns res.json({ ... }) - has it been restructured?").toBeGreaterThan(-1);
  const body = route.slice(start, start + 2500);
  const named = Array.from(body.matchAll(/^ {6}(\w+):/gm), (m) => m[1]);
  const shorthand = Array.from(body.matchAll(/^ {6}(\w+),\s*$/gm), (m) => m[1]);
  return Array.from(new Set(named.concat(shorthand))).sort();
}

function interfaceFields(name: string): string[] {
  const m = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(client);
  expect(m, `${name} not found in the checkout client`).toBeTruthy();
  return Array.from(new Set(Array.from(m![1].matchAll(/^ {2}(\w+)\??:/gm), (x) => x[1]))).sort();
}

describe("the status response and its type agree", () => {
  it("finds fields on both sides at all", () => {
    // Guards the guard: two empty lists would compare equal and prove nothing.
    expect(responseFields().length).toBeGreaterThan(10);
    expect(interfaceFields("CheckoutSummary").length).toBeGreaterThan(10);
  });

  it("declares nothing the server does not send", () => {
    const extra = interfaceFields("CheckoutSummary").filter((f) => !responseFields().includes(f));
    // These read as `undefined` at runtime. A price renders blank, a boolean
    // silently behaves as false - and on a payment page, "false" for
    // paymentSetupAvailable means a customer who cannot pay.
    expect(extra, `the frontend type promises fields the server never sends: ${extra.join(", ")}`).toEqual([]);
  });

  it("declares everything the server sends", () => {
    const missing = responseFields().filter((f) => !interfaceFields("CheckoutSummary").includes(f));
    // Less dangerous, but it means new server data is invisible to the UI and
    // the next person assumes it was never added.
    expect(missing, `the server sends fields the frontend type omits: ${missing.join(", ")}`).toEqual([]);
  });
});

describe("the fields the payment pages actually depend on", () => {
  // Named explicitly because losing any one of them is a specific, visible harm
  // rather than a generic mismatch.
  it.each([
    ["charge", "the shekel figure - without it a customer sees only the dollar price they will not recognise on their statement"],
    ["declineCategory", "why the card was refused - without it the page says 'one step left' to someone who was just declined"],
    ["awaitingResolution", "whether the outcome is unknown - without it they are told a charge takes 'a few moments' when it may need a person"],
    ["paymentSetupAvailable", "whether they can pay at all"],
    ["retryEligible", "whether retrying is safe - this one guards against a second charge"],
  ])("%s survives on both sides", (field) => {
    expect(responseFields(), `server no longer sends ${field}`).toContain(field);
    expect(interfaceFields("CheckoutSummary"), `client no longer declares ${field}`).toContain(field);
  });
});
