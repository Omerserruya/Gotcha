import { z } from 'zod';

/**
 * Who the bill is made out to, and what it is charged against — screen 17e.
 *
 * `GET /api/billing/profile` → `{ data }`.
 * `GET /api/billing/payment-methods` → **`{ paymentMethods }`** — a sixth
 * envelope shape on this platform.
 *
 * ── WHAT THE DESIGN ASKS FOR THAT DOES NOT EXIST ──
 * `BillingProfile` carries `billingName`, `billingEmail`, `vatId`,
 * `billingCountry`, `billingAddress` and `currency`. The design also asks
 * for **invoice recipients (plural)**, a **PO number** and a **profile
 * language**. None has a column.
 *
 * `billingEmail` is one address, not a list — so *"send invoices to
 * finance@ and to the owner"* is not expressible, and a second field that
 * quietly overwrote the first would be worse than none.
 */

export const billingProfileSchema = z.object({
  billingName: z.string().nullable().default(null),
  billingEmail: z.string().nullable().default(null),
  /** Israel's מזהה מס. One field, and the only tax identifier stored. */
  vatId: z.string().nullable().default(null),
  billingCountry: z.string().nullable().default(null),
  billingAddress: z.string().nullable().default(null),
  currency: z.string().default('ILS'),
});

export type BillingProfile = z.infer<typeof billingProfileSchema>;

/**
 * `{ data }`, and `data` may be null — **no profile is not an empty profile.**
 *
 * A tenant that has never entered billing details has no row at all, and a
 * screen rendering blank fields for both states would say "you have not
 * filled this in" to someone whose details were deleted.
 */
export const billingProfileResponseSchema = z
  .object({ data: z.unknown().nullable().default(null) })
  .transform(({ data }) => (data ? billingProfileSchema.parse(data) : null));

export const paymentMethodSchema = z.object({
  id: z.string().min(1),
  brand: z.string().nullable().default(null),
  last4: z.string().nullable().default(null),
  isDefault: z.boolean().default(false),
});

export type PaymentMethod = z.infer<typeof paymentMethodSchema>;

/** `{ paymentMethods }` — the sixth envelope. */
export const paymentMethodListSchema = z
  .object({ paymentMethods: z.array(paymentMethodSchema).default([]) })
  .transform(({ paymentMethods }) => paymentMethods);

/**
 * Is there anything at all to charge?
 *
 * **This is not a completeness check on a form.** With no payment method,
 * a charge cannot be attempted — there is nothing to attempt it against —
 * and on this tenant that sits beside four `FAILED` invoices.
 *
 * Stated as arithmetic rather than as a diagnosis: a card that does not
 * exist cannot be charged. Whether it is *the* reason the four failed is
 * Backend's to say; that there is nothing to charge is not in doubt.
 */
export function hasSomethingToCharge(methods: readonly PaymentMethod[]): boolean {
  return methods.length > 0;
}

/** True when a profile exists but every field a bill needs is empty. */
export function isBlank(profile: BillingProfile | null): boolean {
  if (profile === null) return false;
  return (
    profile.billingName === null &&
    profile.billingEmail === null &&
    profile.vatId === null &&
    profile.billingAddress === null
  );
}
