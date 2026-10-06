import type { CommerceSummary, Insight, Mood } from '@/api/contracts/customer-facts';

import type { CommerceFacts } from './load-customer-facts';
import type { PersonToday } from './people-today';

/**
 * 04's right-hand column, as two lines: what they are worth over how many
 * orders. Pure, so every "-" is tested for the reason it carries.
 *
 * ★ Four nothings, never one:
 *   unread       the commerce read failed            "-", why in the title
 *   no store     `source: null` + a reason           "-", the reason
 *   no orders    the store was read, none matched     "-" over "no orders yet"
 *   capped       none matched in a CAPPED read        "-", not "no orders yet":
 *                an older order could be past the cap, and "no orders yet"
 *                would be a claim about the customer we did not check.
 */
export type ValueCell =
  | {
      readonly kind: 'amount';
      readonly amount: number;
      readonly currency: string;
      readonly orders: number;
    }
  /** Mixed currencies: the route withholds the sum (sends 0), so no number is said. */
  | { readonly kind: 'mixed'; readonly orders: number }
  | { readonly kind: 'none' }
  | { readonly kind: 'unknown'; readonly why: Reason | 'capped' };

/**
 * One phone matches the same orders on every identity that carries it, so a
 * person's identities are never summed: the one with the most orders speaks.
 */
export function summaryOf(
  person: Pick<PersonToday, 'members'>,
  byId: ReadonlyMap<string, CommerceSummary>,
): CommerceSummary | null {
  let best: CommerceSummary | null = null;
  for (const member of person.members) {
    const summary = byId.get(member.id);
    if (summary && (!best || summary.orderCount > best.orderCount)) best = summary;
  }
  return best;
}

/** The reasons there are sentences for; one the server adds later reads as "couldn't be read". */
const REASONS = ['no_store_connected', 'store_unreachable', 'provider_not_supported'] as const;
export type Reason = (typeof REASONS)[number] | 'unread';
export function reasonKey(reason: string | null | undefined): Reason {
  return (REASONS as readonly string[]).includes(reason ?? '') ? (reason as Reason) : 'unread';
}

export function valueCell(
  person: Pick<PersonToday, 'members'>,
  commerce: CommerceFacts | null,
): ValueCell {
  if (commerce === null) return { kind: 'unknown', why: 'unread' };
  if (commerce.state === 'none') return { kind: 'unknown', why: reasonKey(commerce.reason) };
  const summary = summaryOf(person, commerce.byId);
  if (!summary) return { kind: 'unknown', why: 'unread' };
  if (summary.orderCount === 0) {
    return commerce.truncated ? { kind: 'unknown', why: 'capped' } : { kind: 'none' };
  }
  if (summary.currency === null) return { kind: 'mixed', orders: summary.orderCount };
  return {
    kind: 'amount',
    amount: summary.lifetimeValue,
    currency: summary.currency,
    orders: summary.orderCount,
  };
}

/** "₪2,140" - or the bare number when the store named no currency we can print. */
export function money(amount: number, currency: string, locale: string): string {
  if (currency) {
    try {
      return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency,
        maximumFractionDigits: 0,
      }).format(amount);
    } catch {
      // Not an ISO code: the number, without a symbol we would be guessing.
    }
  }
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(amount);
}

/** The person's open conversation, as the insights read it: the primary first. */
export function insightOf(
  person: Pick<PersonToday, 'primary' | 'members'>,
  insights: ReadonlyMap<string, Insight | null> | null,
): Insight | null {
  if (!insights) return null;
  const own = insights.get(person.primary.id);
  if (own) return own;
  for (const member of person.members) {
    const found = insights.get(member.id);
    if (found) return found;
  }
  return null;
}

/** Line 2: the situation, and "wrote N times" from two on. `null`: the last message, as before. */
export function situationLine(
  insight: Insight | null,
): { readonly situation: string; readonly wrote: number | null } | null {
  const situation = insight?.situation?.trim();
  if (!insight || !situation) return null;
  return { situation, wrote: insight.inboundCount >= 2 ? insight.inboundCount : null };
}

/** The chip: a mood when there is one, else "waiting on you", else their first tag. */
export function chipOf(
  person: Pick<PersonToday, 'waiting' | 'primary'>,
  insight: Insight | null,
):
  | { readonly kind: Mood }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'tag'; readonly tag: string }
  | null {
  if (insight?.mood) return { kind: insight.mood };
  if (person.waiting) return { kind: 'waiting' };
  const tag = person.primary.tags[0];
  return tag ? { kind: 'tag', tag } : null;
}
