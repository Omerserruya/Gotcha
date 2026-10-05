import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import {
  agentLoadListSchema,
  agentLoadSchema,
  busiestLocalHour,
  teamReportSchema,
} from '@/api/contracts/analytics';
import analytics from '@/i18n/messages/en/analytics.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'analytics') =>
    createTranslator({ locale: 'en', messages: { analytics }, namespace }),
  // The configured zone, as the app's formatter carries it.
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'Asia/Jerusalem' }),
  getTimeZone: async () => 'Asia/Jerusalem',
}));

import { HandoverCard, imbalance, TeamHero, TeamStrip, TeamTable, teamSubline } from './TeamTab';

const agent = (id: string, name: string, open: number, today = 0) =>
  agentLoadSchema.parse({ agentId: id, name, activeConversations: open, claimedToday: today });

/* The route's shape (backend af4f0072). */
const member = (over: Record<string, unknown>) => ({
  kind: 'human',
  id: 'x',
  name: 'X',
  handled: 0,
  firstReplyMedianMs: null,
  resolvedRate: null,
  loadByDay: [0, 0, 0, 0, 0, 0, 0],
  ...over,
});
const report = (members: Record<string, unknown>[], cards: Record<string, unknown> = {}) =>
  teamReportSchema.parse({
    members: members.map(member),
    cards: {
      handledByPeople: 0,
      firstReplyMedianMs: null,
      resolvedRate: null,
      handedBackToGotcha: 0,
      inboundByHourUtc: new Array(24).fill(0),
      ...cards,
    },
  });

describe('★ the imbalance is the queue’s', () => {
  it('heaviest against lightest of those holding any, at two to one or more', () => {
    const result = imbalance([
      agent('a', 'Shira', 12),
      agent('b', 'Tomer', 6),
      agent('c', 'Eitan', 0),
    ]);
    expect(result?.heavy.name).toBe('Shira');
    expect(result?.light.name).toBe('Tomer');
    expect(result?.ratio).toBe(2);
  });

  it('⚠ under two to one, or fewer than two holding any: no finding', () => {
    expect(imbalance([agent('a', 'A', 5), agent('b', 'B', 3)])).toBeNull();
    expect(imbalance([agent('a', 'A', 5), agent('b', 'B', 0)])).toBeNull();
  });

  it('★ the sentence says what it measured, and names no speed or outcome', async () => {
    render(await TeamHero({ agents: [agent('a', 'Shira', 12), agent('b', 'Tomer', 6)] }));
    const hero = screen.getByTestId('team-hero');
    expect(hero).toHaveTextContent('Shira is carrying twice the queue Tomer is.');
    expect(hero).toHaveTextContent('conversations open now');
    expect(hero).not.toHaveTextContent(/slow|minutes|faster/i);
  });

  it('even: said so', async () => {
    render(await TeamHero({ agents: [agent('a', 'A', 5), agent('b', 'B', 4)] }));
    expect(screen.getByTestId('team-hero')).toHaveTextContent('spread evenly');
  });
});

