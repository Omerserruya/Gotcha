import { describe, expect, it } from 'vitest';

import {
  approvalSummary,
  describeApprovalAction,
  aiEmployeeIdOf,
  approvalSchema,
  decisionStance,
  hasLapsed,
  isDecidable,
  isFlaggedIrreversible,
  isOutcomeUnknown,
  isRetryable,
  type Approval,
} from './approvals';

/**
 * The rulings on screen 03, as assertions.
 *
 * Every one of these is a decision that outlives whoever made it, and the only
 * thing that makes a ruling survive is something failing when it is undone.
 */

const NOW = new Date('2026-09-19T10:00:00.000Z');
const IN_AN_HOUR = '2026-09-19T11:00:00.000Z';
const AN_HOUR_AGO = '2026-09-19T09:00:00.000Z';

const approval = (over: Partial<Approval> = {}): Approval => ({
  id: 'a1',
  conversationId: 'c1',
  contactId: 'k1',
  tool: 'issue_refund',
  summary: 'Refund ₪179 for order #1842',
  reason: 'Customer reported the item arrived damaged',
  policyRuleName: 'Refunds over ₪100',
  riskLevel: 'medium',
  riskTags: [],
  status: 'PENDING',
  requestedBy: 'bot',
  requestedByName: null,
  decidedByName: null,
  decisionChannel: null,
  decidedAt: null,
  decisionReason: null,
  expiresAt: IN_AN_HOUR,
  createdAt: AN_HOUR_AGO,
  executionState: 'NOT_STARTED',
  executionError: null,
  executionAttempts: 0,
  customerNotifiedAt: null,
  ...over,
});

describe('the contract strips what no screen needs', () => {
  it('drops params, modifiedParams, resumeEnvelope and executionResult', () => {
    // The list route spreads the raw Prisma row for up to 100 rows, so all
    // four cross the wire today. `resumeEnvelope` is the full stored
    // ExecutionRequest. `object` rather than `looseObject` is what stops them.
    const parsed = approvalSchema.parse({
      ...approval(),
      params: { card: '4111111111111111', amount: 179 },
      modifiedParams: { amount: 150 },
      resumeEnvelope: { tool: 'issue_refund', credentials: 'secret' },
      executionResult: { providerRef: 're_123' },
      tenantId: 't1',
    });

    for (const key of ['params', 'modifiedParams', 'resumeEnvelope', 'executionResult', 'tenantId'])
      expect(parsed, `${key} must not survive the contract`).not.toHaveProperty(key);
  });

  it('keeps summary, which is where the amount on screen comes from', () => {
    // Never parsed out of `params`: that blob is whatever the planning step
    // wanted to pass, different per tool and guaranteed by nothing.
    expect(approvalSchema.parse(approval()).summary).toBe('Refund ₪179 for order #1842');
  });
});

describe('hasLapsed — computed from expiresAt, never read from status', () => {
  it('is true for a PENDING row past its deadline', () => {
    expect(hasLapsed(approval({ expiresAt: AN_HOUR_AGO }), NOW)).toBe(true);
  });

  it('is true at the exact moment the deadline passes', () => {
    // The countdown reaches 0m while `status` is still PENDING every single
    // time, by construction — the sweeper runs on a five-minute cron.
    expect(hasLapsed(approval({ expiresAt: NOW.toISOString() }), NOW)).toBe(true);
  });

  it('is false while there is time left', () => {
    expect(hasLapsed(approval(), NOW)).toBe(false);
  });

  it('does not re-lapse a row that was already decided', () => {
    // An approval granted an hour before its deadline is approved, not lapsed.
    expect(hasLapsed(approval({ status: 'APPROVED', expiresAt: AN_HOUR_AGO }), NOW)).toBe(false);
  });

  it('treats an unparseable deadline as not lapsed rather than guessing', () => {
    expect(hasLapsed(approval({ expiresAt: 'whenever' }), NOW)).toBe(false);
  });
});

describe('isDecidable — no button for a decision the route will refuse', () => {
  it('offers a decision only while one can be taken', () => {
    expect(isDecidable(approval(), NOW)).toBe(true);
  });

  it('refuses on a lapsed row, which the route answers 409 for', () => {
    expect(isDecidable(approval({ expiresAt: AN_HOUR_AGO }), NOW)).toBe(false);
  });

  it('refuses on every already-decided row', () => {
    for (const status of ['APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED'] as const) {
      expect(isDecidable(approval({ status }), NOW), status).toBe(false);
    }
  });
});

describe('decisionStance', () => {
  it('reads a swept row and an unswept one as the same thing', () => {
    // The sweeper flips PENDING to EXPIRED within five minutes. Before and
    // after that flip the row means the same thing to a person, so it must
    // read the same on screen.
    expect(decisionStance(approval({ expiresAt: AN_HOUR_AGO }), NOW)).toBe('lapsed');
    expect(decisionStance(approval({ status: 'EXPIRED' }), NOW)).toBe('lapsed');
  });

  it('separates the three ways a row stops being pending', () => {
    expect(decisionStance(approval({ status: 'APPROVED' }), NOW)).toBe('approved');
    expect(decisionStance(approval({ status: 'REJECTED' }), NOW)).toBe('rejected');
    expect(decisionStance(approval({ status: 'CANCELLED' }), NOW)).toBe('cancelled');
  });
});

