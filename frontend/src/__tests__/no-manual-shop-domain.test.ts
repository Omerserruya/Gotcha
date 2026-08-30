/**
 * No merchant-facing Shopify shop-domain input, anywhere.
 *
 * This is a SOURCE-LEVEL guard, not a behavioural test, and that is
 * deliberate. The field was removed from three separate screens plus the help
 * article, and each of them had an independent reason to exist - a stale
 * catalog `authSchema`, an onboarding tile, a marketplace fallback. A unit
 * test of any one component would not notice the field reappearing in the
 * other two, and the cost of it reappearing is an App Store rejection
 * (requirement 2.3.1), which nobody finds until submission.
 *
 * What this asserts is narrow on purpose: no INPUT bound to a shop domain,
 * and no copy telling a merchant to type one. Mentions of `.myshopify.com`
 * in comments, test fixtures and rendered store NAMES are fine and are
 * expected - the widget shows the shop it is connected to, and the finish
 * screen names the store Shopify identified.
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const SRC = path.resolve(__dirname, "..");

/** Every merchant-facing source file, excluding tests and generated output. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const skipDir = new Set(["__tests__", "node_modules", ".next", "out"]);
  (function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (skipDir.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(path.join(dir, entry.name));
      }
    }
  })(SRC);
  return out;
}

/** Strip line and block comments so prose ABOUT the old field does not trip us. */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const FILES = sourceFiles();

describe("no manual Shopify shop-domain entry", () => {
  it("has source files to check (the walker itself works)", () => {
    expect(FILES.length).toBeGreaterThan(50);
  });

  it("renders no input placeholder asking for a myshopify domain", () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      const code = stripComments(fs.readFileSync(f, "utf8"));
      // A placeholder is the tell: it only exists on a field a merchant types into.
      if (/placeholder\s*[:=]\s*["'`][^"'`]*myshopify\.com/i.test(code)) {
        offenders.push(path.relative(SRC, f));
      }
    }
    expect(offenders, `shop-domain placeholder found in: ${offenders.join(", ")}`).toEqual([]);
  });

  it("declares no credential/config field keyed on the shop domain", () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      const code = stripComments(fs.readFileSync(f, "utf8"));
      // `{ key: "shop", label: "Shop domain", ... }` - the injected field shape.
      if (/key:\s*["']shop["'][^}]*label:\s*["'][^"']*[Ss]hop domain/.test(code)) {
        offenders.push(path.relative(SRC, f));
      }
      if (/label:\s*["'][^"']*[Ss]hop domain["']/.test(code)) {
        offenders.push(path.relative(SRC, f));
      }
    }
    expect(offenders, `shop-domain field declared in: ${offenders.join(", ")}`).toEqual([]);
  });

  it("keeps no shopDomain form state in the onboarding connect flow", () => {
    for (const rel of ["app/setup/page.tsx", "app/setup/connect-screen.tsx"]) {
      const code = fs.readFileSync(path.join(SRC, rel), "utf8");
      expect(code, rel).not.toMatch(/setShopDomain/);
      expect(code, rel).not.toMatch(/useState.*shopDomain/);
    }
  });

  it("never sends a `shop` parameter when starting a Shopify connection", () => {
    const code = fs.readFileSync(path.join(SRC, "lib/shopify-connect.ts"), "utf8");
    expect(stripComments(code)).not.toMatch(/shop:/);
    // And the install start takes no shop argument at all.
    const api = fs.readFileSync(path.join(SRC, "lib/api.ts"), "utf8");
    expect(api).toMatch(/startShopifyInstall\(token: string, flow\?: string\)/);
  });

  it("tells merchants Shopify picks the store, not that they should type it", () => {
    const help = fs.readFileSync(path.join(SRC, "app/help/content/integrations.ts"), "utf8");
    expect(help).not.toMatch(/Enter your store's \*\*myshopify domain\*\*/);
    expect(help).not.toMatch(/הזינו את דומיין ה-\*\*myshopify\*\*/);
    expect(help).toMatch(/select and authorize|Shopify opens and asks which store/i);
  });
});
