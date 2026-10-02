import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { agentLoadSchema, analyticsOverviewSchema, busiestHour } from '@/api/contracts/analytics';
import { aiEmployeeSchema } from '@/api/contracts/people';
import analytics from '@/i18n/messages/en/analytics.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'analytics') =>
    createTranslator({ locale: 'en', messages: { analytics }, namespace }),
  // The configured zone, as the app's formatter carries it.
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'Asia/Jerusalem' }),
}));

import { HandoverCard, imbalance, TeamHero, TeamStrip, TeamTable } from './TeamTab';

const agent = (id: string, name: string, open: number, today = 0) =>
  agentLoadSchema.parse({ agentId: id, name, activeConversations: open, claimedToday: today });
const ai = (id: string, name: string) => aiEmployeeSchema.parse({ id, name, status: 'ACTIVE' });

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

describe('★★ busiest hour — UTC keys, read in the reader’s zone', () => {
  it('the hour with the most inbound across the days, as an instant', () => {
    const peak = busiestHour([
      {
        date: '2026-09-30',
        hours: [
          { hour: '09:00', inbound: 5, outbound: 0 },
          { hour: '13:00', inbound: 2, outbound: 0 },
        ],
      },
      {
        date: '2026-10-01',
        hours: [
          { hour: '09:00', inbound: 4, outbound: 0 },
          { hour: '13:00', inbound: 6, outbound: 0 },
        ],
      },
    ]);
    // 09:00 → 9 inbound across the two days; 13:00 → 8.
    expect(peak?.getUTCHours()).toBe(9);
    expect(
      busiestHour([{ date: '2026-10-01', hours: [{ hour: '09:00', inbound: 0, outbound: 3 }] }]),
    ).toBeNull();
  });

  it('★★ 09:00Z is shown as 12:00 in Israel — never the UTC key', async () => {
    render(
      await TeamStrip({
        data: {
          agents: null,
          aiEmployees: null,
          overview: analyticsOverviewSchema.parse({ humanHandledCount: 350 }),
          hourly: [{ date: '2026-10-01', hours: [{ hour: '09:00', inbound: 7, outbound: 0 }] }],
        },
      }),
    );
    expect(screen.getByTestId('team-busiest')).toHaveTextContent('12:00');
    expect(screen.getByTestId('team-people')).toHaveTextContent('350');
    for (const key of ['firstReply', 'resolved', 'handedBack']) {
      expect(screen.getByTestId(`team-${key}`)).toHaveTextContent('—');
    }
  });
});

describe('★★ one table — people and AI employees, alphabetical, no ranking', () => {
  it('★ people by name, not by load; then the AI employees, marked', async () => {
    render(
      await TeamTable({
        agents: [agent('z', 'Shira', 12, 4), agent('y', 'Eitan', 1, 1), agent('x', 'Tomer', 6, 2)],
        aiEmployees: [ai('s', 'Sales'), ai('c', 'Customer Support')],
      }),
    );
    const rows = [...screen.getByTestId('team-table').querySelectorAll('li')].map((li) =>
      li.getAttribute('data-testid'),
    );
    expect(rows).toEqual(['team-row-y', 'team-row-z', 'team-row-x', 'team-row-c', 'team-row-s']);
    expect(screen.getByTestId('team-row-z')).toHaveTextContent('Shira124——');
    expect(screen.getByTestId('team-row-c')).toHaveTextContent('AI employee');
  });

  it('⚠ no reply time anywhere — the metric that ranks the hard cases slowest', async () => {
    render(await TeamTable({ agents: [agent('a', 'A', 1)], aiEmployees: [] }));
    expect(screen.getByTestId('team-table')).not.toHaveTextContent(/\d+m\b|\d+s\b/);
    expect(screen.getByTestId('team-foot')).toHaveTextContent('nobody here is ranked');
  });

  it('⚠ two failed reads are not an empty team', async () => {
    const { unmount } = render(await TeamTable({ agents: null, aiEmployees: null }));
    expect(screen.getByTestId('team-unavailable')).toBeInTheDocument();
    unmount();
    render(await TeamTable({ agents: [], aiEmployees: [] }));
    expect(screen.getByTestId('team-none')).toBeInTheDocument();
  });

  it('the handover card keeps its place', async () => {
    render(await HandoverCard());
    expect(screen.getByTestId('team-handover')).toHaveTextContent('Nothing measures yet');
  });
});
