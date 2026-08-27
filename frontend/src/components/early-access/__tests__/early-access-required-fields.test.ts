/**
 * Both ways of reaching a lead are mandatory now.
 *
 * The phone step used to be skippable, so a large share of the waitlist had an
 * address and nothing else - and the alert that reaches the team over chat is
 * only actionable with a number on it.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import en from "../../../i18n/en.json";
import he from "../../../i18n/he.json";

const SRC = join(__dirname, "../../..");
const form = readFileSync(join(SRC, "components/early-access/EarlyAccessForm.tsx"), "utf8");

describe("early access required fields", () => {
  it("asks for both an email and a phone, and requires each", () => {
    expect(form).toMatch(/\{ key: "email", type: "email", required: true \}/);
    expect(form).toMatch(/\{ key: "phone", type: "tel", required: true \}/);
  });

  it("rejects a phone number too short to be one", () => {
    expect(form).toContain("earlyAccess.errors.invalidPhone");
    expect(form).toMatch(/replace\(\/\\D\/g, ""\)\.length < 7/);
  });

  it("has the error copy in both languages", () => {
    expect(en.earlyAccess.errors.invalidPhone).toBeTruthy();
    expect(he.earlyAccess.errors.invalidPhone).toBeTruthy();
  });

  it("no longer calls the phone step optional", () => {
    expect(en.earlyAccess.steps.phone.micro.toLowerCase()).not.toContain("optional");
    expect(he.earlyAccess.steps.phone.micro).not.toContain("אופציונלי");
  });

  it("sends the phone with every submission", () => {
    expect(form).toContain("phone: formData.phone.trim(),");
  });

  it("sends the industry as a readable label, not the option key", () => {
    expect(form).toContain("companyDomain: industryLabel(formData.companyDomain)");
  });
});

describe("the endpoint holds the same rule", () => {
  const route = readFileSync(
    join(SRC, "../../services/auth/src/routes/waitlist.ts"),
    "utf8",
  );

  it("refuses a full-form submission missing either contact detail", () => {
    expect(route).toContain("Email is required.");
    expect(route).toContain("A valid phone number is required.");
  });

  it("still accepts the phone-first landing CTA", () => {
    // The rule is scoped to the full form's source; the landing CTA has no
    // email field at all and must keep working.
    expect(route).toContain("leadSource === FULL_FORM_SOURCE");
  });

  it("stops dropping the industry the form sends", () => {
    expect(route).toContain("companyDomain: z.string()");
    expect(route).toContain("company: company || companyDomain || null");
  });
});
