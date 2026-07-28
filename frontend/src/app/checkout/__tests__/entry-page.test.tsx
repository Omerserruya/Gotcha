/**
 * The checkout entry page: where the emailed payment link lands.
 *
 * Its whole job is to send the visitor to the right one of the five outcome
 * pages, so these tests are about routing and about NOT inventing rules. The
 * real `pathForStatus` is used deliberately: mocking it would let the entry
 * page and the outcome pages drift apart in exactly the way this page exists
 * to prevent.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import Page from "../page";
import { pathForStatus, type CheckoutStatus, type CheckoutSummary } from "@/lib/api-checkout";

const replace = vi.hoisted(() => vi.fn());
const params = vi.hoisted(() => ({ current: new URLSearchParams("ref=chk_abc&token=tok_123") }));
const getCheckoutStatus = vi.hoisted(() => vi.fn());
const advanceCheckout = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => params.current,
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: any) => <a href={href}>{children}</a>,
}));

vi.mock("@/context/I18nContext", () => ({
  useI18n: () => ({ t: (k: string) => k, locale: "en", dir: "ltr" }),
}));

vi.mock("@/lib/api-checkout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-checkout")>()),
  getCheckoutStatus,
  advanceCheckout,
}));

function summary(status: CheckoutStatus): CheckoutSummary {
  return {
    reference: "chk_abc",
    organizationName: "Acme",
    planName: "Growth",
    chatVolumeOptionKey: null,
    voiceVolumeOptionKey: null,
    includedCredits: 20000,
    amount: "499",
    currency: "USD",
    charge: null,
    billingInterval: "MONTHLY",
    expiresAt: "2026-08-01T12:00:00.000Z",
    status,
    nextAction: "START_PAYMENT_SETUP",
    retryEligible: true,
    paymentSetupAvailable: true,
    declineCategory: null,
    awaitingResolution: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  params.current = new URLSearchParams("ref=chk_abc&token=tok_123");
  sessionStorage.clear();
  advanceCheckout.mockResolvedValue({ phase: "AWAITING_CARD" });
});

const ALL_STATUSES: CheckoutStatus[] = [
  "AWAITING_PAYMENT_SETUP",
  "PAYMENT_REQUIRED",
  "PROCESSING",
  "MANUAL_REVIEW",
  "FAILED",
  "EXPIRED",
  "COMPLETED",
];

describe("checkout entry page", () => {
  it.each(ALL_STATUSES)("sends a %s checkout to the page the server says it belongs on", async (status) => {
    getCheckoutStatus.mockResolvedValue(summary(status));
    render(<Page />);

    await waitFor(() => expect(replace).toHaveBeenCalled());
    const target = String(replace.mock.calls[0][0]);
    // Compared against the REAL mapping, so a change to pathForStatus that
    // this page did not anticipate shows up here.
    expect(target.split("?")[0]).toBe(pathForStatus(status));
    expect(target).toContain("ref=chk_abc");
  });

  it("keeps no status on this page: it always hands over", async () => {
    // The page must not become a sixth place a checkout can sit. If it ever
    // renders a terminal state itself, that state stops self-correcting.
    for (const status of ALL_STATUSES) {
      replace.mockClear();
      getCheckoutStatus.mockResolvedValue(summary(status));
      const { unmount } = render(<Page />);
      await waitFor(() => expect(replace).toHaveBeenCalledTimes(1));
      unmount();
    }
  });

  it("gets the token out of the address bar", async () => {
    // It is a bearer credential for a payment, and it arrives in a URL only
    // because it came from an email. A URL persists in history, in a shared
    // device's autocomplete, and in any screen-share.
    getCheckoutStatus.mockResolvedValue(summary("PAYMENT_REQUIRED"));
    render(<Page />);

    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(window.location.search).not.toContain("tok_123");
    expect(String(replace.mock.calls[0][0])).not.toContain("tok_123");
  });

  it("leaves the credential nowhere a script can read it", async () => {
    // It used to be parked in sessionStorage, which fixed the URL and left it
    // readable by any XSS on the page. The server holds it in an HttpOnly
    // cookie now; the browser has no copy of its own.
    getCheckoutStatus.mockResolvedValue(summary("PAYMENT_REQUIRED"));
    render(<Page />);

    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(JSON.stringify({ ...sessionStorage, ...localStorage })).not.toContain("tok_123");
    expect(document.cookie).not.toContain("tok_123");
  });

  it("carries only the reference to the next page", async () => {
    // The first authorized request establishes the cookie, so putting the
    // token back into a URL would undo the point of taking it out.
    getCheckoutStatus.mockResolvedValue(summary("PAYMENT_REQUIRED"));
    render(<Page />);

    await waitFor(() => expect(replace).toHaveBeenCalled());
    const target = String(replace.mock.calls[0][0]);
    expect(target).toContain("ref=chk_abc");
    expect(target).not.toContain("token=");
  });

  it("authorizes the status lookup with the emailed token", async () => {
    getCheckoutStatus.mockResolvedValue(summary("PAYMENT_REQUIRED"));
    render(<Page />);

    await waitFor(() => expect(getCheckoutStatus).toHaveBeenCalled());
    const [reference, opts] = getCheckoutStatus.mock.calls[0];
    expect(reference).toBe("chk_abc");
    expect(opts.token).toBe("tok_123");
  });

  it("shows the unavailable state when the link carries no reference", async () => {
    // A token alone cannot name a checkout, which is precisely why the email
    // now carries both.
    params.current = new URLSearchParams("token=tok_123");
    render(<Page />);

    expect(await screen.findByText("checkout.unavailable.title")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("shows the unavailable state when the checkout cannot be read", async () => {
    // Expired, revoked, or somebody else's: the same answer for all three.
    getCheckoutStatus.mockRejectedValue(new Error("checkout_unavailable:404"));
    render(<Page />);

    expect(await screen.findByText("checkout.unavailable.title")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("does not drive the checkout forward", async () => {
    // `advance` can charge a card. Landing on a link is not a reason to move
    // money; only the pages that follow a payment attempt do that.
    getCheckoutStatus.mockResolvedValue(summary("PAYMENT_REQUIRED"));
    render(<Page />);

    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(advanceCheckout).not.toHaveBeenCalled();
  });

  it("shows a skeleton rather than a blank page while it looks up", async () => {
    // A blank page reads as a broken link to someone who just clicked through
    // from email to pay.
    getCheckoutStatus.mockImplementation(() => new Promise(() => {}));
    render(<Page />);

    expect(await screen.findByText("checkout.opening.title")).toBeInTheDocument();
  });
});
