/**
 * The public site has to look like ONE site.
 *
 * These are source guards rather than render tests, for the same reason
 * static-export-dynamic-routes.test.ts is: the failure they catch is a page
 * quietly growing its own header again, and that is visible in the source long
 * before anyone opens three tabs side by side to notice.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { chatWidgetAllowed } from "../../landing/ChatWidget";
import { isLandingPath } from "../MarketingChrome";

const SRC = join(__dirname, "../../..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

const chrome = read("components/marketing/MarketingChrome.tsx");

/** Every public page, and the file that renders its chrome. */
const PUBLIC_PAGES: Array<[string, string]> = [
  ["landing", "components/landing/LandingPage.tsx"],
  ["pricing", "app/pricing/page.tsx"],
  ["trust center", "app/legal/LegalShell.tsx"],
];

describe("one header and one footer", () => {
  for (const [name, file] of PUBLIC_PAGES) {
    it(`${name} renders the shared header and footer`, () => {
      const code = read(file);
      expect(code).toContain("<MarketingHeader");
      expect(code).toContain("<MarketingFooter");
    });

    it(`${name} does not draw chrome of its own`, () => {
      const code = read(file);
      expect(code).not.toMatch(/<header[\s>]/);
      expect(code).not.toMatch(/<footer[\s>]/);
    });
  }

  it("the logo is the image, never the brand set in type", () => {
    expect(chrome).toContain('src="/logo_icon.png"');
    // /pricing used to render the word instead. If it comes back, so does the
    // brand changing shape between two pages of the same site.
    expect(read("app/pricing/page.tsx")).not.toContain(">GOTCHA.<");
  });

  it("the early access form wears the same mark", () => {
    const code = read("components/early-access/EarlyAccessForm.tsx");
    expect(code).toContain("<MarketingLogo />");
  });

  it("the footer reaches every legal document", () => {
    for (const slug of ["privacy-policy", "terms-of-service", "cookie-policy", "cancellation-refunds"]) {
      expect(chrome).toContain(`/legal/${slug}`);
    }
    expect(chrome).toContain('href="/legal"');
  });
});

describe("section links resolve off the landing page", () => {
  it("anchors are built through sectionHref, never hardcoded", () => {
    // A bare href="#how-it-works" on /pricing scrolls to nothing.
    expect(chrome).not.toContain('href="#how-it-works"');
    expect(chrome).not.toContain('href="#product-features"');
    expect(chrome).toContain("sectionHref(");
  });

  it("knows which routes are the landing page", () => {
    for (const p of ["/", "/en", "/he", "/en/", "/he/"]) expect(isLandingPath(p)).toBe(true);
    for (const p of ["/pricing", "/legal", "/early-access"]) expect(isLandingPath(p)).toBe(false);
  });
});

describe("chat widget placement", () => {
  it("is on the pages a visitor reads", () => {
    for (const p of ["/", "/en", "/he", "/pricing", "/legal", "/legal/privacy-policy"]) {
      expect(chatWidgetAllowed(p), p).toBe(true);
    }
  });

  it("survives the production trailing slash", () => {
    for (const p of ["/pricing/", "/legal/", "/legal/privacy-policy/"]) {
      expect(chatWidgetAllowed(p), p).toBe(true);
    }
  });

  it("is NOT on the early access form, where it covered the Next button", () => {
    expect(chatWidgetAllowed("/early-access")).toBe(false);
    expect(chatWidgetAllowed("/early-access/")).toBe(false);
  });

  it("is not on application routes", () => {
    for (const p of ["/conversations", "/settings/billing", "/login", "/getting-started"]) {
      expect(chatWidgetAllowed(p), p).toBe(false);
    }
  });

  it("is mounted once for the whole site, not per page", () => {
    expect(read("app/layout.tsx")).toContain("<ChatWidget />");
    // Per-page mounts are what left it on screen after a client-side hop into
    // the form: the loader refuses to run twice and never tears down.
    for (const page of ["app/page.tsx", "app/en/page.tsx", "app/he/page.tsx"]) {
      expect(read(page), page).not.toContain("<ChatWidget");
    }
  });

  it("hides the launcher rather than trying to unmount it", () => {
    const code = read("components/landing/ChatWidget.tsx");
    expect(code).toContain("#gotcha-chat-root");
    expect(code).toContain("display:none");
  });
});
