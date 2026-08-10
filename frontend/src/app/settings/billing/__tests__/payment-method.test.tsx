/**
 * Adding a card, rendered.
 *
 * This page was rewired from "the browser posts us a token it received" to
 * "we send you to the provider and then ask the server what happened", and had
 * never been run since. The rewiring is the whole security property, so the
 * things worth asserting are behavioural: what it sends, what it never sends,
 * and what it does with an answer it does not like.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const startSession = vi.fn();
const confirm = vi.fn();
const getMethods = vi.fn();
const removeMethod = vi.fn();
const getIdentity = vi.fn();
const saveIdentity = vi.fn();

/** A receipt already has a name and a country, unless a test says otherwise. */
const COMPLETE_IDENTITY = {
  billingName: "Urban Supply Ltd",
  vatId: "515151515",
  billingEmail: "billing@urban.example",
  billingCountry: "IL",
  billingAddress: null,
};

vi.mock("@/context/AuthContext", () => ({ useAuth: () => ({ token: "tok" }) }));
vi.mock("@/context/I18nContext", () => ({ useI18n: () => ({ t: (k: string) => k, locale: "en" }) }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams("") }));
vi.mock("@/components/RequirePermission", () => ({
  RequirePermission: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/lib/api-billing", () => ({
  getPaymentMethods: (...a: unknown[]) => getMethods(...a),
  startPaymentMethodSession: (...a: unknown[]) => startSession(...a),
  confirmPaymentMethod: (...a: unknown[]) => confirm(...a),
  removePaymentMethod: (...a: unknown[]) => removeMethod(...a),
  getBillingIdentity: (...a: unknown[]) => getIdentity(...a),
  saveBillingIdentity: (...a: unknown[]) => saveIdentity(...a),
}));

import PaymentMethodPage from "../payment-method/page";

const assign = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  getMethods.mockResolvedValue({ paymentMethods: [] });
  getIdentity.mockResolvedValue({ data: COMPLETE_IDENTITY });
  sessionStorage.clear();
  Object.defineProperty(window, "location", {
    value: { ...window.location, assign },
    writable: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("starting card entry", () => {
  it("sends the person to the destination the SERVER chose", async () => {
    startSession.mockResolvedValue({ data: { redirectUrl: "https://provider.example/pay/abc", sessionId: "s1" } });
    render(<PaymentMethodPage />);

    const button = await screen.findByText("settings.billing.addCard");
    fireEvent.click(button);

    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://provider.example/pay/abc"));
    // A client-chosen destination would be an open redirect into a page that
    // asks for card details.
    expect(startSession).toHaveBeenCalledWith("tok");
  });

  it("remembers the session across the round trip", async () => {
    startSession.mockResolvedValue({ data: { redirectUrl: "https://provider.example/pay", sessionId: "s-remember" } });
    render(<PaymentMethodPage />);
    fireEvent.click(await screen.findByText("settings.billing.addCard"));

    // The provider's page is a different origin; without this the session id is
    // gone by the time they come back and nothing can be confirmed.
    await waitFor(() => expect(sessionStorage.getItem("gotcha.paymentMethodSession")).toBe("s-remember"));
  });

  it("says setup is unavailable rather than failing silently", async () => {
    startSession.mockRejectedValue(new Error("payment_setup_unavailable"));
    render(<PaymentMethodPage />);
    fireEvent.click(await screen.findByText("settings.billing.addCard"));

    expect(await screen.findByText("settings.billing.paymentSetupUnavailable")).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
  });
});

describe("coming back from the provider", () => {
  it("asks the server, and never claims success itself", async () => {
    sessionStorage.setItem("gotcha.paymentMethodSession", "s-return");
    confirm.mockResolvedValue({ data: { status: "STORED", paymentMethod: { id: "pm1", brand: "visa", last4: "4242" } } });
    render(<PaymentMethodPage />);

    await waitFor(() => expect(confirm).toHaveBeenCalledWith("tok", "s-return"));
    // Only the session id travels. The browser has no idea whether a card was
    // stored, and must not be the thing that says so.
    expect(confirm.mock.calls[0]).toEqual(["tok", "s-return"]);
    expect(await screen.findByText("settings.billing.cardSaved")).toBeTruthy();
  });

  it("clears the session once the card is stored", async () => {
    sessionStorage.setItem("gotcha.paymentMethodSession", "s-clear");
    confirm.mockResolvedValue({ data: { status: "STORED", paymentMethod: { id: "pm1" } } });
    render(<PaymentMethodPage />);
    await waitFor(() => expect(sessionStorage.getItem("gotcha.paymentMethodSession")).toBeNull());
  });

  it("keeps asking while the provider has not registered the card yet", async () => {
    vi.useFakeTimers();
    sessionStorage.setItem("gotcha.paymentMethodSession", "s-pending");
    confirm.mockResolvedValue({ data: { status: "PENDING", reason: "no_new_card_yet" } });
    render(<PaymentMethodPage />);

    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(2100);
    // A single "not yet" is not an answer - the provider takes a moment to
    // register the card.
    await vi.waitFor(() => expect(confirm.mock.calls.length).toBeGreaterThan(1));
  });

  it("gives up quietly rather than showing an error to someone who changed their mind", async () => {
    vi.useFakeTimers();
    sessionStorage.setItem("gotcha.paymentMethodSession", "s-abandon");
    confirm.mockResolvedValue({ data: { status: "PENDING" } });
    render(<PaymentMethodPage />);

    await vi.advanceTimersByTimeAsync(30_000);
    // Abandoning is a choice, not an error.
    expect(screen.queryByText("settings.billing.actionFailed")).toBeNull();
  });

  it("does nothing at all when there is no session to confirm", async () => {
    render(<PaymentMethodPage />);
    await waitFor(() => expect(getMethods).toHaveBeenCalled());
    // A page load is not a returning customer.
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("who the receipt is for, asked before the card", () => {
  it("will not start card entry until a name and country are known", async () => {
    // The name travels with the tokenization session and becomes the
    // provider's client record. A card stored without it belongs to "GOTCHA
    // customer" forever, and renaming the client does not rename the receipts
    // already issued against it.
    getIdentity.mockResolvedValue({ data: { ...COMPLETE_IDENTITY, billingName: null, billingCountry: null } });
    render(<PaymentMethodPage />);

    const button = await screen.findByText("settings.billing.addCard");
    fireEvent.click(button);

    await waitFor(() => expect(screen.getByText(/who is the receipt for/i)).toBeTruthy());
    expect(startSession).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it("lets it through once they are", async () => {
    startSession.mockResolvedValue({ data: { redirectUrl: "https://provider.example/pay", sessionId: "s-ok" } });
    render(<PaymentMethodPage />);
    fireEvent.click(await screen.findByText("settings.billing.addCard"));
    await waitFor(() => expect(startSession).toHaveBeenCalled());
  });
});
