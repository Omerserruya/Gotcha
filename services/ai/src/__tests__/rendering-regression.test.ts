/**
 * Structured-data rendering regression (2026-07-20 incident): a dash-scrub
 * character class that matched ASCII hyphens turned every URL, ISO date and
 * UUID into comma soup on real WhatsApp messages
 * ("urban-supply-…" → "urban, supply, …", "2026-07-08" → "2026, 07, 08").
 *
 * Two locks here:
 *   1. behavioral - the shared transform preserves the incident's exact
 *      values byte-for-byte (see also packages/shared customer-text tests);
 *   2. source-level bypass visibility - NO dash-rewriting character class in
 *      the reply/humanizer/sanitizer paths may ever contain an ASCII hyphen
 *      again, and every wide-dash class must run atom-protected.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeCustomerText, withProtectedAtoms } from "@chatcenter/shared";

const INCIDENT_URL = "https://urban-supply-gotcha-demo.myshopify.com/products/the-collection-snowboard-hydrogen";
const INCIDENT_IMG = "https://cdn.shopify.com/s/files/1/Main_0a40b01b-5021-48c1-80d1-aa8ab4876d3d.jpg";
const INCIDENT_DATE = "2026-07-08";

describe("incident values survive the customer-text pipeline byte-for-byte", () => {
  it("product URL, image UUID URL, ISO date, dashed phone (1/2/6/7/20)", () => {
    const msg = `מצאתי - הנה ${INCIDENT_URL} מתאריך ${INCIDENT_DATE} תמונה ${INCIDENT_IMG} טלפון 054-568-0665`;
    const out = sanitizeCustomerText(msg);
    expect(out).toContain(INCIDENT_URL);
    expect(out).toContain(INCIDENT_IMG);
    expect(out).toContain(INCIDENT_DATE);
    expect(out).toContain("054-568-0665");
    expect(out).not.toMatch(/urban, supply|2026, 07, 08|0a40b01b, 5021/);
    expect(out).not.toMatch(/[\u2013\u2014\u2015]/);
  });

  it("order numbers, emails, amounts and currency survive (4/5/11)", () => {
    const msg = "הזמנה #1005 - סכום 949.95 USD - קבלה ל a-b@x-y.com";
    const out = sanitizeCustomerText(msg);
    expect(out).toContain("#1005");
    expect(out).toContain("949.95 USD");
    expect(out).toContain("a-b@x-y.com");
  });

  it("a transform CANNOT alter protected atoms even if it tries (10/12)", () => {
    const hostile = (p: string) => p.replace(/-/g, ", ").replace(/\d+/g, "9");
    const out = withProtectedAtoms(`x-y ${INCIDENT_URL} ${INCIDENT_DATE}`, hostile);
    expect(out).toContain(INCIDENT_URL);
    expect(out).toContain(INCIDENT_DATE);
    expect(out.startsWith("x, y")).toBe(true); // prose still transformed
  });
});

describe("source-level bypass visibility", () => {
  const read = (p: string) => readFileSync(join(__dirname, p), "utf8");

  it("humanizeReply's dash class contains ONLY wide dashes and runs atom-protected", () => {
    const src = read("../services/ai-bot.service.ts");
    // the incident class - an ASCII hyphen inside a dash character class -
    // must never reappear anywhere in the reply path
    expect(src).not.toMatch(/\[\s*-[\u2013\u2014\u2015]/);
    expect(src).not.toMatch(/\[[\u2013\u2014\u2015]+-[\u2013\u2014\u2015]*\]/);
    const fn = src.slice(src.indexOf("function humanizeReply"));
    expect(fn.slice(0, 1500)).toContain("withProtectedAtoms");
  });

  it("the shared sanitizer's CLAUSE-scrub class (replaced with a comma) contains only wide dashes", () => {
    const src = readFileSync(
      join(__dirname, "../../../../packages/shared/src/lib/customer-text.ts"),
      "utf8",
    );
    // The dangerous pattern is a dash class REPLACED WITH A COMMA - an ASCII
    // hyphen there corrupts URLs/dates/ranges. That scrub must be wide-dash
    // only. The NUMERIC_RANGE detector legitimately contains a hyphen because
    // it NORMALIZES ranges to a hyphen; it never scrubs to a comma.
    const clauseScrub = src.match(/replace\(\/\\s\*\[([^\]]+)\]\\s\*\/g,\s*", "\)/);
    expect(clauseScrub).toBeTruthy();
    expect(clauseScrub![1]).not.toContain("-"); // a plain hyphen must never be in the scrub class
  });
});
