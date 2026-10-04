import { readFileSync } from 'node:fs';

import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { approvalSchema, type Approval } from '@/api/contracts/approvals';
import messages from '@/i18n/messages/en/approvals.json';

import { decisionStats } from './load-approvals';
import { DecisionStats, NothingWaiting } from './NothingWaiting';

/**
 * What you decided — screen 03's other list, and the state this tenant is in.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THIS FILE DID NOT EXIST, AND IT IS THE ONLY LIST DEV CAN SHOW
 * ════════════════════════════════════════════════════════════════════════════
 * The pending queue is empty on the demo tenant, so every walk of Approvals has
 * been photographing THIS list — twenty-nine rows of decided history — while the
 * grouping and paging arguments were all about the queue nobody can see.
 *
 * A walk read the rows as *"Approved by someone at 12:43 AM"*, cycling through
 * morning and afternoon across what must be several days, with no date anywhere.
 * Two mutations of the fix survived the whole suite, because nothing tested this
 * component at all.
 */

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'approvals') =>
    createTranslator({ locale: 'en', messages: { approvals: messages }, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'UTC' }),
}));

const approval = (over: Record<string, unknown> = {}): Approval =>
  approvalSchema.parse({
    id: 'a1',
    tool: 'issue_refund',
    summary: 'Refund 179 for order 1842',
    status: 'APPROVED',
    decidedByName: 'Dana',
    decidedAt: '2026-09-15T12:43:00.000Z',
    expiresAt: '2026-09-15T13:00:00.000Z',
    createdAt: '2026-09-15T12:00:00.000Z',
    ...over,
  });

const NOW = new Date('2026-09-20T09:00:00.000Z');
const show = async (decided: readonly Approval[] | null, mayBeIncomplete = false) =>
  render(await NothingWaiting({ decided, mayBeIncomplete, requesterNames: {}, now: NOW }));

describe('★★ a decision carries the day it was made, not just the time', () => {
  it('★★ an earlier day shows its DATE — a time alone was the same on every day', async () => {
    /*
     * A list spanning several days with times only cannot be read at all: "12:43
     * AM" was the same string on every one of those days. 02's column is a time
     * because its list is today's; ours shows a date for anything earlier.
     */
    await show([approval()]);
    expect(screen.getByTestId('when-a1')).toHaveTextContent('Sep 15');
  });

  it('★ today shows the time, as 02’s column does', async () => {
    await show([approval({ decidedAt: '2026-09-20T07:41:00.000Z' })]);
    expect(screen.getByTestId('when-a1')).toHaveTextContent('07:41');
  });

  it('★★ claims no time it does not have — no year, no clock, not the epoch', async () => {
    /*
     * `decidedAt` is nullable on the contract, so this is a real row. Mutations
     * have produced both "at " with a hole and "Jan 1, 1970" from `new
     * Date(null)`; the property that must hold is that the row claims no time.
     */
    await show([approval({ decidedAt: null, decidedByName: null })]);
    const row = screen.getByTestId('decided-a1');
    expect(row.textContent).not.toMatch(/\b(19|20)\d{2}\b/);
    expect(row.textContent).not.toMatch(/\d{1,2}:\d{2}/);
    expect(screen.queryByTestId('when-a1')).toBeNull();
  });
});

