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
  it("the client can prompt a re-check but never report an outcome", () => {
    // Checkout is enabled now, so two calls legitimately mutate: starting a
    // payment session, and asking the server to look again. The invariant that
    // matters is narrower than "no mutations" - it is that nothing the browser
    // sends can DECIDE anything.
    const bodies = Array.from(client.matchAll(/body:\s*JSON\.stringify\(([^;]*?)\),/g), (m) => m[1]);
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      // Only proof of who is asking may travel in a request body.
      expect(body, `a request body may carry only authorization, not: ${body}`).toMatch(
        /^\s*opts\.token \? \{ token: opts\.token \} : \{\}\s*$/,
      );
    }
    // "COMPLETED" is a status the client READS, and starting payment SETUP is
    // fine - what must not exist is a function that claims the money moved.
    for (const verb of ["complete", "activate", "confirm", "markPaid", "charge"]) {
      expect(client, `no client function may ${verb} a checkout`).not.toMatch(
        new RegExp(`export (async )?function ${verb}\\w*`, "i"),
      );
    }
    expect(client).toContain("never tell it what happened");
  });

  it("no mutation sends a status, amount or transaction reference", () => {
    // Scoped to what is actually SENT. Checking the whole file would match the
    // response types, which legitimately describe a status the client reads.
    const sent = Array.from(client.matchAll(/method:\s*"POST"[\s\S]*?\n  \}\);/g), (m) => m[0]);
    expect(sent.length).toBeGreaterThan(0);
    for (const request of sent) {
      for (const forbidden of ["paid", "success", "status", "amount", "transactionId", "confirmationCode", "chargeRef"]) {
        expect(request, `a request must not carry ${forbidden}`).not.toMatch(
          new RegExp(`${forbidden}\\s*:`, "i"),
        );
      }
    }
  });

  it.each(PAGES)("%s builds no request of its own", (p) => {
    const page = read(`app/checkout/${p}/page.tsx`);
    // Pages go through the client, so the rules asserted above apply to them
    // too rather than being re-implemented per page.
    expect(page).not.toMatch(/fetch\(/);
    expect(page).not.toMatch(/method:\s*["']POST["']/);
  });

  it("the destination for card entry comes from the server", () => {
    const page = read("app/checkout/payment-required/page.tsx");
    // A client-chosen destination would be an open redirect into a page asking
    // for card details.
    expect(page).toContain("startPaymentSession");
    expect(page).toMatch(/window\.location\.assign\(redirectUrl\)/);
    expect(page).not.toMatch(/window\.open\(/);
  });

  it("driving the checkout forward asks, it does not assert", () => {
    expect(shell).toContain("advanceCheckout");
    expect(shell).toContain("It sends no outcome");
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

describe("the continuation token does not live in the address bar", () => {
  it("is stripped from the URL without a navigation", () => {
    expect(shell).toContain('searchParams.delete("token")');
    // replaceState rather than a navigation, so polling in progress and the
    // page state are untouched.
    expect(shell).toContain("window.history.replaceState");
  });

  it("is stripped before paint, not after", () => {
    // The address bar should not hold a payment credential for however long
    // rendering happens to take.
    const fn = shell.slice(shell.indexOf("function useCheckoutToken"), shell.indexOf("export function CheckoutShell"));
    expect(fn).toContain("useLayoutEffect");
  });

  it("is not parked anywhere a script can read it", () => {
    // It used to go to sessionStorage, which fixed the URL and left the
    // credential readable by any XSS on the page. The server holds it in an
    // HttpOnly cookie now.
    // Matches use, not the comment explaining why it is no longer used.
    expect(shell).not.toMatch(/sessionStorage\s*\.\s*(set|get)Item/);
    expect(shell).not.toMatch(/localStorage\s*\.\s*setItem/);
    expect(shell).not.toContain("gotcha.checkout.");
  });

  it("the self-correcting redirect does not put it back", () => {
    // Re-appending the token on every internal redirect would undo the whole
    // point of removing it. The cookie set by the request that just succeeded
    // authorizes the next page instead.
    const at = shell.indexOf("pathForStatus(data.status)");
    const redirect = shell.slice(at, at + 500);
    expect(redirect).toContain("router.replace(`${target}?ref=${encodeURIComponent(reference)}`)");
    expect(redirect).not.toContain("token=");
  });
});