describe('★★ the cards — the report’s, and the busiest hour in the workspace’s zone', () => {
  it('★★ a UTC histogram moved to Israel before its peak is taken: 09Z is 12:00', () => {
    const hours = new Array(24).fill(0);
    hours[9] = 7;
    hours[13] = 5;
    const october = new Date('2026-10-05T12:00:00Z');
    expect(busiestLocalHour(hours, 'Asia/Jerusalem', october)).toBe(12);
    // ★ Winter: the same 09Z is 11:00 — the offset is the day's, not a constant.
    expect(busiestLocalHour(hours, 'Asia/Jerusalem', new Date('2026-12-15T12:00:00Z'))).toBe(11);
    expect(busiestLocalHour(new Array(24).fill(0), 'Asia/Jerusalem')).toBeNull();
  });

  it('the five, from the cards: counts, a median, a rate, and the hour', async () => {
    const hours = new Array(24).fill(0);
    hours[9] = 7;
    render(
      await TeamStrip({
        data: {
          agents: null,
          report: report([], {
            handledByPeople: 350,
            firstReplyMedianMs: 180_000,
            resolvedRate: 0.94,
            handedBackToGotcha: 4,
            inboundByHourUtc: hours,
          }),
        },
      }),
    );
    expect(screen.getByTestId('team-people')).toHaveTextContent('350');
    expect(screen.getByTestId('team-firstReply')).toHaveTextContent('3m');
    expect(screen.getByTestId('team-resolved')).toHaveTextContent('94%');
    expect(screen.getByTestId('team-handedBack')).toHaveTextContent('4');
    // Today's offset (12:00 in summer, 11:00 in winter) — the unit test above pins both.
    const local = busiestLocalHour(hours, 'Asia/Jerusalem')!;
    expect([11, 12]).toContain(local);
    expect(screen.getByTestId('team-busiest')).toHaveTextContent(
      `${String(local).padStart(2, '0')}:00`,
    );
  });

  it('unread: "—" in every card, never zeros', async () => {
    render(await TeamStrip({ data: { agents: null, report: null } }));
    for (const key of ['people', 'firstReply', 'resolved', 'handedBack', 'busiest']) {
      expect(screen.getByTestId(`team-${key}`)).toHaveTextContent('—');
    }
  });
});

describe('★★ 06c’s table — 02’s columns, people then AI employees, alphabetical', () => {
  const REPORT = report([
    {
      id: 'z',
      name: 'Shira',
      handled: 196,
      firstReplyMedianMs: 660_000,
      resolvedRate: 0.94,
      loadByDay: [19, 21, 17, 10, 25, 23, 22],
    },
    {
      id: 'y',
      name: 'Eitan',
      handled: 36,
      firstReplyMedianMs: 1_320_000,
      resolvedRate: 0.97,
      loadByDay: [4, 5, 3, 2, 5, 4, 4],
    },
    {
      kind: 'ai',
      id: 's',
      name: 'Sales',
      handled: 470,
      firstReplyMedianMs: 21_000,
      resolvedRate: 0.88,
      loadByDay: [16, 19, 15, 10, 23, 21, 18],
    },
    {
      kind: 'ai',
      id: 'c',
      name: 'Customer Support',
      handled: 2020,
      firstReplyMedianMs: 18_000,
      resolvedRate: 0.91,
      loadByDay: [18, 21, 17, 11, 24, 22, 20],
    },
  ]);

  it('★ by name, not by load; Handled · First reply · Resolved for each', async () => {
    render(await TeamTable({ report: REPORT }));
    const rows = [...screen.getByTestId('team-table').querySelectorAll('li')].map((li) =>
      li.getAttribute('data-testid'),
    );
    expect(rows).toEqual(['team-row-y', 'team-row-z', 'team-row-c', 'team-row-s']);
    expect(screen.getByTestId('team-row-z')).toHaveTextContent('Shira19611m94%');
    expect(screen.getByTestId('team-row-c')).toHaveTextContent('AI employee2,02018s91%');
  });

  it('★ the week’s bars scale within their kind — the AI’s thousands never flatten a person', async () => {
    render(await TeamTable({ report: REPORT }));
    const bars = (id: string) =>
      [...screen.getByTestId(`team-row-${id}`).querySelectorAll<HTMLElement>('[data-ai], span')]
        .filter((el) => el.parentElement?.getAttribute('role') === 'img')
        .map((el) => el.style.blockSize);
    // Shira's busiest day (25) is the people's busiest: full height.
    expect(bars('z')[4]).toBe('26px');
    expect(bars('c')[4]).toBe('26px');
    expect(screen.getByTestId('team-row-c').querySelector('[data-ai]')).not.toBeNull();
  });

  it('nothing handled: a rate of nothing is "—", and a quiet day has no bar', async () => {
    render(await TeamTable({ report: report([{ id: 'q', name: 'Quiet' }]) }));
    expect(screen.getByTestId('team-row-q')).toHaveTextContent('Quiet0——');
    expect(screen.getByTestId('team-row-q').querySelectorAll('[style]')).toHaveLength(0);
  });

  it('⚠ a failed read is not an empty team', async () => {
    const { unmount } = render(await TeamTable({ report: null }));
    expect(screen.getByTestId('team-unavailable')).toBeInTheDocument();
    unmount();
    render(await TeamTable({ report: report([]) }));
    expect(screen.getByTestId('team-none')).toHaveTextContent('No one on the team yet.');
  });

  it('the foot says nobody is measured on volume alone', async () => {
    render(await TeamTable({ report: REPORT }));
    expect(screen.getByTestId('team-foot')).toHaveTextContent(
      'Nobody is measured on volume alone.',
    );
  });

  it('the handover card keeps its place', async () => {
    render(await HandoverCard());
    expect(screen.getByTestId('team-handover')).toHaveTextContent('Nothing measures yet');
  });
});

