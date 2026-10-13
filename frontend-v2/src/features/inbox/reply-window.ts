import { isApiError } from '@/api/client/api-error';
import type { ReplyMode, ReplyTemplate } from '@/api/contracts/inbox';

/**
 * The customer-service window, as the composer acts on it (Backend 47e376a4).
 *
 * No directive: the send actions (server) and the composer (client) both use
 * it, and nothing here reaches a server.
 */

export type WindowRefusal = 'template_required' | 'window_closed';

/**
 * A send refused because the window closed while the page was open: 409 with
 * `code`. Any other 409, or one without a code, is not this.
 */
export function windowRefusalOf(cause: unknown): WindowRefusal | null {
  if (!isApiError(cause) || cause.status !== 409) return null;
  if (cause.code === 'TEMPLATE_REQUIRED') return 'template_required';
  if (cause.code === 'REPLY_WINDOW_CLOSED') return 'window_closed';
  return null;
}

export function modeOfRefusal(refusal: WindowRefusal): ReplyMode {
  return refusal === 'template_required' ? 'template_only' : 'closed';
}

/** "Closes in ..." is said only this close to the end. */
export const CLOSING_SOON_MS = 3 * 60 * 60 * 1000;

/**
 * How long until free text stops, when that is soon: whole hours from an hour
 * up, minutes under it. `null` when not soon, already past, or unknown.
 */
export function closingSoon(
  closesAt: string | null,
  nowMs: number,
): { readonly unit: 'hours' | 'minutes'; readonly count: number } | null {
  if (closesAt === null) return null;
  const end = Date.parse(closesAt);
  if (Number.isNaN(end)) return null;
  const left = end - nowMs;
  if (left <= 0 || left > CLOSING_SOON_MS) return null;
  const hours = Math.floor(left / (60 * 60 * 1000));
  if (hours >= 1) return { unit: 'hours', count: hours };
  return { unit: 'minutes', count: Math.max(1, Math.ceil(left / (60 * 1000))) };
}

/**
 * A variable's first value: the customer's name where the variable is a
 * name - its key or its sample says so ("name", "first_name", "שם"), or the
 * sample is itself one capitalised name ("Dana") - and
 * otherwise the template's own sample. The agent sees and edits every one
 * before Send; an empty one blocks Send.
 *
 * ★ A name that is really a phone number or a handle is not a name, so it is
 *   not used (an unnamed WhatsApp contact's `customerName` is often digits).
 */
export function prefillValue(
  placeholder: ReplyTemplate['placeholders'][number],
  customerName: string | null,
): string {
  const sample = placeholder.sample ?? '';
  const name = customerName?.trim() ?? '';
  // A name with no letter in it is a phone number or a handle.
  const usable = /\p{L}/u.test(name);
  const isName =
    /name|שם/iu.test(placeholder.key) ||
    /name|שם/iu.test(sample) ||
    // A proper name as the sample - "Dana" for `{{1}}` - is a name variable.
    /^\p{Lu}\p{Ll}+$/u.test(sample);
  if (usable && isName) {
    const first = /first|פרטי/iu.test(`${placeholder.key} ${sample}`);
    return first ? (name.split(/\s+/)[0] ?? name) : name;
  }
  return sample;
}
