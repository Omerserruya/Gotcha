import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';
import type { RealtimeEvent } from '@/realtime/events';

/**
 * The rail's unread counts: one read on load, one per burst of events - owned
 * here, so a page render never reads them (one load with `?c=` read them four
 * times in three seconds when the page did, gateway 2026-10-11).
 */
const get = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/browser-api', () => ({ browserApi: { get } }));

const listeners = vi.hoisted(() => new Map<string, Set<(event: RealtimeEvent) => void>>());
vi.mock('@/realtime/realtime-provider', async () => {
  const { useEffect } = await import('react');
  return {
    useRealtimeEvent: (type: string, listener: (event: RealtimeEvent) => void) => {
      useEffect(() => {
        const set = listeners.get(type) ?? new Set();
        set.add(listener);
        listeners.set(type, set);
        return () => void set.delete(listener);
      }, [type, listener]);
    },
  };
});

import { RAIL_COUNTS_DEBOUNCE_MS, RailUnreadCounts, useRailCounts } from './rail-counts';

const VIEWS = ['queue', 'mine', 'gotcha'] as const;
const fire = (type: string) => {
  for (const listener of listeners.get(type) ?? []) {
    listener({ type, tenantId: 't1', at: 0, conversationId: 'c1' } as unknown as RealtimeEvent);
  }
};

/** The rail's view of the store, drawn so a test can read it. */
function Rail() {
  return <output data-testid="rail">{JSON.stringify(useRailCounts())}</output>;
}
const seen = () => JSON.parse(screen.getByTestId('rail').textContent ?? 'null') as unknown;
const mount = () =>
  render(
    <>
      <Rail />
      <RailUnreadCounts views={VIEWS} />
    </>,
  );
const settle = () => act(async () => {});

beforeEach(() => {
  vi.useFakeTimers();
  get.mockReset();
  get.mockResolvedValue({ queue: 2, mine: 1, gotcha: 0 });
  listeners.clear();
});
afterEach(() => vi.useRealTimers());

describe('★★ one read on load, every view in one call', () => {
  it('reads once, with every view, and the rail gets the numbers', async () => {
    mount();
    await settle();
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0]![0]).toMatchObject({ query: { views: 'queue,mine,gotcha' } });
    expect(seen()).toEqual({ queue: 2, mine: 1, gotcha: 0 });
  });

  it('a re-render does not read again - only events do', async () => {
    const { rerender } = mount();
    await settle();
    rerender(
      <>
        <Rail />
        <RailUnreadCounts views={VIEWS} />
      </>,
    );
    await settle();
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe('★★ then one read per burst of events', () => {
  it.each(['message.received', 'conversation.updated', 'conversation.closed'])(
    '%s: read again after the debounce',
    async (type) => {
      mount();
      await settle();
      act(() => fire(type));
      expect(get).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTime(RAIL_COUNTS_DEBOUNCE_MS));
      expect(get).toHaveBeenCalledTimes(2);
    },
  );

  it('★★ a burst of five events is one read, after the last can have landed', async () => {
    mount();
    await settle();
    act(() => {
      fire('message.received');
      fire('conversation.updated');
      fire('message.received');
    });
    await act(async () => vi.advanceTimersByTime(RAIL_COUNTS_DEBOUNCE_MS / 2));
    act(() => {
      fire('conversation.updated');
      fire('message.received');
    });
    await act(async () => vi.advanceTimersByTime(RAIL_COUNTS_DEBOUNCE_MS));
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe('⚠ no count is never a 0, and an old answer never wins', () => {
  it('a 404 (not deployed) or a failure: the rail draws nothing', async () => {
    get.mockRejectedValueOnce(new ApiError({ kind: 'not_found', status: 404 }));
    mount();
    await settle();
    expect(seen()).toBeNull();
  });

  it('a read that fails after one that worked takes the numbers away, not leaves them stale', async () => {
    mount();
    await settle();
    expect(seen()).toEqual({ queue: 2, mine: 1, gotcha: 0 });
    get.mockRejectedValueOnce(new ApiError({ kind: 'server', status: 503 }));
    act(() => fire('message.received'));
    await act(async () => vi.advanceTimersByTime(RAIL_COUNTS_DEBOUNCE_MS));
    expect(seen()).toBeNull();
  });

  it('★ a slow early read that lands after a newer one is dropped', async () => {
    let answerFirst!: (value: unknown) => void;
    get.mockReset();
    get
      .mockImplementationOnce(() => new Promise((resolve) => (answerFirst = resolve)))
      .mockResolvedValueOnce({ queue: 5 });
    mount();
    act(() => fire('message.received'));
    await act(async () => vi.advanceTimersByTime(RAIL_COUNTS_DEBOUNCE_MS));
    expect(seen()).toEqual({ queue: 5 });
    await act(async () => answerFirst({ queue: 9 }));
    expect(seen()).toEqual({ queue: 5 });
  });

  it('★ leaving the inbox clears the rail and cancels a pending read', async () => {
    const { unmount } = mount();
    await settle();
    act(() => fire('message.received'));
    unmount();
    render(<Rail />);
    expect(seen()).toBeNull();
    await act(async () => vi.advanceTimersByTime(RAIL_COUNTS_DEBOUNCE_MS * 2));
    expect(get).toHaveBeenCalledTimes(1);
  });
});
