'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef } from 'react';

import type { RealtimeEvent } from '@/realtime/events';
import { useRealtimeConnectionState, useRealtimeEvent } from '@/realtime/realtime-provider';

import { refreshScheduler, type RefreshScheduler } from './live-refresh';

/**
 * Keeps the inbox current - the list and the open conversation - by
 * re-reading the page when the platform says something changed.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ NEW MESSAGES DID NOT APPEAR IN THE LIST WITHOUT A RELOAD (Omer, 2026-10-11)
 * ════════════════════════════════════════════════════════════════════════════
 * The socket was connected and the frames arrived. The only listener was
 * StreamLive, which re-read for the OPEN conversation and nothing else - so
 * rows, previews, order, the view's total and brand-new conversations (two
 * Instagram ones that day) waited for somebody to press reload, and with no
 * conversation open nothing listened at all.
 *
 * ── ONE READ, ONE SCHEDULER, FOR THE WHOLE PAGE ──
 * `router.refresh()` re-runs the server render, so the rows, their order, the
 * previews, the total and the open conversation all come from one read. This
 * replaces StreamLive (mounted only here) rather than sitting beside it: two
 * components each refreshing on the same frame is two server renders per
 * message, and two timers cannot coalesce with each other.
 *
 * ── WHAT IS NEWS ──
 *   message.received        any conversation - once per message: an agent's
 *                           own send is announced twice (directly, then via
 *                           the bus), and the second can land after a window.
 *   conversation.updated    any conversation: owner, status, department, the
 *   conversation.closed     last message's time - all things the list shows.
 *   message.delivery_changed  only the open conversation's: ticks show in the
 *                           stream, and on a busy tenant every status of
 *                           every message would re-render the screen.
 *   a reconnect             frames sent while the socket was down are gone;
 *                           the page is read once it is back.
 *
 * ── WHAT A RE-READ KEEPS ──
 * The App Router merges the new payload "without losing unaffected
 * client-side React (e.g. useState) or browser state (e.g. scroll position)"
 * (next/dist/docs, use-router `refresh()`). Rows are keyed by conversation,
 * so the composer's text (state, and the per-conversation draft in session
 * storage), the shift-click selection (a module store), a pending click and
 * the scroll all survive. One thing does not agree with a re-read rather than
 * being lost by it: an open queue menu's items were planned from the rows as
 * they were, so the read waits until it closes (`held`).
 */

/** How many message ids are remembered for the once-per-message rule. */
const SEEN_LIMIT = 500;

/** An open menu (the queue's right-click menu, any other): see `held` in `live-refresh`. */
const OPEN_MENU = '[role="menu"]';

export function ListLive({ openId }: { readonly openId: string | null }) {
  const router = useRouter();
  /*
   * The scheduler is made once per mount and reads the router through a ref:
   * remade on a new router object, it would drop a read it owes.
   */
  const routerRef = useRef(router);
  useEffect(() => {
    routerRef.current = router;
  }, [router]);
  const scheduler = useRef<RefreshScheduler | null>(null);

  useEffect(() => {
    const current = refreshScheduler({
      refresh: () => routerRef.current.refresh(),
      hidden: () => document.visibilityState === 'hidden',
      held: () => document.querySelector(OPEN_MENU) !== null,
    });
    scheduler.current = current;
    const onVisibility = () => {
      if (document.visibilityState !== 'hidden') current.shown();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      // A read scheduled as the screen unmounts would run against a gone route.
      current.stop();
      if (scheduler.current === current) scheduler.current = null;
    };
  }, []);

  const poke = useCallback(() => scheduler.current?.poke(), []);

  const seen = useRef(new Set<string>());
  useRealtimeEvent(
    'message.received',
    useCallback(
      (event: RealtimeEvent) => {
        if (event.type !== 'message.received') return;
        if (seen.current.has(event.messageId)) return;
        // Bounded: an inbox left open all day must not grow without end.
        if (seen.current.size >= SEEN_LIMIT) seen.current.clear();
        seen.current.add(event.messageId);
        poke();
      },
      [poke],
    ),
  );

  useRealtimeEvent('conversation.updated', poke);
  useRealtimeEvent('conversation.closed', poke);

  useRealtimeEvent(
    'message.delivery_changed',
    useCallback(
      (event: RealtimeEvent) => {
        if (event.type !== 'message.delivery_changed') return;
        if (event.conversationId !== openId) return;
        poke();
      },
      [openId, poke],
    ),
  );

  /*
   * ★ BACK FROM A DROP. A frame sent while the socket was down never arrives,
   *   and the laptop that slept is exactly the one whose list is oldest. Any
   *   arrival at `connected` from another state while mounted - including the
   *   first, which closes the gap between the server's render and the socket.
   */
  const state = useRealtimeConnectionState();
  const previous = useRef(state);
  useEffect(() => {
    if (state === 'connected' && previous.current !== 'connected') poke();
    previous.current = state;
  }, [state, poke]);

  return null;
}
