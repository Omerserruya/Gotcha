import type { CrmContext, CrmNote } from '@/api/contracts/customer-detail';
import type { Note } from '@/api/contracts/customer-notes';
import type { Money, OrderCard } from '@/api/contracts/customer-orders';
import type { WallConversation, WallHistory, WallMemory } from '@/features/inbox/wall/load-wall';
import type { OrdersView } from '@/features/inbox/wall/wall-model';

/**
 * The phone's customer screen, as rules apart from its markup: each section
 * is one of three things, and only a read that failed says it failed.
 *
 *   failed  the read did not come back - "couldn't load", this section only
 *   empty   it came back with nothing - a quiet line, never a zero
 *   ok      something to draw
 */
export type Section<T> =
  | { readonly state: 'failed' }
  | { readonly state: 'empty' }
  | { readonly state: 'ok'; readonly items: T };

const failed = { state: 'failed' } as const;
const empty = { state: 'empty' } as const;

/** One line of what GOTCHA remembers: a fact with its field, or a line of background. */
export interface MemoryLine {
  /** The field key (`business_type`); `null` for a line of imported background. */
  readonly key: string | null;
  readonly value: string;
}

export function memorySection(memory: WallMemory | null): Section<readonly MemoryLine[]> {
  if (memory === null) return failed;
  const lines: MemoryLine[] = [
    ...memory.facts.map((fact) => ({ key: fact.key, value: fact.value })),
    ...(memory.historical?.summary ? [{ key: null, value: memory.historical.summary }] : []),
    ...(memory.historical?.facts ?? []).map((value) => ({ key: null, value })),
  ];
  return lines.length === 0 ? empty : { state: 'ok', items: lines };
}

/**
 * The person's OTHER conversations, newest first as the route sends them. The
 * open one is left out: it is the screen this one came from.
 *
 * ★ No contact is not a failure: there is nobody to have had others.
 */
export function historySection(
  history: WallHistory | null,
  hasContact: boolean,
): Section<readonly WallConversation[]> {
  if (!hasContact) return empty;
  if (history === null) return failed;
  const others = history.conversations.filter((c) => !c.isCurrent);
  return others.length === 0 ? empty : { state: 'ok', items: others };
}

/** One order as the phone lists it. */
export interface OrderLine {
  readonly id: string;
  /** Without its "#": the copy adds one. */
  readonly number: string;
  readonly createdAt: string | null;
  readonly total: Money;
  /** The platform's own label, already in the reader's language; `null` for none. */
  readonly status: string | null;
  readonly cancelled: boolean;
}

/**
 * The orders, from the wall's own choice of source (`ordersView`). Both
 * sources missing is a failed read; a store that answered with none, or
 * nothing connected, is quiet; `unavailable` is the store failing to answer.
 */
export function ordersSection(
  view: OrdersView,
  read: { readonly byContact: boolean; readonly byConversation: boolean },
): Section<readonly OrderLine[]> {
  if (!read.byContact && !read.byConversation) return failed;
  if (view.state === 'unavailable') return failed;
  if (view.orders.length === 0) return empty;
  return { state: 'ok', items: view.orders.map(orderLine) };
}

export function orderLine(order: OrderCard): OrderLine {
  // The step the order is at, in the platform's words: a refund says more than "paid".
  const chip = order.refund ?? order.shipping ?? order.fulfillment ?? order.financial;
  return {
    id: order.orderId,
    number: order.orderNumber.replace(/^#/, ''),
    createdAt: order.createdAt,
    total: order.total,
    status: chip?.label.trim() || null,
    cancelled: order.cancelled,
  };
}

/** The team's notes still standing and published; a deleted or suggested one is not a note. */
export function notesSection(notes: readonly Note[] | null, hasContact: boolean): Section<readonly Note[]> {
  if (!hasContact) return empty;
  if (notes === null) return failed;
  const shown = notes.filter((n) => n.deletedAt === null && n.status === 'PUBLISHED');
  return shown.length === 0 ? empty : { state: 'ok', items: shown };
}

/** What the CRM holds about this person: its recent notes, tasks and calls. */
export function crmSection(crm: CrmContext | null): Section<readonly CrmNote[]> {
  if (crm === null) return failed;
  const shown = crm.recent_crm_notes.filter((n) => n.body.trim() !== '');
  return shown.length === 0 ? empty : { state: 'ok', items: shown };
}
