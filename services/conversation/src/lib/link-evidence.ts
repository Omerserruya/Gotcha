/**
 * Why two customers are suggested (or were linked) as one person, in a shape a
 * screen can show next to the pair. Read-time only: it is derived from the
 * link record and the two contacts, never stored.
 *
 * A matched phone or email is masked. The reviewer needs enough to recognise
 * it, not the value itself, which stays on the customer's own card.
 */

export type LinkEvidence =
  | { type: "name"; names: [string | null, string | null] }
  | { type: "phone" | "email"; value: string }
  | { type: "shopify_customer"; shopifyCustomerId: string; provenBy: "verified_profile_update" };

/** +972 5X-XXX-3421 for an Israeli number, else the last four digits only. */
export function maskPhoneEvidence(raw: string): string {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length < 7) return "XXX";
  const last4 = digits.slice(-4);
  const national = digits.startsWith("972") ? digits.slice(3) : digits.startsWith("0") ? digits.slice(1) : null;
  if (national && national.length >= 8 && national.length <= 9) {
    const prefix = digits.startsWith("972") ? "+972 " : "0";
    return `${prefix}${national[0]}X-XXX-${last4}`;
  }
  return `XXX-${last4}`;
}

/** o***@gmail.com: the first letter of the local part and the whole domain. */
export function maskEmailEvidence(raw: string): string {
  const e = String(raw ?? "").trim();
  const at = e.lastIndexOf("@");
  if (at <= 0) return "***";
  return `${e[0]}***${e.slice(at).toLowerCase()}`;
}

interface EvidenceInput {
  signal: string;
  /** accepted_suggestion: the suggestion's own signal. */
  fromSignal?: string | null;
  identifier?: { type?: string; value?: string } | null;
}

/** The evidence for one pair, or null when the record holds none. */
export function evidenceFor(
  rec: EvidenceInput,
  contacts: [{ displayName: string | null }, { displayName: string | null }],
): LinkEvidence | null {
  const signal = rec.signal === "accepted_suggestion" && rec.fromSignal ? rec.fromSignal : rec.signal;
  if (signal === "same_name" || signal === "similar_name") {
    return { type: "name", names: [contacts[0].displayName ?? null, contacts[1].displayName ?? null] };
  }
  const id = rec.identifier;
  if (!id?.value) return null;
  const kind = String(id.type ?? "").toLowerCase();
  if (kind === "phone") return { type: "phone", value: maskPhoneEvidence(id.value) };
  if (kind === "email") return { type: "email", value: maskEmailEvidence(id.value) };
  if (kind === "shopify_customer") {
    // The only writer is a successful, ownership-checked update_my_profile
    // (ai customer-access-guard rememberShopifyCustomer): no order is involved.
    return { type: "shopify_customer", shopifyCustomerId: id.value, provenBy: "verified_profile_update" };
  }
  return null;
}
