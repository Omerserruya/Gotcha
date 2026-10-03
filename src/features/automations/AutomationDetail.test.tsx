import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import type { Automation } from '@/api/contracts/automations';
import messages from '@/i18n/messages/en/automations.json';
import channels from '@/i18n/messages/en/channels.json';

import { AutomationDetail } from './AutomationDetail';

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
 * ── WHAT CHANGED (S2, 2026-10-03) ──
 * The list became 09's detail: ONE automation, the selected one, and the
 * `no-history` caveat is gone — "—" in the outcome figures and the stops
 * card carry that absence in 02's shape. The list's rules hold for the one.
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
  nodes: [],
  edges: [],
  ...over,
});

// 09 shows ONE automation, the selected one; the list's rules hold for it.
async function renderList(automations: readonly Automation[]) {
  return render(await AutomationDetail({ automation: automations[0]! }));
}

describe('the count is for all time, and says so', () => {
  it('renders a run count as a total', async () => {
    await renderList([automation({ runCount: 46 })]);
    expect(screen.getByTestId('runs-f1')).toHaveTextContent('46');
    expect(screen.getByTestId('runs-f1').nextSibling).toHaveTextContent('times in all');
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
    const label = screen.getByTestId('runs-f1').nextSibling;
    expect(label).toHaveTextContent(/has never run/i);
    expect(label).toHaveTextContent(/nothing has matched its trigger/i);
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
    // Not even on the control: the button says what pressing it would do.
    expect(document.body.textContent).not.toMatch(/paused by|paused on/i);
  });
});

describe('★★ WHEN / THEN — from what the flow actually holds', () => {
  const graph = (nodes: [string, string][], edges: [string, string][]) => ({
    nodes: nodes.map(([id, type]) => ({ id, type })),
    edges: edges.map(([source, target]) => ({ source, target })),
  });

  it('WHEN is the trigger as written; none is said, not invented', async () => {
    const { unmount } = await renderList([automation({ trigger: 'Someone asks to cancel' })]);
    expect(screen.getByTestId('flow-when')).toHaveTextContent('Someone asks to cancel');
    unmount();
    await renderList([automation({ trigger: '  ' })]);
    expect(screen.getByTestId('flow-when')).toHaveTextContent("isn't written down");
  });

  it('★ THEN walks the graph from its start, in run order — not array order', async () => {
    await renderList([
      automation(
        graph(
          [
            ['b', 'ai_generate'],
            ['a', 'collect_input'],
            ['c', 'send_message_text'],
          ],
          [
            ['a', 'b'],
            ['b', 'c'],
          ],
        ),
      ),
    ]);
    const steps = [...screen.getByTestId('flow-then').querySelectorAll('p')].map(
      (p) => p.textContent,
    );
    expect(steps).toEqual([
      'Ask the customer for something',
      'Write a reply with AI',
      'Send a message',
    ]);
  });

  it('★★ where it branches it SAYS so and stops — no guessed "case"', async () => {
    await renderList([
      automation(
        graph(
          [
            ['a', 'collect_input'],
            ['b', 'send_message_text'],
            ['c', 'route_target'],
          ],
          [
            ['a', 'b'],
            ['a', 'c'],
          ],
        ),
      ),
    ]);
    expect(screen.getByTestId('flow-then')).toHaveTextContent('Ask the customer for something');
    expect(screen.getByTestId('flow-then')).not.toHaveTextContent('Send a message');
    expect(screen.getByTestId('flow-branches')).toHaveTextContent('branches 2 ways');
  });

  it('an unknown node type is humanised; a cycle ends the walk', async () => {
    await renderList([
      automation(
        graph(
          [
            ['a', 'wait_for_reply'],
            ['b', 'send_message_text'],
          ],
          [
            ['a', 'b'],
            ['b', 'a'],
          ],
        ),
      ),
    ]);
    expect(screen.getByTestId('flow-then')).toHaveTextContent('Wait for reply');
  });

  it('★ outcomes nothing records are "—", and the stops card says why', async () => {
    await renderList([automation()]);
    expect(screen.getByTestId('stops')).toHaveTextContent('Nothing records why a run stopped');
    expect(document.body.textContent).toMatch(/finished alone/);
  });
});

describe('★ 09 corrections (measurement of fa773e6)', () => {
  it('★★ a single channel is named when the flow is OFF too — the enum value', async () => {
    await renderList([automation({ channel: 'WHATSAPP', isActive: false })]);
    expect(screen.getByTestId('where-f1')).toHaveTextContent('Runs on WhatsApp · Off');
  });

  it('the figure on top, its label under it', async () => {
    await renderList([automation({ runCount: 46 })]);
    const figure = screen.getByTestId('runs-f1');
    expect(figure.parentElement!.firstElementChild).toBe(figure);
  });

  it('★ the stops card is neutral while nothing records a stop', async () => {
    await renderList([automation()]);
    expect(screen.getByTestId('stops')).toHaveAttribute('data-state', 'empty');
  });

  it('the description is the list row’s, not repeated in the detail', async () => {
    await renderList([automation({ description: 'Finds the order and checks if it shipped' })]);
    expect(document.body.textContent).not.toMatch(/Finds the order/);
  });
});
