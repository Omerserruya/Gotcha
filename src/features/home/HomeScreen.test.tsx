import type { ReactElement, ReactNode } from 'react';
import { isValidElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadHomeData = vi.hoisted(() => vi.fn());
vi.mock('./load-home-data', () => ({ loadHomeData, QUIET_DAY_LIMIT: 4 }));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
  getFormatter: async () => ({ dateTime: () => 'date' }),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/i18n/navigation', () => ({ Link: 'a', useRouter: () => ({}), usePathname: () => '/' }));

import { ActivityCard } from './ActivityCard';
import { CommandSurface } from './CommandSurface';
import styles from './Home.module.css';
import { HomeScreen } from './HomeScreen';
import { QuietWork } from './QuietWork';
import { TeamPanel } from './TeamPanel';
import { WorthKnowing } from './WorthKnowing';

/** Every element of a type, shallow — the children are not rendered. */
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
  ...over,
});

const screen = async (over: Record<string, unknown> = {}) => {
  loadHomeData.mockResolvedValue(data(over));
  return HomeScreen();
};

beforeEach(() => vi.useFakeTimers({ now: new Date(2026, 9, 3, 19, 0) }));
afterEach(() => vi.useRealTimers());

describe('★★ 01b — a quiet day', () => {
  it('two columns: the work, then the dark card over the team — no Worth knowing', async () => {
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
