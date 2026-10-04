import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { agentLoadListSchema, agentLoadSchema, type AgentLoad } from '@/api/contracts/analytics';
import messages from '@/i18n/messages/en/analytics.json';

import { TeamLoad } from './TeamLoad';

/**
 * Screen 06c.
 *
 * Shipped without the outcome column the design pairs load with, on Omer's
 * decision after the leaderboard risk was put to him. These tests hold the
 * part that was NOT authorised with it: the screen may lack a metric, it may
 * not misdescribe the ones it has.
 */

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'analytics') =>
    createTranslator({ locale: 'en', messages: { analytics: messages }, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'Asia/Jerusalem' }),
}));

const agent = (over: Record<string, unknown> = {}): AgentLoad =>
  agentLoadSchema.parse({
    agentId: 'u1',
    name: 'Dana Levi',
    activeConversations: 7,
    claimedToday: 12,
    ...over,
  });

const show = async (agents: readonly AgentLoad[] | null) => render(await TeamLoad({ agents }));

describe('★★ every number says which period it covers', () => {
  it('★★ labels the figures with the period they actually cover, and claims no longer one', async () => {
    /*
     * `claimedToday` and the open count are day-scoped — Redis day-keys and a
     * live queue depth. The design's header says *"Last 7 days, compared with
     * the week before"*, and a figure under the wrong period label is wrong in
     * a way no reader can see.
     *
     * ── AND THIS ASSERTION WAS AIMED AT A PHRASE ──
     * It required the words *"not the seven days above"*, which stopped being
     * true when the screen was assembled: there is no header above this panel,
     * so a sentence denying one referred to something absent. The rule is that
     * the period is STATED and no longer one is implied — checked positively,
     * and negatively against any weekly claim rather than against the sentence
     * that used to deny it. Third assertion this week pinned to wording when
     * it meant a claim.
     */
    await show([agent()]);
    const period = screen.getByTestId('team-period');
    expect(period).toHaveTextContent(/today's numbers/i);
    expect(period).toHaveTextContent(/reset at midnight/i);
    // No period this panel does not cover.
    expect(period).not.toHaveTextContent(/seven days|7 days|last week|this week|this month/i);
  });

  it('★ calls the open count "open now" rather than "handled"', async () => {
    // `activeConversations` is a queue depth. A number beside a name is read
    // as throughput unless the column says otherwise.
    await show([agent()]);
    expect(screen.getByTestId('team-load')).toHaveTextContent(/Open now/i);
    expect(screen.getByTestId('team-load')).not.toHaveTextContent(/handled/i);
  });
});

describe('★★ the two absences a reader would otherwise infer', () => {
  it('★★ no longer says it is the human team: AI employees are in it (e188ce7c)', async () => {
    await show([agent()]);
    expect(screen.queryByTestId('team-humans-only')).toBeNull();
    expect(document.body.textContent).not.toMatch(/people only|human team/i);
  });

  it('★★ ships no outcome column and no proxy for one', async () => {
    /*
     * Speed is not quality. A fast average beside a big count invites the
     * reading the design was built to prevent, and dressed as an outcome it
     * would be worse than the honest absence.
     */
    const { container } = await show([agent()]);
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/resolution|resolved|success rate|score|rank|best|top performer/i);
  });
});

describe('★★ the reply-time column, and why it is gone', () => {
  it('★★ renders no reply-speed column at all', async () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * THIS SHIPPED AS "Average reply today" AND WAS WRONG.
     * ════════════════════════════════════════════════════════════════════════
     * `avgResponseTimeMs` is pushed by `analytics.worker.ts` as
     * `now − claim_time` on EVERY agent message, and `claim_time` is set once
     * per conversation and never cleared. So the tenth reply measures from
     * the original claim: the number **grows with how long a conversation
     * runs rather than with how slow anybody is.**
     *
     * Beside a person's name that makes whoever handles the long difficult
     * cases look slowest — on the screen built not to rank anybody. An
     * absent column beats an unfair one.
     */
    /*
     * ★ THE FIELD IS NOT IN THE SCHEMA EITHER.
     *
     * Removing the column was the first half. The second is that
     * `avgResponseTimeMs` is no longer NAMED in `agentLoadSchema`, so
     * `z.object` strips it — a field that parses cleanly, carries a
     * plausible name and is rendered by nothing is a trap for whoever
     * builds the next team panel, and everything wrong with it would live
     * in a message thread rather than at the call site.
     */
    const parsed = agentLoadSchema.parse({ agentId: 'u1', avgResponseTimeMs: 42_000 });
    expect(parsed).not.toHaveProperty('avgResponseTimeMs');

    const { container } = await show([agent()]);
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/42s|average reply|reply time|response time/i);
  });

  it('★ says the column is absent rather than leaving a gap', async () => {
    // A reader holding the design looks for a speed column. An absence that
    // explains itself only has to explain itself once.
    await show([agent()]);
    // One line on screen; the reason — which is the point — is its tooltip.
    expect(screen.getByTestId('team-no-speed').getAttribute('title')).toMatch(
      /grows with how long/i,
    );
  });

  it('★ a failed read is not an empty team', async () => {
    await show(null);
    expect(screen.getByTestId('team-unavailable')).toHaveTextContent(/couldn't read/i);
  });
});

