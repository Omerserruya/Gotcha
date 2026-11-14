'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef } from 'react';

import { refreshScheduler, type RefreshScheduler } from '@/features/inbox/live-refresh';
import { useRealtimeConnectionState, useRealtimeEvent } from '@/realtime/realtime-provider';

/**
 * Keeps the phone's approvals current: re-reads the page when a request is
 * written (`approval.requested`) or leaves the queue (`approval.resolved` -
 * decided here, on the website or on WhatsApp, or lapsed), and once after a
 * dropped socket comes back, since the frames sent meanwhile are gone.
 *
 * ★ THE INBOX'S SCHEDULER (`ListLive`), not a second one: a burst of frames
 *   is one `router.refresh()`, nothing is read while the app is in the
 *   background (it reads once on return), and a sheet left open (Reject's
 *   reasons) holds the read until it closes, so it is not re-drawn under a
 *   finger. A re-read keeps client state, so a decision in flight survives.
 *
 * Renders nothing.
 */
export function ApprovalsLive() {
  const router = useRouter();
  const routerRef = useRef(router);
  useEffect(() => {
    routerRef.current = router;
  }, [router]);
  const scheduler = useRef<RefreshScheduler | null>(null);

  useEffect(() => {
    const current = refreshScheduler({
      refresh: () => routerRef.current.refresh(),
      hidden: () => document.visibilityState === 'hidden',
      held: () => document.querySelector('[role="dialog"]') !== null,
    });
    scheduler.current = current;
    const onVisibility = () => {
      if (document.visibilityState !== 'hidden') current.shown();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      current.stop();
      if (scheduler.current === current) scheduler.current = null;
    };
  }, []);

  const poke = useCallback(() => scheduler.current?.poke(), []);
  useRealtimeEvent('approval.requested', poke);
  useRealtimeEvent('approval.resolved', poke);

  // Back from a drop, not the first connect (see `ListLive`).
  const state = useRealtimeConnectionState();
  const previous = useRef(state);
  const beenConnected = useRef(state === 'connected');
  useEffect(() => {
    if (state === 'connected' && previous.current !== 'connected') {
      if (beenConnected.current) poke();
      beenConnected.current = true;
    }
    previous.current = state;
  }, [state, poke]);

  return null;
}
