import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "../..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

/**
 * The card-entry flow, and what it must never go back to.
 *
 * Card entry works now - the person is sent to the provider's hosted page and
 * the SERVER confirms afterwards. What these tests protect is the shape of it:
 * no token typed into the app, no popup, no browser-reported outcome.
 */
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

  it("sends the person to a server-chosen destination, in this window", () => {
    expect(page).toContain("startPaymentMethodSession");
    expect(page).toMatch(/window\.location\.assign\(data\.redirectUrl\)/);
    // A card form inside a popup or an iframe teaches people to type card
    // details into a window whose address they cannot see.
    expect(page).not.toMatch(/window\.open\(/);
    expect(page).not.toMatch(/<iframe/);
  });

  it("asks the server what happened rather than reading the return URL", () => {
    expect(page).toContain("confirmPaymentMethod");
    const code = page.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    // The URL someone comes back on is not evidence. Reading a success flag off
    // it would make the whole server-side confirmation pointless.
    for (const claim of ["params.get(\"success\")", "params.get(\"status\")", "params.get(\"token\")", "searchParams.get(\"paid\")"]) {
      expect(code, `must not read ${claim} from the return URL`).not.toContain(claim);
    }
  });

  it("the failure copy names no provider or internals", () => {
    expect(page).toContain("paymentSetupUnavailable");
    const en = JSON.parse(read("i18n/en.json"));
    const copy = en.settings.billing.paymentSetupUnavailable as string;
    // Customer-facing copy must not name the provider or expose internals.
    expect(copy.toLowerCase()).not.toContain("icount");
    expect(copy.toLowerCase()).not.toContain("token");
  });

  it("the popup module is gone, and nothing reaches for it", () => {
    // It survived a while as dead code marked for removal. Now that the real
    // flow exists there is nothing to keep it for.
    expect(() => read("lib/icount-paypage.ts")).toThrow();

    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) {
          if (entry !== "node_modules" && entry !== ".next") walk(p);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry)) continue;
        if (/from ["'].*icount-paypage["']/.test(readFileSync(p, "utf8"))) hits.push(p);
      }
    };
    walk(SRC);
    expect(hits, `popup module still imported by: ${hits.join(", ")}`).toEqual([]);
  });
});
