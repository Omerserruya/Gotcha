/**
 * Reading iCount's answer about whether the receipt was actually sent.
 *
 * The distinction that matters here is between "no" and "it did not say". Only
 * one of them is a delivery failure; treating the other as one would resend
 * every receipt, and treating it as a success would leave a customer with no
 * proof of payment and nothing in the logs to notice it by.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@chatcenter/shared", () => ({
  prisma: {},
  readDurableSetting: async () => null,
  writeDurableSetting: async () => undefined,
  settingCacheKey: (t: string, k: string) => `tenant:${t}:${k}`,
  shopifyApiVersion: () => "2026-07",
  checkShopifyResponseVersion: () => ({ ok: true, served: "2026-07" }),
  metaGraphBaseUrl: () => "https://graph.facebook.com/v24.0",
  stripeVersionHeader: () => ({ "Stripe-Version": "2026-02-25.clover" }),
}));

import { readEmailStatus } from "../providers/icount-client";

describe("reading the email status", () => {
  it("reads a single status object", () => {
    expect(readEmailStatus({ email_status: { email: "a@b.co", email_sent: true } })).toEqual({
      sent: true,
      reason: null,
    });
  });

  it("reads a list, one entry per recipient", () => {
    const r = readEmailStatus({
      email_status: [
        { email: "a@b.co", email_sent: false, reason: "bounced" },
        { email: "c@d.co", email_sent: true },
      ],
    });
    // One delivery is a delivery. The reason is kept so the bounce is still
    // visible rather than hidden by the success next to it.
    expect(r).toEqual({ sent: true, reason: "bounced" });
  });

  it("reports a refusal as a refusal, with its reason", () => {
    expect(readEmailStatus({ emails: [{ email_sent: false, reason: "no_address" }] })).toEqual({
      sent: false,
      reason: "no_address",
    });
  });

  it("accepts the string and numeric spellings of true", () => {
    expect(readEmailStatus({ email_status: { email_sent: 1 } }).sent).toBe(true);
    expect(readEmailStatus({ email_status: { email_sent: "1" } }).sent).toBe(true);
  });

  it("says UNKNOWN, not false, when the response is silent", () => {
    // The whole point of asking. A silent answer must trigger a deliberate
    // send, not be recorded as a delivery that never happened.
    expect(readEmailStatus({ status: true, docnum: "1234" }).sent).toBeNull();
    expect(readEmailStatus({}).sent).toBeNull();
    expect(readEmailStatus(null).sent).toBeNull();
  });

  it("reads a flat email_sent when that is all there is", () => {
    expect(readEmailStatus({ email_sent: false })).toEqual({ sent: false, reason: null });
  });
});
