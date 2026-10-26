/**
 * The consent line at the bottom of every email.
 *
 * Setting a workspace up and connecting accounts is the moment the agreement is
 * entered into, so the mail that accompanies it has to carry the terms and make
 * them reachable. The failure this guards against is quiet: a template is added
 * later, renders fine, and is the one email with no terms on it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  renderBrandEmail,
  LEGAL_VERSIONS,
  legalUrls,
  legalConsentHtml,
  legalConsentText,
  withLegalConsentText,
} from "../lib/email/brand-email";

const ORIGINAL = { app: process.env.FRONTEND_URL, trust: process.env.TRUST_PUBLIC_URL };

beforeEach(() => {
  process.env.FRONTEND_URL = "https://app.example.test";
  delete process.env.TRUST_PUBLIC_URL;
});
afterEach(() => {
  if (ORIGINAL.app === undefined) delete process.env.FRONTEND_URL;
  else process.env.FRONTEND_URL = ORIGINAL.app;
  if (ORIGINAL.trust === undefined) delete process.env.TRUST_PUBLIC_URL;
  else process.env.TRUST_PUBLIC_URL = ORIGINAL.trust;
});

const TERMS = "https://trust.gotcha.co.il/terms-of-service";
const PRIVACY = "https://trust.gotcha.co.il/privacy-policy";
const TERMS_HE = "https://trust.gotcha.co.il/he/terms-of-service";
const PRIVACY_HE = "https://trust.gotcha.co.il/he/privacy-policy";

describe("where the links point", () => {
  it("is the Trust Center itself, not the app's /legal, which is two redirects away", () => {
    expect(legalUrls()).toEqual({ terms: TERMS, privacy: PRIVACY });
    expect(legalUrls("en")).toEqual({ terms: TERMS, privacy: PRIVACY });
  });

  it("links the Hebrew documents in Hebrew (the app's /legal always lands on English)", () => {
    expect(legalUrls("he")).toEqual({ terms: TERMS_HE, privacy: PRIVACY_HE });
    expect(legalUrls("he-IL")).toEqual({ terms: TERMS_HE, privacy: PRIVACY_HE });
  });

  it("follows TRUST_PUBLIC_URL when a host sets it", () => {
    process.env.TRUST_PUBLIC_URL = "https://trust.example.test/";
    expect(legalUrls("he").terms).toBe("https://trust.example.test/he/terms-of-service");
  });

  it("points at slugs the Trust Center actually publishes", () => {
    // Both are registered public documents. A typo here renders a live-looking
    // link that 404s, which is worse than no link at all.
    const root = join(__dirname, "../../../../docs/legal");
    for (const locale of ["en", "he"]) {
      const { terms, privacy } = legalUrls(locale);
      for (const url of [terms, privacy]) {
        const slug = url.split("/").pop()!;
        expect(() => readFileSync(join(root, locale, `${slug}.md`))).not.toThrow();
      }
    }
  });
});

describe("the version a consent records", () => {
  // "Accepted the Terms" is only evidence when it says which Terms. These are
  // the documents' own effective dates, in both languages.
  const doc = (locale: string, slug: string) =>
    readFileSync(join(__dirname, "../../../../docs/legal", locale, `${slug}.md`), "utf8");
  const EN_MONTH: Record<string, string> = { July: "07", August: "08", September: "09", October: "10" };
  const HE_MONTH: Record<string, string> = { "ביולי": "07", "באוגוסט": "08", "בספטמבר": "09", "באוקטובר": "10" };
  const en = (text: string) => {
    const m = /Effective date: (\w+) (\d{1,2}), (\d{4})/.exec(text)!;
    return `${m[3]}-${EN_MONTH[m[1]]}-${m[2].padStart(2, "0")}`;
  };
  const he = (text: string) => {
    const m = /תאריך תחולה: (\d{1,2}) (\S+) (\d{4})/.exec(text)!;
    return `${m[3]}-${HE_MONTH[m[2]]}-${m[1].padStart(2, "0")}`;
  };

  it("matches the Terms' effective date", () => {
    expect(en(doc("en", "terms-of-service"))).toBe(LEGAL_VERSIONS.terms);
    expect(he(doc("he", "terms-of-service"))).toBe(LEGAL_VERSIONS.terms);
  });

  it("matches the Privacy Policy's effective date", () => {
    expect(en(doc("en", "privacy-policy"))).toBe(LEGAL_VERSIONS.privacy);
    expect(he(doc("he", "privacy-policy"))).toBe(LEGAL_VERSIONS.privacy);
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
    expect(html).toContain(`href="${TERMS}"`);
    expect(html).toContain(`href="${PRIVACY}"`);
    expect(html).toContain("Terms of Service");
    expect(html).toContain("Privacy Policy");
  });

  it("speaks Hebrew when the email does", () => {
    const html = legalConsentHtml(true);
    expect(html).toContain("תנאי השירות");
    expect(html).toContain("מדיניות הפרטיות");
    expect(html).toContain(`href="${TERMS_HE}"`);
    expect(html).toContain(`href="${PRIVACY_HE}"`);
  });

  it("spells the links out in the plain-text version, where markup does not exist", () => {
    const text = legalConsentText();
    expect(text).toContain(TERMS);
    expect(text).toContain(PRIVACY);
    expect(text).not.toContain("<a ");
  });
});

describe("appending to a plain-text body", () => {
  it("adds the line below the message", () => {
    const out = withLegalConsentText("Your workspace is ready.");
    expect(out.startsWith("Your workspace is ready.")).toBe(true);
    expect(out).toContain(TERMS);
  });

  it("does not add it twice", () => {
    // Several senders compose their text body from pieces; one of them may have
    // added the line already.
    const once = withLegalConsentText("Body");
    expect(withLegalConsentText(once)).toBe(once);
  });

  it("keeps the Hebrew wording, and the Hebrew documents, when asked", () => {
    const out = withLegalConsentText("גוף ההודעה", true);
    expect(out).toContain("מדיניות הפרטיות");
    expect(out).toContain(PRIVACY_HE);
    expect(withLegalConsentText(out, true)).toBe(out);
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
    expect(html).toContain(TERMS);
    expect(html).toContain(PRIVACY);
  });

  it("appears even when the template passes no footerNote", () => {
    // footerNote is optional and most templates omit it; the consent line is
    // not conditional on it.
    expect(render()).toMatch(/Terms of Service/);
  });

  it("follows the email's language", () => {
    expect(render("he")).toContain("תנאי השירות");
    expect(render("he")).toContain(TERMS_HE);
    expect(render("en")).toContain("Terms of Service");
    expect(render("en")).toContain(TERMS);
  });

  it("sits in the footer, below the message body", () => {
    const html = render();
    const body = html.indexOf("Let's set up Acme.");
    const consent = html.indexOf(TERMS);
    expect(body).toBeGreaterThan(-1);
    expect(consent).toBeGreaterThan(body);
  });

  it("is small and quiet, not a second call to action", () => {
    // A disclosure that competes with the message is a design bug, and the
    // font size is the only thing stopping it.
    const html = render();
    const idx = html.indexOf(TERMS);
    const surrounding = html.slice(Math.max(0, idx - 900), idx);
    expect(surrounding).toMatch(/font-size:11px/);
  });
});
