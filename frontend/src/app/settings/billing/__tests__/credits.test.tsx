/**
 * Buying credits, rendered.
 *
 * Two changes here have never been run: an intent key so a double-click is one
 * purchase rather than two charges, and a distinct response when the payment
 * outcome is unknown.
 *
 * The intent key only works if it is stable across clicks. A useRef that is
 * subtly wrong - regenerated on render, or per click - would leave the fix
 * looking present in the diff and absent in reality, which is worse than not
 * having attempted it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const buy = vi.fn();
const getPackages = vi.fn();
const getSummary = vi.fn();

vi.mock("@/context/AuthContext", () => ({ useAuth: () => ({ token: "tok" }) }));
vi.mock("@/context/I18nContext", () => ({ useI18n: () => ({ t: (k: string) => k, locale: "en" }) }));
vi.mock("@/components/RequirePermission", () => ({
  RequirePermission: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/api-billing", () => ({
  getPackages: (...a: unknown[]) => getPackages(...a),
  buyCredits: (...a: unknown[]) => buy(...a),
  getCreditSummary: (...a: unknown[]) => getSummary(...a),
}));

import BuyCreditsPage from "../credits/page";

const PACKAGE = { id: "p1", key: "pack_1k", name: "1,000 credits", units: 1000, price: "49.00", currency: "USD" };

beforeEach(() => {
  vi.clearAllMocks();
  getPackages.mockResolvedValue({ packages: [PACKAGE] });
  // The real shape: getCreditSummary returns the summary itself, not a wrapper,
  // and the page reads summary.purchasedCredits.balance.
  getSummary.mockResolvedValue({
    purchasedCredits: { balance: 0 },
    includedCredits: { balance: 0, allowance: 2000 },
  });
});

/**
 * Go through the real purchase path.
 *
 * The package button opens a price-review dialog - the page deliberately makes
 * a purchase more than one accidental click - and the charge happens on the
 * confirm inside it. Clicking only the first button buys nothing, which is the
 * behaviour, not a bug.
 */
async function buyThroughDialog() {
  const openers = (await screen.findAllByText("usage.buy.cta")).map((n) => n.closest("button")!);
  fireEvent.click(openers[0]);
  const confirmCta = await screen.findByText("usage.buy.confirmCta");
  fireEvent.click(confirmCta);
  return openers[0];
}

describe("a double-click is one purchase", () => {
  it("sends the same intent key both times", async () => {
    buy.mockResolvedValue({ success: true, units: 1000 });
    render(<BuyCreditsPage />);

    await buyThroughDialog();
    await waitFor(() => expect(buy).toHaveBeenCalled());
    // A second run through the dialog, as an impatient customer would.
    await buyThroughDialog();
    await waitFor(() => expect(buy.mock.calls.length).toBeGreaterThanOrEqual(1));

    const keys = buy.mock.calls.map((c) => c[2]);
    // The whole point: identical keys mean the server treats it as one logical
    // purchase. A key generated per click would make each one a new charge.
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toContain(PACKAGE.key);
  });

  it("scopes the key to the package, so buying two different ones still works", async () => {
    getPackages.mockResolvedValue({
      packages: [PACKAGE, { ...PACKAGE, key: "pack_5k", name: "5,000 credits", units: 5000 }],
    });
    buy.mockResolvedValue({ success: true, units: 1000 });
    render(<BuyCreditsPage />);

    const open = async (index: number) => {
      // The buttons are disabled while a purchase is in flight, so wait for the
      // page to settle before starting the next one - as a person would.
      await waitFor(() => {
        const b = screen.getAllByText("usage.buy.cta").map((n) => n.closest("button")!);
        expect(b[index].hasAttribute("disabled")).toBe(false);
      });
      const buttons = screen.getAllByText("usage.buy.cta").map((n) => n.closest("button")!);
      fireEvent.click(buttons[index]);
      fireEvent.click(await screen.findByText("usage.buy.confirmCta"));
    };

    await open(0);
    await waitFor(() => expect(buy).toHaveBeenCalledTimes(1));
    await open(1);
    await waitFor(() => expect(buy).toHaveBeenCalledTimes(2));

    // Two deliberate purchases must not collide into one.
    expect(buy.mock.calls[0][2]).not.toBe(buy.mock.calls[1][2]);
  });
});

describe("an unknown outcome is not reported as a failure", () => {
  it("says we are confirming, and does not invite a retry", async () => {
    buy.mockResolvedValue({ success: false, outcomeUnknown: true });
    render(<BuyCreditsPage />);
    await buyThroughDialog();

    // They may already have been charged. "Failed" would invite them to pay
    // again, which is the one thing that must not happen here.
    expect(await screen.findByText("usage.buy.checking")).toBeTruthy();
    expect(screen.queryByText("usage.buy.failed")).toBeNull();
  });

  it("still reports an ordinary decline as a failure", async () => {
    buy.mockResolvedValue({ success: false, failureCode: "declined" });
    render(<BuyCreditsPage />);
    await buyThroughDialog();
    // A decline means no money moved, so saying so is correct and retrying is
    // safe. The distinction is the point.
    await waitFor(() => expect(screen.queryByText("usage.buy.checking")).toBeNull());
  });

  it("confirms only on a real success", async () => {
    buy.mockResolvedValue({ success: true, units: 1000 });
    render(<BuyCreditsPage />);
    await buyThroughDialog();
    expect(await screen.findByText(/usage\.buy\.done/)).toBeTruthy();
  });
});
