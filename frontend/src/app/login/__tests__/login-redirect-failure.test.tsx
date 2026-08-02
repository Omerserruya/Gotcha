/**
 * /login is a redirect shim, so its ONLY interesting behaviour is what happens
 * when the redirect cannot start.
 *
 * Reaching Authentik begins with a cross-origin OIDC discovery fetch. When the
 * IdP is momentarily unreachable that fetch returns no CORS headers and the
 * browser rejects it - and the page used to discard the rejection, leaving a
 * spinner that never resolved and, because of the one-shot latch, never tried
 * again. A blip must not be indistinguishable from a dead product.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import LoginPage from "../page";

const beginLogin = vi.fn();
let authState: { user: unknown; isLoading: boolean } = { user: null, isLoading: false };

vi.mock("@/lib/oidc", () => ({
  beginLogin: (...a: unknown[]) => beginLogin(...a),
}));

vi.mock("@/context/AuthContext", () => ({
  useAuth: () => authState,
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("next/image", () => ({
  default: (props: Record<string, unknown>) => {
    // eslint-disable-next-line @next/next/no-img-element
    return <img alt={String(props.alt ?? "")} src={String(props.src ?? "")} />;
  },
}));

describe("/login when sign-in cannot be reached", () => {
  beforeEach(() => {
    beginLogin.mockReset();
    authState = { user: null, isLoading: false };
  });

  it("shows a spinner, not an error, while the redirect is in flight", () => {
    beginLogin.mockReturnValue(new Promise(() => {}));
    render(<LoginPage />);
    expect(screen.getByText(/Taking you to secure sign-in/i)).toBeTruthy();
    expect(screen.queryByTestId("login-retry")).toBeNull();
  });

  it("surfaces the failure instead of spinning forever", async () => {
    beginLogin.mockRejectedValue(new Error("Failed to fetch"));
    render(<LoginPage />);

    await waitFor(() => expect(screen.getByTestId("login-retry")).toBeTruthy());
    expect(screen.getByText(/could not reach secure sign-in/i)).toBeTruthy();
    // The spinner's promise is settled - it must stop claiming progress.
    expect(screen.queryByText(/Taking you to secure sign-in/i)).toBeNull();
  });

  it("retries for real: the latch is released, so Try again calls beginLogin", async () => {
    beginLogin.mockRejectedValueOnce(new Error("Failed to fetch"));
    render(<LoginPage />);

    await waitFor(() => expect(screen.getByTestId("login-retry")).toBeTruthy());
    expect(beginLogin).toHaveBeenCalledTimes(1);

    beginLogin.mockReturnValueOnce(new Promise(() => {}));
    fireEvent.click(screen.getByTestId("login-retry"));

    expect(beginLogin).toHaveBeenCalledTimes(2);
    // A retry in flight goes back to the waiting state, not a stale error.
    await waitFor(() => expect(screen.queryByTestId("login-retry")).toBeNull());
    expect(screen.getByText(/Taking you to secure sign-in/i)).toBeTruthy();
  });

  it("does not start a redirect while auth is still resolving", () => {
    authState = { user: null, isLoading: true };
    render(<LoginPage />);
    expect(beginLogin).not.toHaveBeenCalled();
  });
});
