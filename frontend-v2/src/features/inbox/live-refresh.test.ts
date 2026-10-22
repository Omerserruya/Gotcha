import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GATHER_MS, refreshScheduler } from './live-refresh';

/** The scheduler's own lifecycle; the rules as the page uses them are `ListLive.test.tsx`. */
const harness = () => {
  const refresh = vi.fn();
  const scheduler = refreshScheduler({ refresh, hidden: () => false, held: () => false });
  return { refresh, scheduler };
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('★ stopped is stopped', () => {
  it('★ a read it owed is cancelled - no timer is left behind', () => {
    const { refresh, scheduler } = harness();
    scheduler.poke();
    expect(vi.getTimerCount()).toBe(1);
    scheduler.stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('★ an event after stop arms nothing', () => {
    const { refresh, scheduler } = harness();
    scheduler.stop();
    scheduler.poke();
    scheduler.shown();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(GATHER_MS * 10);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('★ owed a read when it stopped, shown afterwards: still nothing', () => {
    const { refresh, scheduler } = harness();
    scheduler.poke();
    scheduler.stop();
    scheduler.shown();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(GATHER_MS * 10);
    expect(refresh).not.toHaveBeenCalled();
  });
});
