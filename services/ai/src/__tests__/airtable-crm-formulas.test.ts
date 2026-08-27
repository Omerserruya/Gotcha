import { describe, it, expect } from "vitest";
import {
  airtablePhoneMatchFormula,
  airtableNormalizedPhoneExpr,
} from "../services/connectors/crm-adapter.impl";

/**
 * The outbound dialer's Airtable lookups live or die on these formulas.
 *
 * The previous behavior was exact string equality against the raw column -
 * `{Phone}='+972501234567'` - which missed "050-123 4567", "+972 50-1234567"
 * and every other way a human types a phone number into Airtable. These tests
 * pin the two properties that make the lookup actually find people: the
 * stored value is normalized before comparison, and the query is expanded to
 * every storage variant (E.164, no plus, national 0-prefix).
 */

describe("airtableNormalizedPhoneExpr", () => {
  it("strips the separators people actually type into Airtable", () => {
    const expr = airtableNormalizedPhoneExpr("Phone");
    for (const ch of [" ", "-", "(", ")", "."]) {
      expect(expr).toContain(`'${ch}'`);
    }
    // Coerces number-typed columns to text before substituting.
    expect(expr).toContain("{Phone}&''");
  });
});

describe("airtablePhoneMatchFormula", () => {
  it("matches national and international variants of an Israeli mobile", () => {
    const formula = airtablePhoneMatchFormula("Phone", "+972501234567");
    expect(formula).toBeTruthy();
    // Query expanded to the shapes tenants store: with plus, without, national 0-prefix.
    expect(formula).toContain("'+972501234567'");
    expect(formula).toContain("'972501234567'");
    expect(formula).toContain("'0501234567'");
    // Multiple variants must be OR'd, not concatenated.
    expect(formula!.startsWith("OR(")).toBe(true);
  });

  it("escapes quotes so a crafted value cannot break out of the formula", () => {
    const formula = airtablePhoneMatchFormula("Phone", "0501234567");
    expect(formula).not.toContain("''0501234567");
    const crafted = airtablePhoneMatchFormula("Phone", "050'1234567");
    // Interior quote arrives escaped or stripped - never raw.
    if (crafted) expect(crafted).not.toMatch(/[^\\]'050'12/);
  });

  it("refuses queries too short to identify anyone", () => {
    expect(airtablePhoneMatchFormula("Phone", "123")).toBeNull();
  });
});
