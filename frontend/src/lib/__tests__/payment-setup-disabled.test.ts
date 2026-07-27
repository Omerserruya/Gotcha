import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "../..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

describe("no browser-entered provider token", () => {
  const page = read("app/settings/billing/payment-method/page.tsx");

  it("the window.prompt fake-token path is gone", () => {
    // Comments stripped: the file deliberately EXPLAINS what was removed and
    // why, and that explanation must not trip the check it documents.
    const code = page.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(code).not.toMatch(/window\.prompt/);
    expect(code).not.toContain("devTokenPrompt");
  });

  it("the popup/postMessage flow is not reachable from the page", () => {
    expect(page).not.toContain("openPayPage");
    expect(page).not.toContain("NEXT_PUBLIC_ICOUNT_PAYPAGE_URL");
  });

  it("shows an unavailable state instead, with no provider internals", () => {
    expect(page).toContain("paymentSetupUnavailable");
    const en = JSON.parse(read("i18n/en.json"));
    const copy = en.settings.billing.paymentSetupUnavailable as string;
    expect(copy).toMatch(/not enabled/i);
    // Customer-facing copy must not name the provider or expose internals.
    expect(copy.toLowerCase()).not.toContain("icount");
    expect(copy.toLowerCase()).not.toContain("token");
  });

  it("nothing in the app imports the dead popup module", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) {
          if (entry !== "node_modules" && entry !== ".next" && entry !== "__tests__") walk(p);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry)) continue;
        if (p.endsWith("icount-paypage.ts")) continue; // the module itself
        if (/from ["'].*icount-paypage["']/.test(readFileSync(p, "utf8"))) hits.push(p);
      }
    };
    walk(SRC);
    expect(hits, `dead popup module still imported by: ${hits.join(", ")}`).toEqual([]);
  });

  it("the dead module is clearly marked for removal", () => {
    expect(read("lib/icount-paypage.ts")).toMatch(/DEAD CODE - UNREACHABLE, PENDING REMOVAL/);
  });
});
