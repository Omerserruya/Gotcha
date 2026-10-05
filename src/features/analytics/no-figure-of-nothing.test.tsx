import { render } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  aiPerformanceSchema,
  analyticsOverviewSchema,
  timeSavedSchema,
  teamReportSchema,
} from '@/api/contracts/analytics';
import analytics from '@/i18n/messages/en/analytics.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'analytics') =>
    createTranslator({ locale: 'en', messages: { analytics }, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'Asia/Jerusalem' }),
  getTimeZone: async () => 'Asia/Jerusalem',
}));
vi.mock('@/i18n/navigation', () => ({ Link: 'a' }));

import { GotchaHero, GotchaStrip } from './GotchaTab';
import { KpiStrip } from './OperationSummary';
import { SalesHero, SalesStrip } from './SalesTab';
import { TeamHero, TeamStrip } from './TeamTab';
import { TopicsHero } from './TopicsTab';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ ONE RULE ACROSS EVERY ANALYTICS TAB: NO FIGURE OF NOTHING
 * ════════════════════════════════════════════════════════════════════════════
 * Found piecemeal four times — "0%" answered first, "0h" saved, "It answered
 * first in 0 conversations … 0 hours", "Answered first by people: 0" — each
 * fixed where it was seen. This is the one assertion instead of the fifth fix:
 * a week with NO conversations, rendered through every tab's figures and
 * dark cards, and nothing may present a share, hours or a conversation count
 * of that nothing as a result.
 *
 * Raw event counts may stay at 0 — "Needed approval 0" is a fact. What may
 * not appear is a percentage, an hours figure, or a count of conversations or
 * people when there were no conversations.
 *
 * ⚠ ADD EACH NEW TAB HERE. A tab not rendered below is not covered — see
 * `tests-must-enumerate-the-registry`.
 */
const EMPTY_WEEK = {
  overview: analyticsOverviewSchema.parse({
    totalConversations: 0,
    aiHandledCount: 0,
    aiHandledPct: 0,
    humanHandledCount: 0,
    resolutionRate: 0,
  }),
  timeSaved: timeSavedSchema.parse({ secondsSaved: 0 }),
  tools: [],
  ai: aiPerformanceSchema.parse({ approvals: { requested: 0 } }),
  unanswered: { data: [] },
  integrations: [],
};

const FIGURES_OF_NOTHING: readonly RegExp[] = [
  /(^|[^\d.,])0(\.0+)?\s?%/, //            0%
  /(^|[^\d.,])0(\.0+)?\s?h\b/, //          0h
  /(^|[^\d.,])0\s+hours?\b/i, //           0 hours
  /(^|[^\d.,])0\s+conversations?\b/i, //   0 conversations
  /(^|[^\d.,])0\s+people\b/i, //           0 people
  /(^|[^\d.,])0\s?[ms]\b/, // 0m, 0s — a duration of nothing
];

const TABS: readonly [string, () => Promise<ReactElement>][] = [
  [
    '06 overview strip',
    async () => KpiStrip({ overview: EMPTY_WEEK.overview, timeSaved: EMPTY_WEEK.timeSaved }),
  ],
  ['06b dark card', async () => GotchaHero({ data: EMPTY_WEEK })],
  ['06b strip', async () => GotchaStrip({ data: EMPTY_WEEK })],
  ['06c dark card', async () => TeamHero({ agents: [] })],
  [
    '06c strip',
    async () =>
      TeamStrip({
        data: { agents: [], report: EMPTY_TEAM },
      }),
  ],
  ['06d dark card', async () => SalesHero()],
  ['06d strip', async () => SalesStrip()],
  [
    '06e dark card',
    async () => TopicsHero({ data: { week: [], before: [], unanswered: { data: [] } } }),
  ],
];

/**
 * Cells whose figure is DERIVED from conversations: in the empty week each
 * must read "—". A count after its label ("Answered first by people0") is
 * invisible to the text patterns above, so these are named.
 */
/* The team report for a week nobody wrote in (backend af4f0072's shape). */
const EMPTY_TEAM = teamReportSchema.parse({
  members: [],
  cards: {
    handledByPeople: 0,
    firstReplyMedianMs: null,
    resolvedRate: null,
    handedBackToGotcha: 0,
    inboundByHourUtc: new Array(24).fill(0),
  },
});

const DERIVED_CELLS: readonly [string, () => Promise<ReactElement>, readonly string[]][] = [
  ['06b strip', async () => GotchaStrip({ data: EMPTY_WEEK }), ['gotcha-alone', 'gotcha-saved']],
  [
    '06c strip',
    async () =>
      TeamStrip({
        data: { agents: [], report: EMPTY_TEAM },
      }),
    ['team-people', 'team-busiest', 'team-handedBack', 'team-firstReply', 'team-resolved'],
  ],
];

describe('★★ a week with no conversations, through every tab', () => {
  it.each(TABS)('%s shows no figure of nothing', async (_name, part) => {
    const { container } = render(await part());
    const text = container.textContent ?? '';
    for (const pattern of FIGURES_OF_NOTHING) {
      expect(text, `${_name}: "${text}" matches ${pattern}`).not.toMatch(pattern);
    }
  });

  it.each(DERIVED_CELLS)(
    '%s: every conversation-derived cell is "—"',
    async (_name, part, cells) => {
      const { container } = render(await part());
      for (const id of cells) {
        expect(container.querySelector(`[data-testid="${id}"] dd`)?.textContent, id).toBe('—');
      }
    },
  );

  it('the patterns catch what they are for (each was on a screen once)', () => {
    expect(FIGURES_OF_NOTHING.some((p) => p.test('Time saved0s'))).toBe(true);
    for (const seen of [
      'Answered first by GOTCHA0%',
      'Time saved0h',
      'in 0 conversations',
      'about 0 hours',
    ]) {
      expect(
        FIGURES_OF_NOTHING.some((p) => p.test(seen)),
        seen,
      ).toBe(true);
    }
    // …and leave real figures alone.
    for (const fine of ['88%', '10%', '41h', '120 conversations', 'Needed approval0']) {
      expect(
        FIGURES_OF_NOTHING.some((p) => p.test(fine)),
        fine,
      ).toBe(false);
    }
  });
});
