import { describe, expect, it } from 'vitest';

import type { Note } from '@/api/contracts/customer-notes';
import { orderCardSchema } from '@/api/contracts/customer-orders';
import type { WallConversation } from '@/features/inbox/wall/load-wall';
import type { OrdersView } from '@/features/inbox/wall/wall-model';

import {
  crmSection,
  historySection,
  memorySection,
  notesSection,
  orderLine,
  ordersSection,
} from './customer-info';

const conv = (id: string, isCurrent = false): WallConversation => ({
  id,
  channel: 'WHATSAPP',
  status: 'CLOSED',
  startedAt: null,
  lastAt: '2026-10-01T10:00:00Z',
  messages: 3,
  summary: null,
  isCurrent,
});
const order = (o: Record<string, unknown> = {}) =>
  orderCardSchema.parse({ orderId: 'o1', orderNumber: '#1842', ...o });
const view = (orders: OrdersView['orders'], state: OrdersView['state'] = 'ok'): OrdersView => ({
  source: 'shopify',
  state,
  reason: null,
  missing: [],
  orders,
});
const note = (o: Partial<Note> = {}) =>
  ({ id: 'n1', body: 'VIP', status: 'PUBLISHED', deletedAt: null, ...o }) as Note;

describe("the phone's customer sections", () => {
  it('★ a failed read is "failed" for its own section; read and empty is "empty"', () => {
    expect(memorySection(null)).toEqual({ state: 'failed' });
    expect(memorySection({ facts: [], historical: null })).toEqual({ state: 'empty' });
    expect(crmSection(null)).toEqual({ state: 'failed' });
    expect(crmSection({ recent_crm_notes: [], link_meta: null })).toEqual({ state: 'empty' });
  });

  it('memory lists the facts, then the imported background', () => {
    const section = memorySection({
      facts: [{ key: 'business_type', value: 'bakery', source: 'conversation' }],
      historical: { summary: 'Ordered twice', facts: ['Prefers mornings'] },
    });
    expect(section).toEqual({
      state: 'ok',
      items: [
        { key: 'business_type', value: 'bakery' },
        { key: null, value: 'Ordered twice' },
        { key: null, value: 'Prefers mornings' },
      ],
    });
  });

  it('★ previous conversations leave out the one open, and no contact is quiet, not failed', () => {
    const history = { total: 2, hasMore: false, conversations: [conv('now', true), conv('before')] };
    expect(historySection(history, true)).toEqual({ state: 'ok', items: [conv('before')] });
    expect(historySection({ ...history, conversations: [conv('now', true)] }, true)).toEqual({ state: 'empty' });
    expect(historySection(null, true)).toEqual({ state: 'failed' });
    expect(historySection(null, false)).toEqual({ state: 'empty' });
  });

  it('★ orders: both sources unread is failed, a store that could not answer is failed, none is quiet', () => {
    const read = { byContact: true, byConversation: false };
    expect(ordersSection(view([]), { byContact: false, byConversation: false })).toEqual({ state: 'failed' });
    expect(ordersSection(view([], 'unavailable'), read)).toEqual({ state: 'failed' });
    expect(ordersSection(view([], 'no_orders'), read)).toEqual({ state: 'empty' });
    expect(ordersSection(view([], 'not_connected'), read)).toEqual({ state: 'empty' });
    const ok = ordersSection(view([order()]), read);
    expect(ok.state).toBe('ok');
  });

  it('an order line: the number without "#", the total, the platform\'s own status word', () => {
    const line = orderLine(
      order({
        createdAt: '2026-10-02T00:00:00Z',
        total: { amount: '120.50', currency: 'ILS' },
        financial: { key: 'paid', label: 'שולם', tone: 'positive' },
        fulfillment: { key: 'fulfilled', label: 'נשלח', tone: 'positive' },
      }),
    );
    expect(line).toEqual({
      id: 'o1',
      number: '1842',
      createdAt: '2026-10-02T00:00:00Z',
      total: { amount: 120.5, currency: 'ILS' },
      status: 'נשלח',
      cancelled: false,
    });
    expect(orderLine(order()).status).toBeNull();
  });

  it('notes: only published ones still standing; no contact is quiet', () => {
    const shown = notesSection(
      [note(), note({ id: 'gone', deletedAt: '2026-10-01' }), note({ id: 'ai', status: 'AI_SUGGESTED' })],
      true,
    );
    expect(shown).toEqual({ state: 'ok', items: [note()] });
    expect(notesSection(null, true)).toEqual({ state: 'failed' });
    expect(notesSection(null, false)).toEqual({ state: 'empty' });
  });
});
