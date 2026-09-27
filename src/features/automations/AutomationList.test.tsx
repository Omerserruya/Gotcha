import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import type { Automation } from '@/api/contracts/automations';
import messages from '@/i18n/messages/en/automations.json';
import channels from '@/i18n/messages/en/channels.json';

import { AutomationList } from './AutomationList';

/**
 * The populated branch of screen 09, which this tenant cannot render.
 *
 * `page.tsx` returns the empty state because there are zero automations, so
 * every claim this screen makes — the all-time count, the never-run sentence,
 * null-as-"every channel" — is **unreachable by a capture**. The capture's
 * own absence assertions therefore prove nothing: *"the words 'this week' do
 * not appear"* is trivially true of four lines of empty state, and **would
 * pass against a blank page.**
 *
 * **An absence assertion is only worth running where the thing could have
 * appeared.** That is here, with rows in props — and it is why seeding was
 * refused: creating a real automation means wiring a rule that acts on live
 * conversations without anyone watching.
 *
 * ── WHAT IS STILL NOT COVERED, AND WHY ──
 * **That the `no-history` caveat renders ABOVE the list.** Both live in
 * `page.tsx`, and the page renders `<AutomationList>` — itself an async
 * server component — as a child, which this environment cannot resolve:
 * awaiting the page yields a tree with an unresolved async node and the
 * render produces nothing.
 *
 * Getting there would mean a server renderer or restructuring the page so
 * the caveat is passed into the list, which is changing the design to suit
 * the test. **It is one line of JSX and it is stated here instead of being
 * silently uncovered.**
 */

/*
 * `timeZone` matches `i18n/request.ts`, which sets `Asia/Jerusalem` for every
 * real request. A formatter without it falls back to the machine's zone (and
 * warns ENVIRONMENT_FALLBACK); one set to UTC formats a different day for any
 * timestamp in the evening. Either way the test renders a date the product
 * never shows, and a date assertion can pass while the screen is a day out.
 */
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'automations' | 'channels') =>
    createTranslator({ locale: 'en', messages: { automations: messages, channels }, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'Asia/Jerusalem' }),
}));

const automation = (over: Partial<Automation> = {}): Automation => ({
  id: 'f1',
  name: 'A customer wants to cancel',
  description: 'Finds the order and checks if it shipped',
  isActive: true,
  channel: null,
  trigger: null,
  runCount: 46,
  updatedAt: null,
  ...over,
});

async function renderList(automations: readonly Automation[]) {
  return render(await AutomationList({ automations }));
}

describe('the count is for all time, and says so', () => {
  it('renders a run count as a total', async () => {
    await renderList([automation({ runCount: 46 })]);
    expect(screen.getByTestId('runs-f1')).toHaveTextContent(/has run 46 times in total/i);
  });

  it('never says "this week" beside a number that has no clock', async () => {
    /*
     * THE ASSERTION THIS SCREEN ACTUALLY NEEDED. The design says "Ran 46
     * times this week"; `runCount` is cumulative and there are no run
     * records to derive a period from. The capture asserts the same thing
     * against an empty page, where it cannot fail.
     */
    await renderList([automation({ runCount: 46 })]);
    expect(document.body.textContent).toMatch(/46/);
    expect(document.body.textContent).not.toMatch(/this week|this month|today/i);
  });
});

describe('never-run is a sentence, not a zero', () => {
  it('explains why an active automation has never fired', async () => {
    await renderList([automation({ runCount: 0, isActive: true })]);
    const runs = screen.getByTestId('runs-f1');
    expect(runs).toHaveTextContent(/has never run/i);
    expect(runs).toHaveTextContent(/nothing has matched its trigger/i);
  });

  it('is visibly different from a count of zero', async () => {
    // A bare 0 in a column would not be noticed, and an automation that is
    // ON and has never fired is the interesting row on this screen.
    await renderList([automation({ runCount: 0 })]);
    expect(screen.getByTestId('runs-f1').textContent).not.toMatch(/^0\b|\b0 times/);
  });
});

describe('one channel, or all of them', () => {
  it('★★ names the single channel and never prints its enum', async () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * ★★ THE FOURTH RENDERER OF `channel`, FOUND BY GREPPING THE FIELD
     * ════════════════════════════════════════════════════════════════════════
     * This said `Runs on WHATSAPP` on any channel-scoped automation. Three
     * browser walks did not find it, and not because it is subtle: **every
     * automation on the dev tenant has `channel: null`**, so the page can only
     * ever render the `where.all` branch. Tenant state foreclosed it, the same
     * way it foreclosed five other branches this week.
     *
     * ── AND THE OLD ASSERTION WAS NOT A PIN, WHICH IS WORTH RECORDING ──
     * It read `toHaveTextContent(/runs on WHATSAPP/i)`. The `/i` makes it match
     * "Runs on WhatsApp" just as happily, so it permitted both behaviours
     * rather than requiring the broken one. It did not pin the defect — it was
     * simply unable to see it, which is a different fault with a different fix:
     * a case-insensitive match on a value whose CASE is the whole question.
     *
     * So this now asserts in both directions.
     */
    await renderList([automation({ channel: 'WHATSAPP' })]);
    const where = screen.getByTestId('where-f1');
    expect(where).toHaveTextContent('Runs on WhatsApp');
    expect(where).not.toHaveTextContent('WHATSAPP');
  });

  it('★ says "another channel" for one the catalogue has never heard of', async () => {
    // A channel the platform adds tomorrow must not arrive as its own enum.
    await renderList([automation({ channel: 'TELEGRAM' })]);
    expect(screen.getByTestId('where-f1')).not.toHaveTextContent('TELEGRAM');
  });

  it('says "every channel" for null rather than listing the eight we know', async () => {
    // The model says "all", not "these eight". Enumerating them would invent
    // a specificity the flow does not have and go stale the moment a channel
    // is added.
    await renderList([automation({ channel: null })]);
    const where = screen.getByTestId('where-f1');
    expect(where).toHaveTextContent(/every channel/i);
    expect(where.textContent).not.toMatch(/whatsapp|instagram|email/i);
  });
});

describe('nothing in a populated row could become a false claim', () => {
  it('renders no currency anywhere', async () => {
    // "₪12,400 recovered" is attributed revenue — fifth appearance across
    // five screens, still with no inputs anywhere in the platform.
    await renderList([automation({ runCount: 188 })]);
    expect(document.body.textContent).not.toMatch(/₪|recovered|revenue/i);
  });

  it('renders no actor or timestamp for being off', async () => {
    // "Paused by you on 12 Aug" needs both; `isActive` is a bare boolean.
    await renderList([automation({ isActive: false })]);
    expect(screen.getByTestId('state-f1')).toHaveTextContent(/^off$/i);
    expect(document.body.textContent).not.toMatch(/paused by|paused on/i);
  });
});
