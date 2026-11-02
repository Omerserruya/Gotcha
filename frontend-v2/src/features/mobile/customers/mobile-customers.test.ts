import { describe, expect, it } from 'vitest';

import { timelineEventSchema } from '@/api/contracts/customer-detail';

import { recentConversations } from './mobile-customers';

const event = (over: Record<string, unknown>) =>
  timelineEventSchema.parse({
    type: 'message',
    conversationId: 'c1',
    createdAt: '2026-11-01T10:00:00.000Z',
    ...over,
  });

describe('★★ a customer’s conversations, one row each, newest first', () => {
  const events = [
    event({
      conversationId: 'old',
      channel: 'EMAIL',
      direction: 'INBOUND',
      body: 'Hello',
      createdAt: '2026-10-01T09:00:00.000Z',
    }),
    event({
      conversationId: 'new',
      channel: 'WHATSAPP',
      direction: 'INBOUND',
      body: 'Where   is\nmy order?',
      createdAt: '2026-11-01T09:00:00.000Z',
    }),
    event({
      conversationId: 'new',
      channel: 'WHATSAPP',
      direction: 'OUTBOUND',
      body: 'On its way',
      createdAt: '2026-11-01T09:05:00.000Z',
    }),
    event({
      type: 'handover',
      conversationId: 'handover-only',
      createdAt: '2026-11-02T09:00:00.000Z',
      handover: { to: 'Dana' },
    }),
  ];

  it('grouped by conversation, sorted by the latest moment in each', () => {
    const rows = recentConversations(events, 10);
    expect(rows.map((r) => r.id)).toEqual(['new', 'old']);
    expect(rows[0]).toEqual({
      id: 'new',
      at: '2026-11-01T09:05:00.000Z',
      channel: 'WHATSAPP',
      said: 'Where is my order?',
      count: 2,
    });
  });

  it('★ the customer’s own words first; anyone’s when they wrote none; none is null', () => {
    const ours = recentConversations(
      [event({ direction: 'OUTBOUND', body: 'We wrote first' })],
      10,
    );
    expect(ours[0]!.said).toBe('We wrote first');
    expect(recentConversations([event({ body: '  ' })], 10)[0]!.said).toBeNull();
  });

  it('a handover alone is not a conversation row; the limit cuts the oldest', () => {
    expect(recentConversations(events, 1).map((r) => r.id)).toEqual(['new']);
    expect(recentConversations([], 5)).toEqual([]);
  });
});
