import type { BillingProvider } from "@prisma/client";
import type { PaymentProvider } from "./provider";
import { icountProvider } from "./icount.provider";
import { manualProvider } from "./manual.provider";

export * from "./provider";

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
