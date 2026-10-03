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

/**
 * Which fact the blank fields represent.
 *
 * Backend added this after `billingIdentity()` was found returning
 * `profile ?? empty` — collapsing three states into one blank form, one layer
 * below the screen, where nothing here could see it.
 *
 * The vocabulary is `PUT /billing/profile`'s own refusal codes, deliberately:
 * *"a fourth convention for the same distinction would be worse than the
 * collapse it fixes."*
 */
export const BILLING_IDENTITY_STATES = [
  'no_billable_entity',
  'no_billing_profile',
  'present',
] as const;
export type BillingIdentityState = (typeof BILLING_IDENTITY_STATES)[number];

export const billingProfileSchema = z.object({
  billingName: z.string().nullable().default(null),
  billingEmail: z.string().nullable().default(null),
  /** Israel's מזהה מס. One field, and the only tax identifier stored. */
  vatId: z.string().nullable().default(null),
  billingCountry: z.string().nullable().default(null),
  billingAddress: z.string().nullable().default(null),
  currency: z.string().default('ILS'),
  /**
   * Defaults to `present` so a response predating the fix still parses — and
   * `present` is the reading that says least, rather than asserting an absence
   * the old payload never claimed.
   */
  state: z.enum(BILLING_IDENTITY_STATES).default('present'),
});

export type BillingProfile = z.infer<typeof billingProfileSchema>;

/**
 * `{ data }` — and `data` is now always an object, carrying `state`.
 *
 * It used to be nullable here because `billingIdentity()` returned
 * `profile ?? empty` and a null was the only signal left. That is fixed
 * upstream, so the nullability is kept only for a response that predates it.
 */
export const billingProfileResponseSchema = z
  .object({ data: z.unknown().nullable().default(null) })
  .transform(({ data }) => (data ? billingProfileSchema.parse(data) : null));

export const paymentMethodSchema = z.object({
  id: z.string().min(1),
  brand: z.string().nullable().default(null),
  last4: z.string().nullable().default(null),
  /** 17e's "Expires 08/28". Sent by the route; the contract used to strip it. */
  expMonth: z.number().int().min(1).max(12).nullable().catch(null).default(null),
  expYear: z.number().int().nullable().catch(null).default(null),
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

/**
 * The FOUR things blank billing fields can mean.
 *
 * Three come from `state`, and the fourth is named in the route's own comment:
 * *"`present` with every field null means EMPTIED, which is a different thing
 * from `no_billing_profile` and must read differently."*
 *
 * | reading | what is true | what to say |
 * |---|---|---|
 * | `no_account` | no billable entity exists | *"add your billing details"* is not even the right instruction — there is nothing to add them to |
 * | `never_entered` | an account exists, no profile row | they have not filled it in |
 * | `emptied` | a profile exists and was cleared | they HAD details and no longer do |
 * | `filled` | details present | show them |
 *
 * Rendering one sentence for the first three is the collapse this replaced:
 * *"telling somebody whose details were DELETED that they never had any."*
 */
export type ProfileReading = 'no_account' | 'never_entered' | 'emptied' | 'filled';

export function profileReading(profile: BillingProfile | null): ProfileReading {
  // Only a response predating the fix can be null, and it carries no state.
  if (profile === null) return 'never_entered';
  if (profile.state === 'no_billable_entity') return 'no_account';
  if (profile.state === 'no_billing_profile') return 'never_entered';
  return isBlank(profile) ? 'emptied' : 'filled';
}

/** "08/28" — or null when either half is missing. */
export function cardExpiry(method: PaymentMethod): string | null {
  if (method.expMonth == null || method.expYear == null) return null;
  return `${String(method.expMonth).padStart(2, '0')}/${String(method.expYear % 100).padStart(2, '0')}`;
}
