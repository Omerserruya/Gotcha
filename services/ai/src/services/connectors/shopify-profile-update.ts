/**
 * A customer changing their own Shopify profile.
 *
 * The ownership half of this problem is solved elsewhere and solved by
 * construction: `update_my_profile` has no customer selector in its schema, so
 * `customer-access-guard.ts` supplies one derived from the authenticated
 * channel and the model's opinion never enters. What is left here is the part
 * that goes wrong for ordinary reasons - a malformed email, a phone Shopify
 * will refuse, an address that changes the country and leaves a province from
 * the old one, and a write that appears to succeed while the record does not
 * actually change.
 *
 * Everything is pure. The adapter does the reads and writes; this decides what
 * may be written and whether what came back is what was asked for.
 */

/** The only fields a customer may change about themselves. */
export const PROFILE_FIELDS = ["first_name", "last_name", "email", "phone"] as const;
export const ADDRESS_FIELDS = [
  "address1", "address2", "city", "province", "zip", "country", "company", "phone",
] as const;

export type ProfileField = (typeof PROFILE_FIELDS)[number];
export type AddressField = (typeof ADDRESS_FIELDS)[number];

export interface ProfilePatch {
  customer: Partial<Record<ProfileField, string>>;
  address: Partial<Record<AddressField, string>>;
  /** Fields the customer asked to change that we refuse to touch. */
  rejected: string[];
  errors: string[];
  /** Changing either of these can move which Shopify customer a future turn resolves to. */
  sensitive: boolean;
}

// Deliberately not RFC 5322. This exists to catch "matan@" and "matan gmail
// com" before they reach Shopify, not to adjudicate the address grammar - a
// stricter pattern rejects valid addresses, which is the worse failure when
// the customer is trying to fix their contact details.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/;

/**
 * Phone, as Shopify will accept it.
 *
 * Shopify normalises to E.164 and rejects anything it cannot parse with a
 * customer-visible error. Requiring a leading `+` here would reject "0545680665",
 * which is how an Israeli customer writes their own number, so national format
 * is allowed through and Shopify does the normalising.
 */
const PHONE_RE = /^\+?[\d][\d\s\-().]{6,20}$/;

export function normalizePhone(v: string): string {
  return String(v).replace(/[\s\-().]/g, "");
}

export function validateProfilePatch(fields: Record<string, unknown>): ProfilePatch {
  const patch: ProfilePatch = { customer: {}, address: {}, rejected: [], errors: [], sensitive: false };
  const src = fields && typeof fields === "object" ? fields : {};

  const addressInput =
    src.address && typeof src.address === "object" ? (src.address as Record<string, unknown>) : src;

  for (const [key, raw] of Object.entries(src)) {
    if (key === "address") continue;
    if (raw == null || raw === "") continue;
    const value = String(raw).trim();
    if ((PROFILE_FIELDS as readonly string[]).includes(key)) {
      if (key === "email") {
        if (!EMAIL_RE.test(value)) {
          patch.errors.push(`invalid_email:${value}`);
          continue;
        }
        patch.sensitive = true;
        patch.customer.email = value.toLowerCase();
        continue;
      }
      if (key === "phone") {
        if (!PHONE_RE.test(value)) {
          patch.errors.push(`invalid_phone:${value}`);
          continue;
        }
        patch.sensitive = true;
        patch.customer.phone = normalizePhone(value);
        continue;
      }
      patch.customer[key as ProfileField] = value;
      continue;
    }
    if ((ADDRESS_FIELDS as readonly string[]).includes(key) && addressInput === src) {
      patch.address[key as AddressField] = value;
      continue;
    }
    // Not in either allowlist. `tags`, `note`, `state`, `tax_exempt`,
    // `verified_email` and friends are merchant-owned: a customer may correct
    // how to reach them, not how the shop has classified them.
    if (!(ADDRESS_FIELDS as readonly string[]).includes(key)) patch.rejected.push(key);
  }

  if (addressInput !== src) {
    for (const [key, raw] of Object.entries(addressInput)) {
      if (raw == null || raw === "") continue;
      if (!(ADDRESS_FIELDS as readonly string[]).includes(key)) {
        patch.rejected.push(`address.${key}`);
        continue;
      }
      patch.address[key as AddressField] = String(raw).trim();
    }
  }

  // A province only means anything against a country. Changing the country and
  // keeping the old province is how an address ends up in "Tel Aviv, United
  // States" - Shopify accepts the pair and the parcel goes nowhere useful.
  if (patch.address.country && !patch.address.province && !patch.address.zip) {
    patch.errors.push("country_changed_without_province_or_zip");
  }

  if (!Object.keys(patch.customer).length && !Object.keys(patch.address).length && !patch.errors.length) {
    patch.errors.push("nothing_to_update");
  }
  return patch;
}

