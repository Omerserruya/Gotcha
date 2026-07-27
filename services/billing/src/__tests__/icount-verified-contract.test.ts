/**
 * The iCount request contract, as established against the live account.
 *
 * Every assertion here corresponds to a call that was actually made and a
 * response that was actually read. None of it is from documentation, and none
 * of it is inferred from a field name looking plausible - two of these were
 * wrong in exactly that way, and each would have failed every live checkout:
 *
 *   paypage/generate_sale was sent `page_id`. The API answers
 *   status=false reason="missing_paypage_id". The field is `paypage_id`.
 *
 *   The client was never created. generate_sale does not create one: with an
 *   unknown `custom_client_id` it answers status=false
 *   reason="client_not_found", and passing client_name and email alongside
 *   does not change that. client/create must come first.
 *
 *   paypage/info nests its configuration under `paypage_info`. The unwrapping
 *   looked for `paypage` and `page` and fell back to the envelope, so the
 *   tokenization guard saw no doctype and refused a correctly configured page.
 *
 * These are source-level assertions because the alternative is calling a
 * payments API from a test suite.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const client = readFileSync(join(__dirname, "../providers/icount-client.ts"), "utf8");
const provider = readFileSync(join(__dirname, "../providers/icount.provider.ts"), "utf8");
const code = client.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

describe("paypage/generate_sale", () => {
  it("identifies the page as paypage_id", () => {
    expect(code).toContain("paypage_id: input.pageId");
  });

  it("does not send page_id", () => {
    // The exact spelling that fails with missing_paypage_id.
    expect(code).not.toMatch(/\bpage_id: input\.pageId/);
  });

  it("keeps the session ids the response carries", () => {
    // Distinct per call - two sessions generated back to back returned
    // different sale_uniqid values. This is what an inbound notification is
    // correlated against.
    expect(code).toContain("sale_uniqid");
    expect(code).toContain("sale_sid");
    expect(code).toContain("saleSessionId");
  });
});

describe("client/create", () => {
  it("exists and carries our correlation reference", () => {
    expect(code).toContain('call("client/create"');
    expect(code).toContain("custom_client_id: input.customClientId");
  });

  it("requires client_name, which is all iCount requires", () => {
    expect(code).toContain("client_name: input.clientName");
  });

  it("refuses a response with no client_id rather than continuing", () => {
    expect(code).toContain("response carried no client_id");
  });

  it("runs BEFORE the sale in the live path", () => {
    const body = provider.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const create = body.indexOf("api.createClient");
    const sale = body.indexOf("api.generateSale");
    expect(create, "createClient must be called").toBeGreaterThan(-1);
    expect(sale, "generateSale must be called").toBeGreaterThan(-1);
    // Reversed, every live tokenization fails with client_not_found.
    expect(create).toBeLessThan(sale);
  });
});

describe("paypage/info", () => {
  it("reads the configuration from paypage_info", () => {
    expect(code).toContain("data?.paypage_info");
  });

  it("does not fall back to the envelope", () => {
    // The fallback is what made a correct page look misconfigured, and it
    // reported the one property that was fine as the problem.
    expect(code).not.toMatch(/paypage_info\s*\?\?\s*data\?\.paypage\s*\?\?\s*data\?\.page\s*\?\?\s*data\b/);
    expect(code).toContain("response carried no page configuration");
  });
});

describe("cc/bill", () => {
  it("still charges in ILS", () => {
    // Unchanged, and restated here because these are the same request builders.
    expect(client).toContain("CURRENCY_ID_ILS = 1");
  });
});
