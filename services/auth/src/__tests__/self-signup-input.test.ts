/**
 * The public sign-up form, as it is read (2026-11-22).
 *
 * The form is open to anyone and two of its fields are printed in an email to
 * whatever address was typed. So besides "a real form passes", this pins what
 * is refused: markup, links, and anything loosely typed where a tick or a
 * language is expected.
 */
import { describe, it, expect } from "vitest";
import { parseSignupBody, signupSlug, SIGNUP_LIMITS } from "../lib/self-signup-input";

const FORM = {
  name: "Noa Levi",
  email: "noa@cafe-noga.co.il",
  businessName: "Cafe Noga",
  locale: "he",
  terms: true,
  privacy: true,
};

const value = (body: unknown) => {
  const p = parseSignupBody(body);
  if (!p.ok || p.honeypot) throw new Error("expected a read form, got " + JSON.stringify(p));
  return p.value;
};
const fields = (body: unknown) => {
  const p = parseSignupBody(body);
  if (p.ok) throw new Error("expected a refusal, got " + JSON.stringify(p));
  return p.fields;
};

describe("a real form", () => {
  it("is read as sent", () => {
    expect(value(FORM)).toEqual({
      name: "Noa Levi",
      email: "noa@cafe-noga.co.il",
      businessName: "Cafe Noga",
      locale: "he",
      capturedText: null,
    });
  });

  it("the email is trimmed and lowercased: one person is one address however they typed it", () => {
    expect(value({ ...FORM, email: "  Noa@Cafe-Noga.CO.IL " }).email).toBe("noa@cafe-noga.co.il");
  });

  it("names lose the spaces around and the doubled spaces inside", () => {
    const v = value({ ...FORM, name: "  Noa   Levi ", businessName: " Cafe \n Noga " });
    expect(v.name).toBe("Noa Levi");
    expect(v.businessName).toBe("Cafe Noga");
  });

  it("the words next to the boxes are kept as evidence, cut at 1000", () => {
    expect(value({ ...FORM, capturedText: " I accept the Terms " }).capturedText).toBe("I accept the Terms");
    expect(value({ ...FORM, capturedText: "x".repeat(1500) }).capturedText).toHaveLength(1000);
    expect(value({ ...FORM, capturedText: 7 }).capturedText).toBeNull();
  });

  it.each([
    ["עומר סרויה"],
    ["ג'ון כהן"],
    ["ז׳אן לוי"],
    ["O'Brien"],
    ["O’Brien"],
    ["Jean-Luc Picard"],
    ["J.R. Cohen"],
    ["Dr. Levi"],
    ["José Álvarez"],
    ["محمد علي"],
  ])("a person's name: %s", (name) => {
    expect(value({ ...FORM, name }).name).toBe(name);
  });

  it.each([
    ["קפה נוגה"],
    ["Levi & Sons Ltd."],
    ["Studio 54"],
    ["monday.com"],
    ["A/B Testing Lab"],
    ["נעלי \"הצפון\" בע\"מ"],
    ["Mom's Kitchen (Haifa)"],
  ])("a business name: %s", (businessName) => {
    expect(value({ ...FORM, businessName }).businessName).toBe(businessName);
  });

  it.each([["he"], ["en"]])("the language %s", (locale) => {
    expect(value({ ...FORM, locale }).locale).toBe(locale);
  });
});

