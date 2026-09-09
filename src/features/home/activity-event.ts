import type { ActivityEvent } from '@/api/contracts/analytics';

/**
 * Choosing the message and the blanks for one activity event.
 *
 * Pure and separate from the card, because this is where a line can quietly go
 * wrong — an unmapped tool filed under a familiar heading, or a missing value
 * leaving a dangling preposition.
 */

/**
 * The literal an absent value is passed as.
 *
 * The messages `select` on it and drop the whole clause, so "Refunded ₪179"
 * never becomes "Refunded ₪179 to ". Not an empty string: ICU `select` needs a
 * matchable token.
 */
export const ABSENT = 'none';

/** The nouns with their own wording. Anything else uses the fallback. */
const KNOWN_NOUNS = new Set([
  'contact',
  'customer',
  'deal',
  'discount',
  'invoice',
  'lead',
  'lead_convert',
  'order_cancel',
  'order_edit',
  'order_exchange',
  'order_lookup',
  'order_note',
  'payment_link',
  'refund',
  'refund_check',
  'return',
  'return_check',
  'tag',
  'tracking',
]);

export interface EventMessage {
  /** Key under `home.working`. */
  readonly key: string;
  readonly values: Record<string, string>;
}

export function eventMessage(event: ActivityEvent): EventMessage {
  const [noun, outcome] = splitKind(event.kind);
  const values: Record<string, string> = {
    customer: text(event.values.customerName ?? event.values.customer),
    subject: event.subject.id ? `#${event.subject.id}` : ABSENT,
  };

  if (KNOWN_NOUNS.has(noun)) return { key: `event.${noun}.${outcome}`, values };

  // Unmapped: the backend sends the tool's own slug rather than guessing, and
  // showing it is more honest than filing it under a familiar heading.
  return {
    key: `event.fallback.${outcome}`,
    values: { ...values, action: noun.replace(/_/g, ' ') },
  };
}

/**
 * `refund.completed` → `['refund', 'completed']`.
 *
 * Split on the LAST dot: an unmapped tool slug can itself contain one, and
 * splitting on the first would file `foo.bar.completed` under the noun `foo`
 * with the outcome `bar` — a key that does not exist.
 */
export function splitKind(kind: string): [string, string] {
  const at = kind.lastIndexOf('.');
  if (at < 0) return [kind, 'completed'];
  return [kind.slice(0, at), kind.slice(at + 1)];
}

function text(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : ABSENT;
}
