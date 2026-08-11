/**
 * One answer to "which currency is this organization priced in".
 *
 * `BillingProfile.currency` is the commercial currency: the one the catalog
 * quotes and the one every ceiling the customer types is denominated in. It is
 * NOT the settlement currency - charges convert to ILS through a frozen quote,
 * and `Charge.chargeCurrency` records that separately.
 *
 * This exists because the same field had three different defaults: the schema
 * said ILS, the API wrote USD when the client omitted it, and the settings
 * screen displayed ILS when the row had not loaded. A ceiling of "100" then
 * meant ₪100 or $100 depending on which path created the row, which is a factor
 * of roughly three on a number whose entire job is to stop overspending.
 */
import { prisma } from "@chatcenter/shared";

/** Matches BillingProfile.currency's own schema default. */
export const DEFAULT_COMMERCIAL_CURRENCY = "ILS";

export async function commercialCurrencyFor(entityId: string | null | undefined): Promise<string> {
  if (!entityId) return DEFAULT_COMMERCIAL_CURRENCY;
  const profile = await prisma.billingProfile.findUnique({
    where: { billableEntityId: entityId },
    select: { currency: true },
  });
  return profile?.currency?.trim() || DEFAULT_COMMERCIAL_CURRENCY;
}
