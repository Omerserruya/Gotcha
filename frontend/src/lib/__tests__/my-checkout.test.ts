/**
 * Reaching payment without the email.
 *
 * Before this, every checkout route was keyed by a reference the customer
 * only ever received in one message. Archive that mail and the organization
 * owed money with no route to pay it - a state nobody should be able to
 * reach by tidying an inbox.
 *
 * `/checkout/mine` answers from MEMBERSHIP instead, and returns a reference
 * so the caller then goes through the same authorization path as every
 * other visitor rather than a privileged shortcut that could drift from it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getMyCheckout, CheckoutUnavailable } from "../api-checkout";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as any).fetch = fetchMock;
});

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

describe("getMyCheckout", () => {
  it("returns the outstanding checkout", async () => {
    fetchMock.mockResolvedValue(
      ok({ data: { checkout: { reference: "chk_abc", expiresAt: "2026-08-01T00:00:00.000Z" } } }),
    );

    const result = await getMyCheckout({ authToken: "staff-token" });
    expect(result).toEqual({ reference: "chk_abc", expiresAt: "2026-08-01T00:00:00.000Z" });
  });

  it("authorizes with the session, never with a reference", async () => {
    // Membership is the credential here. Passing a reference would make the
    // answer the question.
    fetchMock.mockResolvedValue(ok({ data: { checkout: null } }));
    await getMyCheckout({ authToken: "staff-token" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/checkout\/mine$/);
    expect(String(url)).not.toContain("ref=");
    expect(init.headers.Authorization).toBe("Bearer staff-token");
  });

  it("treats 'nothing owed' as a normal answer, not an error", async () => {
    // A tenant on no billing, or one already paid, simply has nothing to
    // settle. Throwing here would put an error banner on a healthy account.
    fetchMock.mockResolvedValue(ok({ data: { checkout: null } }));
    expect(await getMyCheckout({ authToken: "t" })).toBeNull();
  });

  it("treats an expired checkout as nothing to pay", async () => {
    // Deliberately not auto-reissued: a new expiry is a new commercial
    // offer, and that is an operator's decision.
    fetchMock.mockResolvedValue(ok({ data: { checkout: null, expired: true } }));
    expect(await getMyCheckout({ authToken: "t" })).toBeNull();
  });

  it("survives a response with no data envelope", async () => {
    fetchMock.mockResolvedValue(ok({}));
    expect(await getMyCheckout({ authToken: "t" })).toBeNull();
  });

  it("raises CheckoutUnavailable when the caller may not ask", async () => {
    // 403 is what a suspended tenant gets: PAYMENT_SETUP is denied to them,
    // so they cannot self-serve back in.
    fetchMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });
    await expect(getMyCheckout({ authToken: "t" })).rejects.toBeInstanceOf(CheckoutUnavailable);
  });
});
