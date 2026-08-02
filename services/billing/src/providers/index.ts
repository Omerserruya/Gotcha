import type { BillingProvider } from "@prisma/client";
import type { PaymentProvider } from "./provider";
import { icountProvider } from "./icount.provider";
import { manualProvider } from "./manual.provider";
import { ICOUNT_CAPABILITIES, MANUAL_CAPABILITIES, type ProviderCapabilities } from "./capabilities";

export * from "./provider";
export * from "./capabilities";
export * from "./icount-paypage";

const REGISTRY: Record<BillingProvider, PaymentProvider> = {
  ICOUNT: icountProvider,
  MANUAL: manualProvider,
  // STRIPE: stripeProvider,  // future - same interface, no call-site changes.
  STRIPE: manualProvider,
};

/** The default real provider for new signups (env-selectable). */
export function defaultProvider(): PaymentProvider {
  const key = (process.env.BILLING_PROVIDER || "ICOUNT").toUpperCase() as BillingProvider;
  return REGISTRY[key] ?? icountProvider;
}

export function getProvider(name: BillingProvider): PaymentProvider {
  return REGISTRY[name] ?? icountProvider;
}

const CAPABILITIES: Record<BillingProvider, ProviderCapabilities> = {
  ICOUNT: ICOUNT_CAPABILITIES,
  MANUAL: MANUAL_CAPABILITIES,
  STRIPE: MANUAL_CAPABILITIES, // not integrated - nothing is verified
};

/**
 * What a provider is VERIFIED to be able to do. Callers gate on this rather
 * than assuming, so an unverified operation fails closed at the call site.
 */
export function getCapabilities(name: BillingProvider): ProviderCapabilities {
  return CAPABILITIES[name] ?? MANUAL_CAPABILITIES;
}
