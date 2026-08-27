/**
 * The consent line at the bottom of every email.
 *
 * Setting a workspace up and connecting accounts is the moment the agreement is
 * entered into, so the mail that accompanies it has to carry the terms and make
 * them reachable. The failure this guards against is quiet: a template is added
 * later, renders fine, and is the one email with no terms on it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  renderBrandEmail,
  legalUrls,
  legalConsentHtml,
  legalConsentText,
  withLegalConsentText,
} from "../lib/email/brand-email";

const ORIGINAL = process.env.FRONTEND_URL;

beforeEach(() => { process.env.FRONTEND_URL = "https://app.example.test"; });
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.FRONTEND_URL;
  else process.env.FRONTEND_URL = ORIGINAL;
});

describe("where the links point", () => {
  it("uses the app origin every other email link is built from", () => {
    expect(legalUrls()).toEqual({
      terms: "https://app.example.test/legal/terms-of-service",
      privacy: "https://app.example.test/legal/privacy-policy",
    });
  });

  it("points at slugs the Trust Center actually publishes", () => {
    // Both are registered public documents. A typo here renders a live-looking
    // link that 404s, which is worse than no link at all.
    const { terms, privacy } = legalUrls();
    expect(terms.endsWith("/legal/terms-of-service")).toBe(true);
    expect(privacy.endsWith("/legal/privacy-policy")).toBe(true);
  });
});

describe("the line itself", () => {
  it("says that setting up and connecting is the acceptance", () => {
    const html = legalConsentHtml();
    expect(html).toMatch(/setting up your workspace and connecting accounts/i);
    expect(html).toMatch(/accept/i);
  });

  it("renders both documents as real links", () => {
    const html = legalConsentHtml();
    expect(html).toContain(`href="https://app.example.test/legal/terms-of-service"`);
    expect(html).toContain(`href="https://app.example.test/legal/privacy-policy"`);
    expect(html).toContain("Terms of Service");
    expect(html).toContain("Privacy Policy");
  });

  it("speaks Hebrew when the email does", () => {
    const html = legalConsentHtml(true);
    expect(html).toContain("תנאי השימוש");
    expect(html).toContain("מדיניות הפרטיות");
    expect(html).toContain(`href="https://app.example.test/legal/privacy-policy"`);
  });

  it("spells the links out in the plain-text version, where markup does not exist", () => {
    const text = legalConsentText();
    expect(text).toContain("https://app.example.test/legal/terms-of-service");
    expect(text).toContain("https://app.example.test/legal/privacy-policy");
    expect(text).not.toContain("<a ");
  });
});

describe("appending to a plain-text body", () => {
  it("adds the line below the message", () => {
    const out = withLegalConsentText("Your workspace is ready.");
    expect(out.startsWith("Your workspace is ready.")).toBe(true);
    expect(out).toContain("/legal/terms-of-service");
  });

  it("does not add it twice", () => {
    // Several senders compose their text body from pieces; one of them may have
    // added the line already.
    const once = withLegalConsentText("Body");
    expect(withLegalConsentText(once)).toBe(once);
  });

  it("keeps the Hebrew wording when asked", () => {
    expect(withLegalConsentText("גוף ההודעה", true)).toContain("מדיניות הפרטיות");
  });
});

describe("every branded email carries it", () => {
  function render(locale?: string) {
    return renderBrandEmail({
      title: "Set up Acme",
      headline: "Let's set up Acme.",
      locale,
      bodyHtml: "",
    } as any);
  }

  it("appears in the footer of a rendered email", () => {
    const html = render();
    expect(html).toContain("/legal/terms-of-service");
    expect(html).toContain("/legal/privacy-policy");
  });

  it("appears even when the template passes no footerNote", () => {
    // footerNote is optional and most templates omit it; the consent line is
    // not conditional on it.
    expect(render()).toMatch(/Terms of Service/);
  });

  it("follows the email's language", () => {
    expect(render("he")).toContain("תנאי השימוש");
    expect(render("en")).toContain("Terms of Service");
  });

  it("sits in the footer, below the message body", () => {
    const html = render();
    const body = html.indexOf("Let's set up Acme.");
    const consent = html.indexOf("/legal/terms-of-service");
    expect(body).toBeGreaterThan(-1);
    expect(consent).toBeGreaterThan(body);
  });

  it("is small and quiet, not a second call to action", () => {
    // A disclosure that competes with the message is a design bug, and the
    // font size is the only thing stopping it.
    const html = render();
    const idx = html.indexOf("/legal/terms-of-service");
    const surrounding = html.slice(Math.max(0, idx - 900), idx);
    expect(surrounding).toMatch(/font-size:11px/);
  });
});
