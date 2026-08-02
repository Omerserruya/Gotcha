/**
 * Manual provider - used for GRANDFATHERED tenants and admin-managed accounts.
 * No real charging happens; it exists so grandfathered/manual flows share the
 * same PaymentProvider surface without special-casing call sites.
 */
import type { PaymentProvider, TokenizeResult, ChargeInput, ChargeResult, RefundInput } from "./provider";

export const manualProvider: PaymentProvider = {
  name: "MANUAL",
  async tokenizeAndVerify(): Promise<TokenizeResult> {
    return { token: "manual_no_card" };
  },
  async charge(input: ChargeInput): Promise<ChargeResult> {
    // Manual/grandfathered accounts are never auto-charged.
    return { success: false, failureCode: "manual_provider_no_charge" };
  },
  async refund(_input: RefundInput): Promise<ChargeResult> {
    return { success: false, failureCode: "manual_provider_no_refund" };
  },
  verifyWebhook(): boolean {
    return false;
  },
};
