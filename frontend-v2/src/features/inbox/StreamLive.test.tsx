import { render } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RealtimeEvent, RealtimeEventType } from '@/realtime/events';

import { StreamLive } from './StreamLive';

/**
 * What makes the composer's promise true.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * A SEND ANSWERS 201 WITH THE ROW AT `PENDING`
 * ════════════════════════════════════════════════════════════════════════════
 * Everything after that happens in the outgoing worker and the provider webhook.
 * `revalidatePath` re-reads once, at send time, when there is nothing new to see -
 * so without this the stream shows `PENDING` for ever and the composer's *"it will
 * say so if it fails"* is a sentence we wrote rather than a behaviour.
 */

const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

/** The listeners `useRealtimeEvent` registered, so a frame can be delivered. */
const listeners = vi.hoisted(() => new Map<string, ((event: RealtimeEvent) => void)[]>());
vi.mock('@/realtime/realtime-provider', () => ({
  useRealtimeEvent: (type: RealtimeEventType, listener: (event: RealtimeEvent) => void) => {
    const existing = listeners.get(type) ?? [];
    if (!existing.includes(listener)) listeners.set(type, [...existing, listener]);
  },
}));

const deliver = (event: RealtimeEvent) => {
  for (const listener of listeners.get(event.type) ?? []) listener(event);
};

const statusEvent = (conversationId: string): RealtimeEvent => ({
  type: 'message.delivery_changed',
  tenantId: 't1',
  at: Date.now(),
  conversationId,
  messageId: 'm1',
});

beforeEach(() => {
  vi.useFakeTimers();
  refresh.mockReset();
  listeners.clear();
});
afterEach(() => vi.useRealTimers());

describe('★★ a delivery change re-reads the conversation', () => {
  it('★★ refreshes when this conversation’s message changes', () => {
    render(<StreamLive conversationId="c1" />);
    act(() => deliver(statusEvent('c1')));
    expect(refresh).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(800));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('★★ ignores another conversation entirely', () => {
    /*
     * The platform emits to `tenant:<id>`, not to a conversation. On a busy tenant
     * that is every message everywhere, and refreshing on somebody else's customer
     * would re-render this screen continuously.
     */
    render(<StreamLive conversationId="c1" />);
    act(() => deliver(statusEvent('c2')));
    act(() => vi.advanceTimersByTime(5_000));
    expect(refresh).not.toHaveBeenCalled();
  });

  it('★★ coalesces a burst into one re-read', () => {
    /*
     * One message goes SENT, then DELIVERED, then READ. Three frames, one
     * re-render - and the screen ends up showing the last state either way.
     */
    render(<StreamLive conversationId="c1" />);
    act(() => {
      deliver(statusEvent('c1'));
      deliver(statusEvent('c1'));
      deliver(statusEvent('c1'));
    });
    act(() => vi.advanceTimersByTime(800));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('★ refreshes again for a later change, rather than only once ever', () => {
    // The coalescing window must close. A latch would leave the screen stale for
    // the rest of the session after one refresh.
    render(<StreamLive conversationId="c1" />);
    act(() => deliver(statusEvent('c1')));
    act(() => vi.advanceTimersByTime(800));
    act(() => deliver(statusEvent('c1')));
    act(() => vi.advanceTimersByTime(800));
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('★★ an inbound reply also re-reads, so nobody answers a superseded message', () => {
    render(<StreamLive conversationId="c1" />);
    act(() =>
      deliver({
        type: 'message.received',
        tenantId: 't1',
        at: Date.now(),
        conversationId: 'c1',
        messageId: 'm2',
      }),
    );
    act(() => vi.advanceTimersByTime(800));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('★★ a refresh scheduled as the screen unmounts does not run', () => {
    /*
     * Navigating away between the frame and the timer would refresh a route that
     * is gone. Cheap to prevent and the kind of thing that shows up as an
     * unexplained re-render on another screen.
     */
    const { unmount } = render(<StreamLive conversationId="c1" />);
    act(() => deliver(statusEvent('c1')));
    unmount();
    act(() => vi.advanceTimersByTime(5_000));
    expect(refresh).not.toHaveBeenCalled();
  });

  it('★ renders nothing', () => {
    const { container } = render(<StreamLive conversationId="c1" />);
    expect(container).toBeEmptyDOMElement();
  });
});
