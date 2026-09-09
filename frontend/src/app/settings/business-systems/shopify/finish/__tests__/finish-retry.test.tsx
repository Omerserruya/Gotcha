/**
 * Finishing a Shopify install when OUR session lapses mid-flow.
 *
 * The real incident this covers: a merchant installed from Shopify with no
 * GOTCHA session, landed here, and the app silently renewed the token through
 * Authentik while this page was already mounted. The page fired its lookup with
 * the pre-renew token, got `401 invalid_token`, and showed
 * "Could not load the pending installation" - a terminal-sounding message for a
 * transient condition. The Shopify authorization was intact and the pending
 * record still had minutes of TTL, so the merchant was told to redo work that
 * had already succeeded.
 *
 * Three properties are worth defending, and each is tested on its own:
 *
 *   1. an expired token produces a WAIT, not an error;
 *   2. the retry happens exactly once, and only on a genuinely NEW token -
 *      otherwise a renew storm turns into a request loop against an endpoint
 *      that gates a single-use installation;
 *   3. a lapsed session stays distinguishable from an expired handle and from
 *      a real server fault, because the remedies differ completely.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";

const getPendingShopifyInstall = vi.fn();
const claimShopifyInstall = vi.fn();
const push = vi.fn();

let authToken: string | null = "token-fresh";

vi.mock("@/lib/api", () => ({
  getPendingShopifyInstall: (...a: unknown[]) => getPendingShopifyInstall(...a),
  claimShopifyInstall: (...a: unknown[]) => claimShopifyInstall(...a),
}));

vi.mock("@/context/AuthContext", () => ({
  useAuth: () => ({ token: authToken }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => new URLSearchParams("handle=HANDLE_UNDER_TEST"),
}));

import FinishPage from "../page";

/** The shape `apiFetch` throws: a status plus a structured code. */
function apiError(status: number, code?: string) {
  const e = new Error(code ?? `HTTP ${status}`) as Error & { status?: number; code?: string };
  e.status = status;
  if (code) e.code = code;
  return e;
}

const expired = () => apiError(401, "invalid_token");

beforeEach(() => {
  vi.clearAllMocks();
  authToken = "token-fresh";
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a stale token is a wait, not a failure", () => {
  it("shows 'Reconnecting' rather than an error when the token is expired", async () => {
    getPendingShopifyInstall.mockRejectedValueOnce(expired());
    render(<FinishPage />);

    await waitFor(() => expect(screen.getByText(/Reconnecting your session/i)).toBeTruthy());
    // The old copy must not appear: it read as terminal for a transient state.
    expect(screen.queryByText(/Could not load the pending installation/i)).toBeNull();
    expect(screen.queryByText(/expired or was already used/i)).toBeNull();
  });

  it("does not retry while the token is unchanged", async () => {
    // A re-render with the SAME rejected token must not spend the one retry on
    // a request certain to fail identically.
    getPendingShopifyInstall.mockRejectedValue(expired());
    const { rerender } = render(<FinishPage />);
    await waitFor(() => expect(getPendingShopifyInstall).toHaveBeenCalledTimes(1));

    rerender(<FinishPage />);
    rerender(<FinishPage />);
    await new Promise((r) => setTimeout(r, 20));
    expect(getPendingShopifyInstall).toHaveBeenCalledTimes(1);
  });
});

describe("the refreshed token drives exactly one retry", () => {
  it("retries once when a NEW token arrives, and succeeds", async () => {
    getPendingShopifyInstall
      .mockRejectedValueOnce(expired())
      .mockResolvedValueOnce({ data: { shopDomain: "activewaer.myshopify.com" } });

    const { rerender } = render(<FinishPage />);
    await waitFor(() => expect(screen.getByText(/Reconnecting your session/i)).toBeTruthy());

    authToken = "token-refreshed";
    rerender(<FinishPage />);

    await waitFor(() => expect(screen.getByText("activewaer.myshopify.com")).toBeTruthy());
    expect(getPendingShopifyInstall).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/Connect to this workspace/i)).toBeTruthy();
  });

  it("passes the REFRESHED token to the retry, not the rejected one", async () => {
    getPendingShopifyInstall
      .mockRejectedValueOnce(expired())
      .mockResolvedValueOnce({ data: { shopDomain: "activewaer.myshopify.com" } });

    const { rerender } = render(<FinishPage />);
    await waitFor(() => expect(getPendingShopifyInstall).toHaveBeenCalledTimes(1));
    authToken = "token-refreshed";
    rerender(<FinishPage />);

    await waitFor(() => expect(getPendingShopifyInstall).toHaveBeenCalledTimes(2));
    expect(getPendingShopifyInstall.mock.calls[0][0]).toBe("token-fresh");
    expect(getPendingShopifyInstall.mock.calls[1][0]).toBe("token-refreshed");
  });

  it("STOPS after one retry - a renew storm cannot become a request loop", async () => {
    getPendingShopifyInstall.mockRejectedValue(expired());
    const { rerender } = render(<FinishPage />);
    await waitFor(() => expect(getPendingShopifyInstall).toHaveBeenCalledTimes(1));

    for (const t of ["t2", "t3", "t4", "t5", "t6"]) {
      authToken = t;
      rerender(<FinishPage />);
      await new Promise((r) => setTimeout(r, 10));
    }

    // Hard cap: the first attempt plus exactly one retry. Never more, however
    // many times the token changes.
    expect(getPendingShopifyInstall).toHaveBeenCalledTimes(2);
  });

  it("offers Reload when the retry also fails", async () => {
    getPendingShopifyInstall.mockRejectedValue(expired());
    const { rerender } = render(<FinishPage />);
    await waitFor(() => expect(getPendingShopifyInstall).toHaveBeenCalledTimes(1));
    authToken = "token-refreshed";
    rerender(<FinishPage />);

    await waitFor(() => expect(screen.getByText(/session expired/i)).toBeTruthy());
    expect(screen.getByRole("button", { name: /Reload and continue/i })).toBeTruthy();
    // The store is still authorized - the merchant must not be sent back to
    // Shopify to redo an install that succeeded.
    expect(screen.getByText(/still authorized on\s+Shopify/i)).toBeTruthy();
  });
});