describe("what is refused", () => {
  it("an empty form names every field", () => {
    expect(fields({})).toEqual({
      name: "required",
      businessName: "required",
      email: "required",
      locale: "required",
      terms: "required",
      privacy: "required",
    });
  });

  it.each([[null], [undefined], ["a string"], [42], [[FORM]]])("a body that is not a form: %j", (body) => {
    expect(Object.keys(fields(body)).sort()).toEqual(["businessName", "email", "locale", "name", "privacy", "terms"]);
  });

  it("only the wrong field is named", () => {
    expect(fields({ ...FORM, email: "noa" })).toEqual({ email: "invalid" });
  });

  it.each([
    ["spaces only", "   "],
    ["not a string", 12],
    ["missing", undefined],
  ])("name %s: required", (_l, name) => {
    expect(fields({ ...FORM, name })).toEqual({ name: "required" });
  });

  it.each([
    ["a link", "http://evil.example"],
    ["a web address", "Visit evil.example"],
    ["a www address", "www.evil.example"],
    ["markup", "<b>Noa</b>"],
    ["an email address", "noa@evil.example"],
    ["digits", "Noa 2000"],
    ["a slash", "Noa/Levi"],
    ["punctuation first", "-Noa"],
    ["an exclamation", "Win a prize!"],
  ])("name with %s: invalid", (_l, name) => {
    expect(fields({ ...FORM, name })).toEqual({ name: "invalid" });
  });

  it("a name at the limit passes, one letter more is too long", () => {
    expect(value({ ...FORM, name: "a".repeat(SIGNUP_LIMITS.name) }).name).toHaveLength(80);
    expect(fields({ ...FORM, name: "a".repeat(SIGNUP_LIMITS.name + 1) })).toEqual({ name: "too_long" });
  });

  it.each([
    ["a link", "Cafe http://evil.example"],
    ["a link in another scheme", "ftp://files"],
    ["a www address", "WWW.evil.example"],
    ["markup", "<a href=x>Cafe</a>"],
    ["a closing tag only", "Cafe>"],
    ["an email address", "write to boss@evil.example"],
    ["a control character", "Cafe" + String.fromCharCode(0) + "Noga"],
    ["no letter or digit at all", "!!! ---"],
  ])("business name with %s: invalid", (_l, businessName) => {
    expect(fields({ ...FORM, businessName })).toEqual({ businessName: "invalid" });
  });

  it("a business name at the limit passes, one letter more is too long", () => {
    expect(value({ ...FORM, businessName: "b".repeat(SIGNUP_LIMITS.businessName) }).businessName).toHaveLength(80);
    expect(fields({ ...FORM, businessName: "b".repeat(SIGNUP_LIMITS.businessName + 1) })).toEqual({ businessName: "too_long" });
  });

  it("an empty business name is required, not invalid", () => {
    expect(fields({ ...FORM, businessName: "  " })).toEqual({ businessName: "required" });
  });

  it.each([
    ["no at sign", "noa.cafe-noga.co.il"],
    ["two at signs", "noa@@cafe-noga.co.il"],
    ["a space inside", "noa levi@cafe-noga.co.il"],
    ["no domain", "noa@"],
    ["no dot in the domain", "noa@localhost"],
    ["no name", "@cafe-noga.co.il"],
    ["a display name", "Noa <noa@cafe-noga.co.il>"],
    ["two addresses", "noa@cafe-noga.co.il,boss@evil.example"],
    ["a second recipient after a semicolon", "noa@cafe-noga.co.il;boss@evil.example"],
    ["a quote", "\"noa\"@cafe-noga.co.il"],
    // One "@" each, so only the comma or the semicolon can refuse them.
    ["a comma in the name", "noa,levi@cafe-noga.co.il"],
    ["a semicolon in the name", "noa;levi@cafe-noga.co.il"],
    ["a comma after the domain", "noa@cafe-noga.co.il,evil.example"],
    ["a semicolon after the domain", "noa@cafe-noga.co.il;evil.example"],
  ])("email with %s: invalid", (_l, email) => {
    expect(fields({ ...FORM, email })).toEqual({ email: "invalid" });
  });

  it("an email that is not a string is required; one past 254 characters is too long", () => {
    expect(fields({ ...FORM, email: { $ne: "" } })).toEqual({ email: "required" });
    expect(fields({ ...FORM, email: "a".repeat(250) + "@x.io" })).toEqual({ email: "too_long" });
  });

  it.each([["fr"], ["HE"], ["he-IL"], ["hebrew"], [true], [1]])("language %j: invalid, never quietly English", (locale) => {
    expect(fields({ ...FORM, locale })).toEqual({ locale: "invalid" });
  });

  it.each([[undefined], [null], [""]])("language %j: required", (locale) => {
    expect(fields({ ...FORM, locale })).toEqual({ locale: "required" });
  });

  it.each([["true"], [1], ["on"], [false], [undefined], [null]])("a box sent as %j is not a tick", (box) => {
    expect(fields({ ...FORM, terms: box })).toEqual({ terms: "required" });
    expect(fields({ ...FORM, privacy: box })).toEqual({ privacy: "required" });
  });

  it("each box stands alone", () => {
    expect(fields({ ...FORM, terms: false, privacy: false })).toEqual({ terms: "required", privacy: "required" });
  });
});

describe("the hidden field", () => {
  it("filled: a bot, and nothing else is read", () => {
    expect(parseSignupBody({ ...FORM, website: "https://spam.example" })).toEqual({ ok: true, honeypot: true });
  });

  it("filled on a form that is wrong everywhere: still no validation answer to learn from", () => {
    expect(parseSignupBody({ website: "x" })).toEqual({ ok: true, honeypot: true });
  });

  it.each([[""], ["   "], [undefined], [null], [0], [false]])("left as %j: an ordinary form", (website) => {
    expect(value({ ...FORM, website }).email).toBe("noa@cafe-noga.co.il");
  });
});

describe("the organization's address name", () => {
  it.each([
    ["Cafe Noga", "cafe-noga-a1b2c3"],
    ["  Levi & Sons Ltd.  ", "levi-sons-ltd-a1b2c3"],
    ["José Álvarez Studio", "jose-alvarez-studio-a1b2c3"],
    ["monday.com", "monday-com-a1b2c3"],
    ["Studio 54", "studio-54-a1b2c3"],
    ["קפה נוגה", "org-a1b2c3"],
    ["קפה X", "org-a1b2c3"],
    ["קפה Noga", "noga-a1b2c3"],
    ["!!!", "org-a1b2c3"],
  ])("%s", (name, slug) => {
    expect(signupSlug(name, "a1b2c3")).toBe(slug);
  });

  it("a long name is cut at 40 and never ends on a hyphen before the suffix", () => {
    const slug = signupSlug("The Very Long Name Of A Business That Sells Everything To Everyone", "ffffff");
    expect(slug).toBe("the-very-long-name-of-a-business-that-se-ffffff");
    expect(signupSlug("a".repeat(39) + " bcd", "ffffff")).toBe("a".repeat(39) + "-ffffff");
  });

  it("two draws for one name differ only in the suffix", () => {
    expect(signupSlug("Cafe Noga", "000001")).not.toBe(signupSlug("Cafe Noga", "000002"));
  });
});