describe('★★ how it ended, in one word — and never "someone"', () => {
  it('★ approved, with who decided as its tooltip', async () => {
    await show([approval()]);
    const status = screen.getByText('Approved');
    expect(status).toHaveAttribute('title', 'Decided by Dana');
  });

  it('★ "someone" where the platform holds no name — true for dev’s fixture-labelled rows', async () => {
    // 26 of dev's 29 decided rows carry `dev-e2e` / `qa-manager`, not user ids.
    await show([approval({ decidedByName: null })]);
    expect(screen.getByText('Approved')).toHaveAttribute('title', 'Decided by someone');
  });

  it('★ and where it was decided — a manager’s WhatsApp reply says so', async () => {
    await show([approval({ decisionChannel: 'whatsapp' })]);
    expect(screen.getByText('Approved')).toHaveAttribute('title', 'Decided by Dana via WhatsApp');
  });

  it('★★ a stored breadcrumb is replaced by the sentence its own record gives', async () => {
    await show([
      approval({
        summary: 'ai-bot inbox tool call',
        tool: 'shopify.cancel_order',
        params: { order_name: '#4812' },
      }),
    ]);
    // 02's sentence: what was done, from the record's own facts.
    expect(screen.getByTestId('decided-a1')).toHaveTextContent('Cancelled order #4812');
    expect(screen.getByTestId('decided-a1').textContent).not.toMatch(/tool call/);
  });

  it('★ a rejection shows its reason in the status, as 02’s "Rejected · outside policy"', async () => {
    await show([approval({ id: 'a2', status: 'REJECTED', decisionReason: 'outside policy' })]);
    expect(screen.getByTestId('reason-a2')).toHaveTextContent('Rejected · outside policy');
  });

  it('★★ approved and then it did not run — the ending 02’s tidy column cannot show', async () => {
    await show([approval({ executionState: 'FAILED' })]);
    const failed = screen.getByTestId('failed-a1');
    expect(failed).toHaveTextContent(/didn’t run/);
    expect(failed.getAttribute('title')).toMatch(/didn't run/);
  });
});

describe('★★ the three states of the decided list', () => {
  it('★★ a failed read is not an empty history', async () => {
    /*
     * The house rule on the screen where it matters most: "we could not read your
     * past decisions" and "you have not decided anything" are opposite facts about
     * somebody's own record.
     */
    await show(null);
    expect(screen.getByTestId('decided-unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('decided-empty')).toBeNull();
  });

  it('an empty history says so', async () => {
    await show([]);
    expect(screen.getByTestId('decided-empty')).toBeInTheDocument();
  });

  it('★★ says the list may be cut, when the route says it may be', async () => {
    // `take: 100` per kind. A list that is silently partial is a record somebody
    // will trust as complete.
    await show([approval()], true);
    expect(screen.getByTestId('decided-foot')).toHaveTextContent(/most recent decisions/i);
  });

  it('★ the head counts today’s decisions — 02’s "7 today", with no 24h (Undo is gone)', async () => {
    await show([approval()], true);
    // None today: what is shown, not "0 today" over a list from August.
    expect(screen.getByTestId('decided-today')).toHaveTextContent('1 decision');
    expect(screen.getByTestId('nothing-waiting')).not.toHaveTextContent(/reversible|Undo/i);
  });
});

describe('★★ 02’s header figures — only when they can be stood behind', () => {
  it('★ approved this week, and the mean time from asking to deciding', async () => {
    const stats = decisionStats(
      [
        approval({
          id: 'a',
          decidedAt: '2026-09-19T10:00:16.000Z',
          createdAt: '2026-09-19T10:00:00.000Z',
        }),
        approval({
          id: 'b',
          status: 'REJECTED',
          decidedAt: '2026-09-19T11:00:16.000Z',
          createdAt: '2026-09-19T11:00:00.000Z',
        }),
        // Eight days ago: not this week.
        approval({
          id: 'c',
          decidedAt: '2026-09-12T10:00:00.000Z',
          createdAt: '2026-09-12T09:00:00.000Z',
        }),
      ],
      false,
      NOW,
    );
    expect(stats).toEqual({ approvedThisWeek: 1, avgDecisionSeconds: 16 });
    render(await DecisionStats({ stats }));
    expect(screen.getByTestId('decision-stats')).toHaveTextContent('Approved this week 1');
    expect(screen.getByTestId('decision-stats')).toHaveTextContent('Avg decision 16s');
  });

  it('⚠⚠ none at all when the list may be cut — a short count is worse than none', async () => {
    expect(decisionStats([approval()], true, NOW)).toBeNull();
    const { container } = render(await DecisionStats({ stats: null }));
    expect(container).toBeEmptyDOMElement();
  });
});

describe('★ 03c’s card, measured on all four sides of every border', () => {
  const css = readFileSync('src/features/approvals/Approvals.module.css', 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  const rule = (selector: string) =>
    new RegExp(`(?:^|\\n)\\s*${selector.replace(/[.:-]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(
      css,
    )?.[1] ?? '';

  it('a #F0EDE7 rule under the heading, #F7F5F1 between rows, none under the last', () => {
    expect(rule('.decidedCardHeader')).toMatch(/border-block-end:\s*1px solid var\(--panel-well\)/);
    expect(rule('.decidedRow')).toMatch(/border-block-end:\s*1px solid var\(--row-divider\)/);
    expect(rule('.decidedRow:last-child')).toMatch(/border-block-end:\s*0/);
  });
});