describe('the two axes are never collapsed', () => {
  it('an APPROVED row whose dispatch failed is not a success', () => {
    // This is the case the whole screen exists for: without the second axis,
    // a failed dispatch is indistinguishable from a completed one and the
    // customer is never told anything.
    const failed = approval({ status: 'APPROVED', executionState: 'FAILED' });
    expect(decisionStance(failed, NOW)).toBe('approved');
    expect(isRetryable(failed)).toBe(true);
  });

  it('retries only a dispatch that ran and failed', () => {
    expect(isRetryable(approval({ status: 'APPROVED', executionState: 'SUCCEEDED' }))).toBe(false);
    expect(isRetryable(approval({ status: 'APPROVED', executionState: 'EXECUTING' }))).toBe(false);
    expect(isRetryable(approval({ status: 'REJECTED', executionState: 'FAILED' }))).toBe(false);
  });

  it('never retries a LEGACY_UNVERIFIED row', () => {
    // Its own comment: many provably never ran, so retrying is a coin flip
    // between re-running an old refund and doing nothing. Terminal by design.
    const legacy = approval({ status: 'APPROVED', executionState: 'LEGACY_UNVERIFIED' });
    expect(isRetryable(legacy)).toBe(false);
    expect(isOutcomeUnknown(legacy)).toBe(true);
  });

  it('does not let an unverified row read as succeeded', () => {
    expect(isOutcomeUnknown(approval({ executionState: 'SUCCEEDED' }))).toBe(false);
  });
});

describe('IRREVERSIBLE is a label, not a window', () => {
  it('reports the tag as the tag', () => {
    expect(isFlaggedIrreversible(approval({ riskTags: ['HIGH', 'IRREVERSIBLE'] }))).toBe(true);
    expect(isFlaggedIrreversible(approval({ riskTags: ['FINANCIAL'] }))).toBe(false);
  });

  it('exposes nothing that could be rendered as a reversal window', () => {
    // There is no undo in this platform — no route, no gateway path, no
    // `undoneAt` or `reversalOf` field, enumerated across the repository. A
    // function returning a duration here is how "Reversible · within 24h"
    // gets back onto the screen.
    const surface = Object.keys(approvalSchema.parse(approval({ riskTags: ['IRREVERSIBLE'] })));
    expect(surface.filter((k) => /revers|undo|window/i.test(k))).toEqual([]);
  });
});

describe('aiEmployeeIdOf — a machine identifier must not reach a person', () => {
  it('extracts the employee id the list route refuses to resolve', () => {
    expect(aiEmployeeIdOf(approval({ requestedBy: 'ai-agent:clx123' }))).toBe('clx123');
  });

  it('is null for the other two shapes, which name no employee', () => {
    expect(aiEmployeeIdOf(approval({ requestedBy: 'bot' }))).toBeNull();
    expect(aiEmployeeIdOf(approval({ requestedBy: 'flow:abc' }))).toBeNull();
  });

  it('is null rather than empty for a malformed prefix', () => {
    expect(aiEmployeeIdOf(approval({ requestedBy: 'ai-agent:' }))).toBeNull();
  });
});

describe('★★ approvalSummary — a sentence from the record, for rows that stored a breadcrumb', () => {
  // The platform's own cases (packages/shared/src/lib/__tests__/approval-summary.test.ts).
  it('names the act, for the tools that actually reach approval', () => {
    expect(
      describeApprovalAction('shopify.cancel_order', { order_name: '#1006', reason: 'customer' }),
    ).toBe('Cancel order #1006');
    expect(describeApprovalAction('shopify.resend_confirmation', { order_name: '#1006' })).toBe(
      'Resend confirmation for order #1006',
    );
    expect(
      describeApprovalAction('create_task', { subject: 'Follow up with Dana', contact_id: 'c1' }),
    ).toBe('Create task: Follow up with Dana');
  });

  it('drops the provider', () => {
    expect(describeApprovalAction('integration_cancel_order', { order_name: '#77' })).toBe(
      'Cancel order #77',
    );
    expect(describeApprovalAction('integration.hubspot.create_deal', { name: 'Acme' })).toBe(
      'Create deal: Acme',
    );
  });

  it('⚠⚠ carries the refund amount and INVENTS NO CURRENCY', () => {
    const s = describeApprovalAction('shopify.process_refund', {
      amount: 179,
      order_name: '#1006',
      notify: true,
    });
    expect(s).toBe('Process refund of 179 for order #1006');
    expect(s).not.toMatch(/[₪$€£]/);
  });

  it('★★ replaces the breadcrumb, the signature and the bare tool name — and nothing else', () => {
    const row = (summary: string) => ({
      summary,
      tool: 'shopify.cancel_order',
      params: { order_name: '#9' },
    });
    expect(approvalSummary(row('ai-bot inbox tool call'))).toBe('Cancel order #9');
    expect(approvalSummary(row('issue_refund()'))).toBe('Cancel order #9');
    expect(approvalSummary(row('shopify.cancel_order'))).toBe('Cancel order #9');
    // A sentence somebody wrote is kept as written.
    expect(approvalSummary(row('Cancel order #1006 and refund 89.50'))).toBe(
      'Cancel order #1006 and refund 89.50',
    );
  });
});
