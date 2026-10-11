import { render } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RealtimeEvent, RealtimeEventType } from '@/realtime/events';
import type { ConnectionState } from '@/realtime/transport';

import { GATHER_MS, WINDOW_MS } from './live-refresh';
import { ListLive } from './ListLive';

/**
 * The inbox re-reads itself on the platform's events - the list as well as
 * the open conversation, and with no conversation open at all.
 *
 * Omer, 2026-10-11: new messages did not appear in the list without a
 * reload, and two new Instagram conversations did not appear at all - the
 * only listener re-read for the open conversation and nothing else.
 */

const refresh = vi.hoisted(() => vi.fn());
const router = vi.hoisted(() => ({ refresh }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

/** The listeners `useRealtimeEvent` registered, so a frame can be delivered. */
const listeners = vi.hoisted(() => new Map<string, ((event: RealtimeEvent) => void)[]>());
const connection = vi.hoisted(() => ({ state: 'connected' as ConnectionState }));
vi.mock('@/realtime/realtime-provider', () => ({
  useRealtimeEvent: (type: RealtimeEventType, listener: (event: RealtimeEvent) => void) => {
    // One call site per type in ListLive: a re-render replaces, it does not add.
    listeners.set(type, [listener]);
  },
  useRealtimeConnectionState: () => connection.state,
}));

const deliver = (event: RealtimeEvent) => {
  for (const listener of listeners.get(event.type) ?? []) listener(event);
};

const received = (conversationId: string, messageId: string): RealtimeEvent => ({
  type: 'message.received',
  tenantId: 't1',
  at: 0,
  conversationId,
  messageId,
  direction: 'INBOUND',
  body: 'hi',
  messageType: 'text',
});
const updated = (conversationId: string): RealtimeEvent => ({
  type: 'conversation.updated',
  tenantId: 't1',
  at: 0,
  conversationId,
});
const closed = (conversationId: string): RealtimeEvent => ({
  type: 'conversation.closed',
  tenantId: 't1',
  at: 0,
  conversationId,
});
const status = (conversationId: string): RealtimeEvent => ({
  type: 'message.delivery_changed',
  tenantId: 't1',
  at: 0,
  conversationId,
  messageId: 'm1',
});

let visibility: DocumentVisibilityState = 'visible';
const setVisibility = (next: DocumentVisibilityState) => {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
};

const settle = () => act(() => vi.advanceTimersByTime(GATHER_MS));
const closeWindow = () => act(() => vi.advanceTimersByTime(WINDOW_MS));

beforeEach(() => {
  vi.useFakeTimers();
  refresh.mockReset();
  listeners.clear();
  connection.state = 'connected';
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('★★ with no conversation open, the list re-reads on each event', () => {
  it.each([
    ['a message in any conversation', received('c7', 'm1')],
    ['a conversation changed', updated('c7')],
    ['a conversation closed', closed('c7')],
  ])('★★ %s', (_, event) => {
    render(<ListLive openId={null} />);
    act(() => deliver(event));
    expect(refresh).not.toHaveBeenCalled();
    settle();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  /*
   * ★★ THE MAIN COMPLAINT ("like WhatsApp Web"): with a conversation open,
   *   another conversation's news still re-reads the list beside it.
   *   StreamLive filtered every one of these out.
   */
  it.each([
    ['a message', received('c2', 'm1')],
    ['a change', updated('c2')],
    ['a close', closed('c2')],
  ])('★★ with c1 open, %s in c2 re-reads the list', (_, event) => {
    render(<ListLive openId="c1" />);
    act(() => deliver(event));
    settle();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('★ a delivery change re-reads only for the open conversation', () => {
    render(<ListLive openId="c1" />);
    act(() => deliver(status('c2')));
    act(() => vi.advanceTimersByTime(5_000));
    expect(refresh).not.toHaveBeenCalled();
    act(() => deliver(status('c1')));
    settle();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('★ with nothing open, no delivery change re-reads', () => {
    render(<ListLive openId={null} />);
    act(() => deliver(status('c1')));
    act(() => vi.advanceTimersByTime(5_000));
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('★★ a burst is one read per window, and the last event is read', () => {
  it('★★ an inbound message on the open conversation is three frames and ONE read', () => {
    /*
     * message:new, conversation:updated, and a status - what StreamLive and
     * a list listener would each have re-read for. One scheduler, one read.
     */
    render(<ListLive openId="c1" />);
    act(() => {
      deliver(received('c1', 'm1'));
      deliver(updated('c1'));
      deliver(updated('c1')); // emitToTenant: direct, then the bus copy
      deliver(status('c1'));
    });
    settle();
    expect(refresh).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(10_000));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('★★ an event after the read, inside its window, gets a trailing read', () => {
    render(<ListLive openId={null} />);
    act(() => deliver(received('c1', 'm1')));
    settle();
    expect(refresh).toHaveBeenCalledTimes(1);
    // lands while the first read is in flight
    act(() => vi.advanceTimersByTime(100));
    act(() => deliver(received('c2', 'm2')));
    act(() => deliver(received('c3', 'm3')));
    // no second read inside the window…
    act(() => vi.advanceTimersByTime(WINDOW_MS - 200));
    expect(refresh).toHaveBeenCalledTimes(1);
    // …and one when it closes, for both
    act(() => vi.advanceTimersByTime(100));
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('★ a long burst is one read per window, never one per event', () => {
    render(<ListLive openId={null} />);
    for (let i = 0; i < 40; i += 1) {
      act(() => deliver(received('c1', `m${i}`)));
      act(() => vi.advanceTimersByTime(100));
    }
    // 4s of events: the first read, then one per 1s window
    expect(refresh.mock.calls.length).toBeLessThanOrEqual(5);
    expect(refresh.mock.calls.length).toBeGreaterThanOrEqual(4);
    const before = refresh.mock.calls.length;
    closeWindow();
    // the last of them is read
    expect(refresh).toHaveBeenCalledTimes(before + 1);
    closeWindow();
    expect(refresh).toHaveBeenCalledTimes(before + 1);
  });

  it('★ the same message announced twice (direct, then via the bus) re-reads once', () => {
    render(<ListLive openId={null} />);
    act(() => deliver(received('c1', 'm5')));
    settle();
    closeWindow();
    act(() => deliver(received('c1', 'm5')));
    act(() => vi.advanceTimersByTime(5_000));
    expect(refresh).toHaveBeenCalledTimes(1);
    act(() => deliver(received('c1', 'm6')));
    settle();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('★ refreshes again later, rather than only once ever', () => {
    render(<ListLive openId={null} />);
    act(() => deliver(updated('c1')));
    settle();
    closeWindow();
    act(() => deliver(updated('c1')));
    settle();
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

describe('★★ a hidden tab is read once, when it is shown', () => {
  it('★★ events while hidden: no read until visible, then exactly one', () => {
    render(<ListLive openId={null} />);
    act(() => setVisibility('hidden'));
    act(() => {
      deliver(received('c1', 'm1'));
      deliver(updated('c2'));
    });
    act(() => vi.advanceTimersByTime(60_000));
    expect(refresh).not.toHaveBeenCalled();
    act(() => setVisibility('visible'));
    settle();
    expect(refresh).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(10_000));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('★★ hidden after the event but before its read: the read waits for visible', () => {
    render(<ListLive openId={null} />);
    act(() => deliver(received('c1', 'm1')));
    act(() => setVisibility('hidden'));
    act(() => vi.advanceTimersByTime(60_000));
    expect(refresh).not.toHaveBeenCalled();
    act(() => setVisibility('visible'));
    settle();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('★ shown with nothing new: no read', () => {
    render(<ListLive openId={null} />);
    act(() => setVisibility('hidden'));
    act(() => setVisibility('visible'));
    act(() => vi.advanceTimersByTime(5_000));
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('★ an open menu holds the read until it closes', () => {
  it('★ the queue menu open: no read; closed: read at the next window', () => {
    render(<ListLive openId={null} />);
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    document.body.append(menu);
    act(() => deliver(received('c1', 'm1')));
    act(() => vi.advanceTimersByTime(10_000));
    expect(refresh).not.toHaveBeenCalled();
    menu.remove();
    closeWindow();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('★ back from a dropped socket, the page is read', () => {
  it('★ reconnecting → connected re-reads; staying connected does not', () => {
    const { rerender } = render(<ListLive openId={null} />);
    act(() => vi.advanceTimersByTime(5_000));
    expect(refresh).not.toHaveBeenCalled();
    connection.state = 'reconnecting';
    rerender(<ListLive openId={null} />);
    connection.state = 'connected';
    rerender(<ListLive openId={null} />);
    settle();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('★ lifecycle', () => {
  it('★★ a read scheduled as the screen unmounts does not run', () => {
    const { unmount } = render(<ListLive openId={null} />);
    act(() => deliver(received('c1', 'm1')));
    unmount();
    act(() => vi.advanceTimersByTime(5_000));
    expect(refresh).not.toHaveBeenCalled();
  });

  it('★ renders nothing', () => {
    const { container } = render(<ListLive openId="c1" />);
    expect(container).toBeEmptyDOMElement();
  });
});