describe('★ order is for reading, not for ranking', () => {
  it('★★ sorts by name, never by volume', async () => {
    /*
     * Sorting by count builds the leaderboard out of the row order even with
     * no outcome column present: the top of a sorted list reads as the best
     * or the worst of something, and these numbers support neither.
     */
    await show([
      agent({ agentId: 'busy', name: 'Zoe', activeConversations: 99 }),
      agent({ agentId: 'quiet', name: 'Amit', activeConversations: 1 }),
    ]);
    const rows = screen.getAllByTestId(/^agent-/);
    expect(rows[0]).toHaveAttribute('data-testid', 'agent-quiet');
  });

  it('★★ never renders an email address', async () => {
    // The route returns one; `z.object` strips what it does not name. A
    // workload table is not a directory.
    const parsed = agentLoadSchema.parse({ agentId: 'u1', email: 'dana@example.com' });
    expect(parsed).not.toHaveProperty('email');
    const { container } = await show([agent()]);
    expect(container.textContent ?? '').not.toMatch(/@/);
  });
});

describe('⚠ no team is one line, not four disclaimers', () => {
  it('says so once; the notes about absent numbers are its tooltip', async () => {
    render(await TeamLoad({ agents: [] }));
    const card = screen.getByTestId('team-load');
    expect(card.querySelectorAll('p')).toHaveLength(1);
    const none = screen.getByTestId('team-none');
    // The read now counts admins and AI employees too: empty is truly no one.
    expect(none).toHaveTextContent('No one on the team yet.');
    expect(none).not.toHaveTextContent(/Agent role/);
    expect(none.getAttribute('title')).toMatch(/grows with how long/);
  });
});

/** The wire as backend e188ce7c sends it. */
const WIRE = [
  {
    agentId: 'm1',
    name: 'matan',
    email: 'matan@example.com',
    kind: 'human',
    activeConversations: 1,
    claimedToday: 0,
    avgResponseTimeMs: null,
  },
  {
    agentId: 'a1',
    name: 'Maya',
    email: null,
    kind: 'ai',
    activeConversations: 13,
    claimedToday: null,
    avgResponseTimeMs: null,
    nullReasons: { claimedToday: 'ai_does_not_claim', avgResponseTimeMs: 'not_measured_for_ai' },
  },
];

describe('★★ 06 — people and AI employees, one table', () => {
  it('the real shape parses — it failed the contract at 1.claimedToday', () => {
    const parsed = agentLoadListSchema.parse(WIRE);
    expect(parsed[1]).toMatchObject({ kind: 'ai', claimedToday: null });
    expect(parsed[1]!.nullReasons.claimedToday).toBe('ai_does_not_claim');
  });

  it('Maya is marked, and her "taken today" is "—" with why — not 0', async () => {
    render(await TeamLoad({ agents: agentLoadListSchema.parse(WIRE) }));
    const maya = screen.getByTestId('agent-a1');
    expect(maya).toHaveTextContent('AI employee');
    const cells = maya.querySelectorAll('td');
    expect(cells[0]).toHaveTextContent('13');
    expect(cells[1]).toHaveTextContent(/^—$/);
    expect(cells[1]).toHaveAttribute(
      'title',
      "AI employees don't take conversations; they're assigned.",
    );
    expect(screen.getByTestId('agent-m1').querySelectorAll('td')[1]).toHaveTextContent('0');
  });

  it('no claim about who is counted remains', async () => {
    render(await TeamLoad({ agents: agentLoadListSchema.parse(WIRE) }));
    expect(document.body.textContent).not.toMatch(/Agent role|People only, not GOTCHA/);
    expect(screen.queryByTestId('team-humans-only')).toBeNull();
  });
});
