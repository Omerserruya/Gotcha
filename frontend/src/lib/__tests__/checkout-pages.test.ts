/**
 * Customer checkout pages.
 *
 * The properties here are the ones that would mislead a paying customer or
 * leak provider internals if they regressed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathForStatus, type CheckoutStatus } from "../api-checkout";

const SRC = join(__dirname, "../..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

const PAGES = ["payment-required", "processing", "failed", "expired", "completed"] as const;
const shell = read("components/checkout/CheckoutShell.tsx");
const client = read("lib/api-checkout.ts");
const en = JSON.parse(read("i18n/en.json"));
const he = JSON.parse(read("i18n/he.json"));

describe("all five routes exist", () => {
  it.each(PAGES)("/checkout/%s", (p) => {
    expect(() => read(`app/checkout/${p}/page.tsx`)).not.toThrow();
  });
});

describe("a browser can never complete a checkout", () => {
  it("the client exposes no mutation at all", () => {
    expect(client).not.toMatch(/method:\s*["'](POST|PUT|PATCH|DELETE)["']/);
    // "COMPLETED" is a status the client READS; what must not exist is a
    // function that completes anything.
    expect(client).not.toMatch(/export (async )?function \w*[Cc]omplete/);
    expect(client).not.toMatch(/export (async )?function \w*(Pay|Charge|Activate)/);
    expect(client).toContain("Read-only by construction");
  });

  it.each(PAGES)("%s posts nothing", (p) => {
    const page = read(`app/checkout/${p}/page.tsx`);
    expect(page).not.toMatch(/fetch\(/);
    expect(page).not.toMatch(/method:\s*["']POST["']/);
  });

  it("the server decides which page you belong on", () => {
    // A stale bookmark or a redirect claiming success self-corrects.
    expect(shell).toContain("router.replace");
    expect(shell).toContain("The server is authoritative about which page this belongs on");
  });

  it("completed is reachable only when the server says COMPLETED", () => {
    expect(read("app/checkout/completed/page.tsx")).toContain('useCheckout(["COMPLETED"])');
  });
});

describe("status routing", () => {
  it("maps every status to a page", () => {
    const all: CheckoutStatus[] = [
      "AWAITING_PAYMENT_SETUP", "PROCESSING", "PAYMENT_REQUIRED",
      "FAILED", "EXPIRED", "COMPLETED", "MANUAL_REVIEW",
    ];
    for (const s of all) expect(pathForStatus(s)).toMatch(/^\/checkout\//);
  });

  it("shows MANUAL_REVIEW as processing, never as a failure to retry", () => {
    // Retrying an ambiguous outcome could charge the customer twice.
    expect(pathForStatus("MANUAL_REVIEW")).toBe("/checkout/processing");
  });

  it("only the waiting page polls", () => {
    expect(read("app/checkout/processing/page.tsx")).toContain("poll: true");
    for (const p of ["failed", "expired", "completed", "payment-required"] as const) {
      expect(read(`app/checkout/${p}/page.tsx`)).not.toContain("poll: true");
    }
  });
});

describe("customer copy exposes no provider or internals", () => {
  const strings = JSON.stringify(en.checkout) + JSON.stringify(he.checkout);

  it("names no provider, endpoint or card mechanics", () => {
    for (const leak of ["icount", "paypage", "cc/bill", "token", "doctype", "acquirer", "terminal"]) {
      expect(strings.toLowerCase(), `copy must not mention ${leak}`).not.toContain(leak.toLowerCase());
    }
  });

  it("states plainly that nothing was charged when payment fails", () => {
    expect(en.checkout.failed.body).toMatch(/no charge/i);
    expect(en.checkout.paymentRequired.unavailable).toMatch(/nothing has been charged/i);
  });

  it("uses no em dashes", () => {
    expect(strings).not.toMatch(/[—–]/);
  });

  it("has full Hebrew parity", () => {
    const flat = (o: any, p = ""): string[] =>
      Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? flat(v, p + k + ".") : [p + k]));
    expect(flat(en.checkout).filter((k) => !flat(he.checkout).includes(k))).toEqual([]);
  });
});

describe("no internal identifier reaches the page", () => {
  it("the client type carries only safe fields", () => {
    for (const leak of [
      "providerCustomerId", "providerChargeRef", "attemptKey", "tenantId",
      "pageId", "cardToken", "rawPayload",
    ]) {
      expect(client, `client must not expose ${leak}`).not.toContain(leak);
    }
  });

  it("the skeleton shows no numerals, so no false price can flash", () => {
    const skeleton = shell.slice(
      shell.indexOf("export function CheckoutSkeleton"),
      shell.indexOf("export function CheckoutUnavailableState"),
    );
    // Strip Tailwind class strings: w-28 and bg-gray-100 are layout, not price.
    const rendered = skeleton.replace(/className=\{?["'`][^"'`]*["'`]\}?/g, "");
    expect(rendered).not.toMatch(/[$₪]/);
    expect(rendered).not.toMatch(/>\s*[\d,.]+\s*</);
  });
});

describe("accessibility and motion", () => {
  it("the waiting state is announced", () => {
    const page = read("app/checkout/processing/page.tsx");
    expect(page).toContain('role="status"');
    expect(page).toContain('aria-live="polite"');
  });

  it("respects reduced motion", () => {
    expect(read("app/checkout/processing/page.tsx")).toContain("motion-reduce:animate-none");
    expect(shell).toContain("motion-reduce:animate-none");
  });

  it("every interactive control has a visible focus state", () => {
    for (const p of PAGES) {
      const page = read(`app/checkout/${p}/page.tsx`);
      if (/<button|<a |<Link/.test(page)) {
        expect(page, `${p} needs focus-visible styling`).toContain("focus-visible:ring");
      }
    }
    expect(shell).toContain("focus-visible:ring");
  });
});

describe("unauthorized and unknown look identical", () => {
  it("one shared unavailable state, whatever the cause", () => {
    // An unauthorized visitor must not learn whether a reference was real.
    expect(shell).toContain("CheckoutUnavailableState");
    // Line-wrapped JSDoc: collapsing whitespace leaves the " * " continuation,
    // so match a fragment that lives on one line.
    expect(shell).toContain("an unauthorized visitor must not");
    for (const p of PAGES) {
      expect(read(`app/checkout/${p}/page.tsx`)).toContain("CheckoutUnavailableState");
    }
  });
});