describe("waiting does not last forever", () => {
  it("falls back to the session-expired screen if no new token ever arrives", async () => {
    vi.useFakeTimers();
    getPendingShopifyInstall.mockRejectedValue(expired());
    render(<FinishPage />);

    // Flush the rejected promise's microtasks so the effect has actually
    // reached `awaiting_refresh` before any timer is advanced - otherwise the
    // grace timer has not been armed yet and advancing proves nothing.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText(/Reconnecting your session/i)).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000);
    });

    // A silent hang is worse than an honest ask: the pending installation is
    // expiring the whole time it spins.
    expect(screen.getByRole("button", { name: /Reload and continue/i })).toBeTruthy();
  });
});

describe("a lapsed session stays distinct from every other failure", () => {
  it("404 means the handle is gone, and says to install again", async () => {
    getPendingShopifyInstall.mockRejectedValueOnce(apiError(404));
    render(<FinishPage />);

    await waitFor(() => expect(screen.getByText(/expired or was already used/i)).toBeTruthy());
    expect(screen.queryByText(/session expired/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /Reload and continue/i })).toBeNull();
  });

  it("a 404 is NOT retried - a consumed handle cannot be un-consumed", async () => {
    getPendingShopifyInstall.mockRejectedValue(apiError(404));
    const { rerender } = render(<FinishPage />);
    await waitFor(() => expect(getPendingShopifyInstall).toHaveBeenCalledTimes(1));

    authToken = "token-refreshed";
    rerender(<FinishPage />);
    await new Promise((r) => setTimeout(r, 20));

    // Retrying would be pointless and would risk a second consumption attempt
    // against a single-use installation.
    expect(getPendingShopifyInstall).toHaveBeenCalledTimes(1);
  });

  it("a 500 is a plain error, neither a session prompt nor an install-again", async () => {
    getPendingShopifyInstall.mockRejectedValueOnce(apiError(500));
    render(<FinishPage />);

    await waitFor(() =>
      expect(screen.getByText(/could not load the pending installation/i)).toBeTruthy(),
    );
    expect(screen.queryByText(/session expired/i)).toBeNull();
    expect(screen.queryByText(/expired or was already used/i)).toBeNull();
  });

  it("a 401 WITHOUT invalid_token is not treated as a refreshable session", async () => {
    // Only the specific code means "our token lapsed". Anything else 401 is a
    // real authorization problem and must not sit in a retry loop.
    getPendingShopifyInstall.mockRejectedValueOnce(apiError(401, "no_account"));
    render(<FinishPage />);
    await waitFor(() =>
      expect(screen.getByText(/could not load the pending installation/i)).toBeTruthy(),
    );
  });
});

describe("the claim is never issued twice", () => {
  it("does not auto-claim on retry - only the lookup repeats", async () => {
    getPendingShopifyInstall
      .mockRejectedValueOnce(expired())
      .mockResolvedValueOnce({ data: { shopDomain: "activewaer.myshopify.com" } });

    const { rerender } = render(<FinishPage />);
    await waitFor(() => expect(getPendingShopifyInstall).toHaveBeenCalledTimes(1));
    authToken = "token-refreshed";
    rerender(<FinishPage />);
    await waitFor(() => expect(screen.getByText("activewaer.myshopify.com")).toBeTruthy());

    // The lookup is a peek; the claim is what consumes. Retrying the peek must
    // never imply consuming.
    expect(claimShopifyInstall).not.toHaveBeenCalled();
  });
});
