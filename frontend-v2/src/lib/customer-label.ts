/**
 * ★★ WHO A CONVERSATION IS WITH, AS ONE CHAIN FOR EVERY SURFACE.
 *
 * Prod, 2026-11-17: about 2,676 conversations have no `customerName` (mostly
 * ones the business started from its phone, and imports). The list and the
 * phone header said "Someone" on every one of them, while the alerts already
 * fell back to the handle. Two surfaces, two answers about the same person.
 *
 * The chain: the stored name → the handle the conversation arrived on, read
 * as a person reads it → nothing (the caller says "Someone" only then).
 *
 * ⚠ The list row carries `contactId` only, not a contact's name, so there is
 *   no "linked person" step yet. When the route sends one, it goes between
 *   the two.
 */

/** Channels whose handle is a phone number. Any other handle is shown as it came. */
const PHONE_CHANNELS = new Set(['WHATSAPP', 'VOICE', 'SMS']);

const PHONE = /^\+?\d{8,15}$/;

function isPhoneChannel(channel: string | null | undefined): boolean {
  return !!channel && PHONE_CHANNELS.has(channel.toUpperCase());
}

/**
 * A phone handle as an Israeli reads it: `972521234567` → `052-123-4567`,
 * `97231234567` → `03-123-4567`. Any other country: `+` and the digits as one
 * run, because without that country's plan a grouping is a guess.
 * Not a phone (or not a phone channel): returned as it came.
 */
export function phoneForReading(channel: string | null | undefined, handle: string): string {
  const value = handle.trim();
  if (!isPhoneChannel(channel) || !PHONE.test(value)) return value;
  // An Israeli number stored the local way, "0521234567", is the same number.
  const digits = value.replace(/^\+/, '').replace(/^0(?=\d{8,9}$)/, '972');
  const mobile = /^972(\d{2})(\d{3})(\d{4})$/.exec(digits);
  if (mobile) return `0${mobile[1]}-${mobile[2]}-${mobile[3]}`;
  const landline = /^972(\d)(\d{3})(\d{4})$/.exec(digits);
  if (landline) return `0${landline[1]}-${landline[2]}-${landline[3]}`;
  return `+${digits}`;
}

export type CustomerLabel =
  /** A stored name: the customer's own text (or a stored shopper, which PersonName words). */
  | { readonly kind: 'name'; readonly name: string }
  /** No name: the handle, formatted. Always left to right. */
  | { readonly kind: 'handle'; readonly handle: string };

interface Labelled {
  readonly customerName?: string | null;
  readonly customerExternalId?: string | null;
  readonly channel?: string | null;
}

/** The label to show, or `null` when there is neither a name nor a handle. */
export function customerLabel(row: Labelled): CustomerLabel | null {
  const name = row.customerName?.trim();
  /*
   * An unnamed WhatsApp contact's stored name is often just its digits: that
   * is a handle, and reads as one.
   */
  if (name && !(isPhoneChannel(row.channel) && PHONE.test(name))) {
    return { kind: 'name', name };
  }
  const handle = row.customerExternalId?.trim() || name;
  return handle ? { kind: 'handle', handle: phoneForReading(row.channel, handle) } : null;
}

/** The same as one string, for a title or a notification. `null`: say "Someone". */
export function customerLabelText(row: Labelled): string | null {
  const label = customerLabel(row);
  if (label === null) return null;
  return label.kind === 'name' ? label.name : label.handle;
}
