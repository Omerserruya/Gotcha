import type { ReactElement, ReactNode } from 'react';
import { isValidElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadHomeData = vi.hoisted(() => vi.fn());
const firstName = vi.hoisted(() => ({ value: null as string | null }));
vi.mock('./load-home-data', () => ({
  loadHomeData,
  QUIET_DAY_LIMIT: 4,
  loadViewerFirstName: async () => firstName.value,
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
  getFormatter: async () => ({ dateTime: () => 'date' }),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/i18n/navigation', () => ({ Link: 'a', useRouter: () => ({}), usePathname: () => '/' }));

import { ActivityCard } from './ActivityCard';
import { CommandSurface } from './CommandSurface';
import { FirstSteps } from './FirstSteps';
import styles from './Home.module.css';
import { HomeScreen } from './HomeScreen';
import { QueueList } from './QueueList';
import { QuietWork } from './QuietWork';
import { StatusStrip } from './StatusStrip';
import { TeamPanel } from './TeamPanel';
import { WorthKnowing } from './WorthKnowing';

/** Every element of a type, shallow - the children are not rendered. */
function all<P>(
  node: ReactNode,
  test: (e: ReactElement<P>) => boolean,
  out: ReactElement<P>[] = [],
) {
  if (Array.isArray(node)) node.forEach((n) => all(n, test, out));
  else if (isValidElement(node)) {
    const element = node as ReactElement<P>;
    if (test(element)) out.push(element);
    for (const value of Object.values((element.props ?? {}) as Record<string, ReactNode>)) {
      all(value, test, out);
    }
  }
  return out;
}

const data = (over: Record<string, unknown>) => ({
  overview: null,
  channels: null,
  queue: { waiting: 0 },
  queueItems: { data: [], totalWaiting: 0 },
  activity: [],
  timeSaved: null,
  inFlight: null,
  allowance: null,
  insights: null,
  quietDay: {
    sources: {},
    data: [
      {
        id: 'a',
        source: 'unanswered_question',
        kind: 'x',
        rank: 1,
        effect: 'removes_work',
        basis: {},
        values: {},
      },
      {
        id: 'b',
        source: 'unanswered_question',
        kind: 'x',
        rank: 2,
        effect: 'removes_work',
        basis: {},
        values: {},
      },
      {
        id: 'c',
        source: 'dormant',
        kind: 'x',
        rank: 3,
        effect: 'creates_opportunity',
        basis: {},
        values: {},
      },
    ],
  },
  setup: null,
  ingest: null,
  team: [],
  conflicts: [],
  isQuiet: true,
  signals: 0,
  presence: new Map(),
  gate: null,
  open: null,
  ...over,
});

const screen = async (over: Record<string, unknown> = {}) => {
  loadHomeData.mockResolvedValue(data(over));
  return HomeScreen();
};

beforeEach(() => vi.useFakeTimers({ now: new Date(2026, 9, 3, 19, 0) }));
afterEach(() => vi.useRealTimers());

describe('★★ 01b - a quiet day', () => {
  it('two columns: the work, then the dark card over the team - no Worth knowing', async () => {
    const tree = await screen();
    expect(
      all(tree, (e) => (e.props as { className?: string }).className === styles.columnsQuiet),
    ).toHaveLength(1);
    expect(all(tree, (e) => e.type === QuietWork)).toHaveLength(1);
    expect(all(tree, (e) => e.type === ActivityCard)).toHaveLength(1);
    expect(all(tree, (e) => e.type === TeamPanel)).toHaveLength(1);
    expect(all(tree, (e) => e.type === WorthKnowing)).toHaveLength(0);
  });

  it('the greeting follows the clock: a quiet EVENING at 19:00', async () => {
    const tree = await screen();
    const text = JSON.stringify(tree);
    expect(text).toContain('greeting.quiet.evening');
    expect(text).not.toContain('greeting.quiet.morning');
  });

  it('★ 02: "Quiet evening, Maya" - the name on every face, from /api/auth/me', async () => {
    firstName.value = 'Maya';
    try {
      const quiet = JSON.stringify(await screen());
      expect(quiet).toContain('greeting.named.quiet.evening');
      const busy = JSON.stringify(await screen({ isQuiet: false }));
      expect(busy).toContain('greeting.named.evening');
    } finally {
      firstName.value = null;
    }
  });

  it('the chips get the open questions from the quiet-day read', async () => {
    const tree = await screen();
    const [box] = all<{ tone: string; openQuestions: number | null }>(
      tree,
      (e) => e.type === CommandSurface,
    );
    expect(box?.props).toMatchObject({ tone: 'quiet', openQuestions: 2 });
  });

  it('★ a full page may hold more: no count rather than an undercount', async () => {
    const item = (id: string) => ({
      id,
      source: 'unanswered_question',
      kind: 'x',
      rank: 1,
      effect: 'removes_work',
      basis: {},
      values: {},
    });
    const tree = await screen({
      quietDay: { sources: {}, data: [item('a'), item('b'), item('c'), item('d')] },
    });
    const [box] = all<{ openQuestions: number | null }>(tree, (e) => e.type === CommandSurface);
    expect(box?.props.openQuestions).toBeNull();
  });

  it('no quiet-day read: no count', async () => {
    const tree = await screen({ quietDay: null });
    const [box] = all<{ openQuestions: number | null }>(tree, (e) => e.type === CommandSurface);
    expect(box?.props.openQuestions).toBeNull();
  });
});

describe('★ a busy day is three columns, with Worth knowing', () => {
  it('the busy grid', async () => {
    const tree = await screen({ isQuiet: false, queue: { waiting: 3 } });
    expect(
      all(tree, (e) => (e.props as { className?: string }).className === styles.columns),
    ).toHaveLength(1);
    expect(all(tree, (e) => e.type === WorthKnowing)).toHaveLength(1);
    expect(all(tree, (e) => e.type === QuietWork)).toHaveLength(0);
  });
});

describe('★★ 01c - day one: the same Home, its own head', () => {
  const setup = {
    steps: [
      { id: 'connect_channel', state: 'done', blockedBy: [], estimateMinutes: 5 },
      { id: 'add_knowledge', state: 'done', blockedBy: [], estimateMinutes: 5 },
      { id: 'hire_employee', state: 'next', blockedBy: [], estimateMinutes: 4 },
      { id: 'invite_team', state: 'waiting', blockedBy: [], estimateMinutes: 2 },
    ],
    isLive: false,
    goLive: { eligible: false, blockedBy: ['hire_employee'] },
    trial: { daysRemaining: 14, conversationsUsed: 0 },
  };
  const ingest = {
    pagesRead: 214,
    answersDrafted: 38,
    answersNeedingConfirmation: 0,
    pendingTopics: [],
  };

  it('the status line is "not live" and the trial - never "replies only to your team"', async () => {
    const tree = await screen({ setup, ingest, isQuiet: false });
    const [strip] = all<{ dayOne: unknown }>(tree, (e) => e.type === StatusStrip);
    expect(strip?.props.dayOne).toEqual({ trialDays: 14, setupCallUrl: null });
  });

  it('the eyebrow, the heading and the line come from the setup and the scan', async () => {
    const text = JSON.stringify(await screen({ setup, ingest, isQuiet: false }));
    expect(text).toContain('dayOne.eyebrow');
    expect(text).toContain('dayOne.heading');
    expect(text).toContain('dayOne.read');
    expect(text).toContain('dayOne.stepsLeft');
    expect(text).not.toContain('greeting.');
  });

  it('★ the heading carries the viewer’s first name when known (02: "…ready, Maya")', async () => {
    firstName.value = 'Maya';
    const named = JSON.stringify(await screen({ setup, ingest, isQuiet: false }));
    expect(named).toContain('dayOne.headingNamed');
    firstName.value = null;
    const plain = JSON.stringify(await screen({ setup, ingest, isQuiet: false }));
    expect(plain).not.toContain('dayOne.headingNamed');
  });

  it('no scan yet: the steps alone, no "read 0 pages"', async () => {
    const text = JSON.stringify(await screen({ setup, ingest: null, isQuiet: false }));
    expect(text).not.toContain('dayOne.read');
    expect(text).toContain('dayOne.stepsLeft');
  });

  it('a scan that read nothing says nothing about pages either', async () => {
    const text = JSON.stringify(
      await screen({
        setup,
        ingest: { ...ingest, pagesRead: 0, answersDrafted: 0 },
        isQuiet: false,
      }),
    );
    expect(text).not.toContain('dayOne.read');
  });

  it('the day-one chips, and First steps in place of the columns', async () => {
    const tree = await screen({ setup, ingest, isQuiet: false });
    const [box] = all<{ tone: string }>(tree, (e) => e.type === CommandSurface);
    expect(box?.props.tone).toBe('dayOne');
    expect(all(tree, (e) => e.type === FirstSteps)).toHaveLength(1);
    expect(all(tree, (e) => e.type === QuietWork)).toHaveLength(0);
  });
});

describe('★★ one person: the strip, the sentence and the card say Open (2026-11-15)', () => {
  const item = {
    conversationId: 'c1',
    customer: { id: '+972541234567', name: 'Dana' },
    channel: 'WHATSAPP',
    preview: 'Hi',
    intent: null,
    waitingSince: '2026-11-15T09:00:00Z',
  };
  const busy = { isQuiet: false, queue: { waiting: 0 }, queueItems: { data: [], totalWaiting: 0 } };

  it("★★ the strip counts Open, labelled Open - never the queue's 0", async () => {
    const tree = await screen({ ...busy, open: { count: 5, items: [item] } });
    const [strip] = all(tree, (e) => e.type === StatusStrip);
    expect(strip?.props).toMatchObject({ waiting: 5, counts: 'open' });
  });

  it('★★ the card lists the open conversations, and its footer opens "Open"', async () => {
    const tree = await screen({ ...busy, open: { count: 5, items: [item] } });
    const [list] = all(tree, (e) => e.type === QueueList);
    expect(list?.props).toMatchObject({ items: [item], totalWaiting: 5, of: 'open' });
  });

  it('★ the caption says how the card is ordered: newest first, not by risk', async () => {
    const tree = await screen({ ...busy, open: { count: 5, items: [item] } });
    expect(JSON.stringify(tree)).toContain('needsYou.open.sortedBy');
    expect(JSON.stringify(tree)).not.toContain('"needsYou.sortedBy"');
  });

  it('⚠ none open says so; an unread list says it could not read', async () => {
    expect(JSON.stringify(await screen({ ...busy, open: { count: 0, items: [] } }))).toContain(
      'needsYou.open.empty',
    );
    expect(JSON.stringify(await screen({ ...busy, open: { count: null, items: null } }))).toContain(
      'needsYou.open.unavailable',
    );
  });

  it("★ a team is today's: the queue's count and its ranked card", async () => {
    const tree = await screen({ ...busy, queue: { waiting: 3 } });
    const [strip] = all(tree, (e) => e.type === StatusStrip);
    expect(strip?.props).toMatchObject({ waiting: 3, counts: 'waiting' });
    expect(JSON.stringify(tree)).toContain('needsYou.sortedBy');
  });
});
