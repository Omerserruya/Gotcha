import { describe, expect, it } from 'vitest';

import { translate } from './events';

/**
 * The approval events, as the platform publishes them (ChatCenter
 * `services/`, 2026-11-03) and the bridge relays them: a socket receives the
 * bus event's `data`, plus the envelope's `tenantId` when `data` has none.
 */
describe('★★ approval:created - a request was written', () => {
  it('★ approval-requests.ts: the request is `id`', () => {
    expect(
      translate('approval:created', {
        id: 'a1',
        tenantId: 't1',
        conversationId: 'c1',
        tool: 'refund_order',
        summary: 'Refund ₪179',
        riskLevel: 'high',
        requestedBy: 'ai-bot',
        createdAt: '2026-11-03T09:00:00.000Z',
        expiresAt: '2026-11-04T09:00:00.000Z',
      }),
    ).toMatchObject({ type: 'approval.requested', tenantId: 't1', approvalId: 'a1' });
  });

  it('★★ no tenant, no event: unattributable is dropped', () => {
    expect(translate('approval:created', { id: 'a1' })).toBeNull();
    expect(translate('approval:created', { tenantId: 't1' })).toBeNull();
  });
});

describe('★★ approved, rejected, expired - a request left the queue', () => {
  it.each(['approval:approved', 'approval:rejected', 'approval:expired'])(
    '%s: `approvalId`',
    (wire) => {
      expect(
        translate(wire, { approvalId: 'a1', tenantId: 't1', conversationId: 'c1' }),
      ).toMatchObject({
        type: 'approval.resolved',
        tenantId: 't1',
        approvalId: 'a1',
      });
    },
  );

  it('★ the dotted name is ours, not the wire’s', () => {
    expect(translate('approval.requested', { id: 'a1', tenantId: 't1' })).toBeNull();
    expect(translate('approval:created_x', { id: 'a1', tenantId: 't1' })).toBeNull();
  });
});