export interface ReadBackVerdict {
  verified: boolean;
  /** Fields that were requested and do NOT match what Shopify now holds. */
  mismatches: Array<{ field: string; requested: string; actual: string | null }>;
}

/**
 * Did the write actually take?
 *
 * Shopify's PUT echoes the object it believes it saved, which is not evidence:
 * it is the same call reporting on itself. This compares the request against
 * an INDEPENDENT read, which is the only thing that distinguishes "saved" from
 * "accepted and silently normalised to something else".
 *
 * Phone is compared with punctuation removed on both sides, because Shopify
 * legitimately rewrites "054-568-0665" to "+972545680665" and that is a
 * success, not a mismatch.
 */
export function verifyReadBack(
  patch: ProfilePatch,
  customer: Record<string, any> | null,
): ReadBackVerdict {
  const mismatches: ReadBackVerdict["mismatches"] = [];
  if (!customer) return { verified: false, mismatches: [{ field: "customer", requested: "read back", actual: null }] };

  for (const [field, requested] of Object.entries(patch.customer)) {
    const actual = customer[field] == null ? null : String(customer[field]);
    if (!matches(field, requested, actual)) mismatches.push({ field, requested, actual });
  }

  const addr = customer.default_address ?? null;
  for (const [field, requested] of Object.entries(patch.address)) {
    const actual = addr?.[field] == null ? null : String(addr[field]);
    if (!matches(field, requested, actual)) mismatches.push({ field: `address.${field}`, requested, actual });
  }
  return { verified: mismatches.length === 0, mismatches };
}

function matches(field: string, requested: string, actual: string | null): boolean {
  if (actual == null) return false;
  if (field === "phone") {
    const a = normalizePhone(actual).replace(/^\+/, "");
    const b = normalizePhone(requested).replace(/^\+/, "");
    // National vs international form of the same number: "0545680665" and
    // "+972545680665" differ in their first digits and agree in their last
    // nine, which is what the customer actually changed.
    return a === b || a.endsWith(b.slice(-9)) || b.endsWith(a.slice(-9));
  }
  return actual.trim().toLowerCase() === requested.trim().toLowerCase();
}

/**
 * Would this change collide with an existing customer record?
 *
 * Shopify enforces email uniqueness and will reject the write, but a rejection
 * arrives as an opaque 422 that the model then has to explain. Detecting it in
 * advance means the customer hears what is actually wrong - that the address is
 * already on another account - rather than "the update failed".
 */
export function detectDuplicate(
  patch: ProfilePatch,
  ownId: string,
  candidates: Array<Record<string, any>>,
): { conflict: false } | { conflict: true; field: "email" | "phone"; existingCustomerId: string } {
  for (const c of candidates ?? []) {
    if (c == null) continue;
    if (String(c.id) === String(ownId)) continue;
    if (patch.customer.email && String(c.email ?? "").toLowerCase() === patch.customer.email) {
      return { conflict: true, field: "email", existingCustomerId: String(c.id) };
    }
    if (patch.customer.phone) {
      const theirs = normalizePhone(String(c.phone ?? ""));
      const ours = normalizePhone(patch.customer.phone);
      if (theirs && ours && theirs.slice(-9) === ours.slice(-9)) {
        return { conflict: true, field: "phone", existingCustomerId: String(c.id) };
      }
    }
  }
  return { conflict: false };
}