describe('★★ measured on dev: no Agent-role people — the card says what is true', () => {
  it.each([
    [[], 'tooFew', "There aren't two people counted here"],
    [[agent('a', 'A', 3)], 'tooFew', "There aren't two people counted here"],
    [[agent('a', 'A', 0), agent('b', 'B', 0)], 'noneOpen', 'No one has an open conversation'],
    [
      [agent('a', 'Shira', 5), agent('b', 'Tomer', 0)],
      'oneHoldsAll',
      'Shira holds every open conversation',
    ],
    [[agent('a', 'A', 5), agent('b', 'B', 4)], 'even', 'spread evenly'],
  ] as const)('%#: %s', async (agents, kind, words) => {
    const { queueState } = await import('./TeamTab');
    expect(queueState(agents).kind).toBe(kind);
    render(await TeamHero({ agents }));
    expect(screen.getByTestId('team-hero')).toHaveTextContent(words);
  });

  it('⚠ "spread evenly" is never said of fewer than two, or of one who holds them all', async () => {
    for (const agents of [[], [agent('a', 'A', 3)], [agent('a', 'A', 5), agent('b', 'B', 0)]]) {
      const { unmount } = render(await TeamHero({ agents }));
      expect(screen.getByTestId('team-hero')).not.toHaveTextContent('spread evenly');
      unmount();
    }
  });
});

describe('★ the header says what the table counts — 02\'s "three people, two teams"', () => {
  const team = (agents: unknown, ais: string[] | null) =>
    ({
      agents,
      report: ais === null ? null : report(ais.map((id) => ({ kind: 'ai', id, name: id }))),
    }) as Parameters<typeof teamSubline>[0];

  it("★ on dev's data: one AI employee and no Agent-role people", async () => {
    expect(await teamSubline(team([], ['a1']))).toBe('Last 7 days · 1 AI employee');
  });

  it('both kinds, each counted and pluralised', async () => {
    expect(
      await teamSubline(team([agent('p1', 'Dana', 1), agent('p2', 'Yossi', 0)], ['a1', 'a2'])),
    ).toBe('Last 7 days · 2 people, 2 AI employees');
    expect(await teamSubline(team([agent('p1', 'Dana', 1)], []))).toBe('Last 7 days · 1 person');
  });

  it('nothing counted, or nothing read: the period alone — never "0 people"', async () => {
    expect(await teamSubline(team([], []))).toBe('Last 7 days');
    expect(await teamSubline(team(null, null))).toBe('Last 7 days');
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
  },
  {
    agentId: 'a1',
    name: 'Maya',
    email: null,
    kind: 'ai',
    activeConversations: 13,
    claimedToday: null,
    nullReasons: { claimedToday: 'ai_does_not_claim' },
  },
];

describe('★★ 06c — the queue is compared between people', () => {
  it('one person is "too few", whatever the AI holds', async () => {
    render(await TeamHero({ agents: agentLoadListSchema.parse(WIRE) }));
    expect(screen.getByTestId('team-hero')).toHaveTextContent(
      "There aren't two people counted here",
    );
  });
});
