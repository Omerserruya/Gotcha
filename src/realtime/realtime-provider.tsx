'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import { clientEnv } from '@/config/env.client';
import { logger } from '@/observability/logger';

import type { RealtimeEventType } from './events';
import { SocketTransport } from './socket-transport';
import type { ConnectionState, RealtimeListener, RealtimeTransport } from './transport';

const RealtimeContext = createContext<RealtimeTransport | null>(null);

export function RealtimeProvider({
  tenantId,
  children,
}: {
  tenantId: string | null;
  children: ReactNode;
}) {
  // Recreated per tenant: a transport carries tenant-scoped subscriptions, so
  // reusing one across a switch would mean re-filtering someone else's stream.
  const transport = useMemo<RealtimeTransport | null>(() => {
    if (!tenantId || !clientEnv.REALTIME_URL) return null;
    return new SocketTransport({
      url: clientEnv.REALTIME_URL,
      tenantId,
      /*
       * A fresh ticket per connection attempt. Tickets are single-use and
       * expire in 60 seconds, so one cannot be cached or reused across a
       * reconnect — every attempt mints its own.
       */
      credentials: async () => {
        try {
          const response = await fetch('/api/realtime/ticket', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
          });
          if (!response.ok) return null;
          const { ticket } = (await response.json()) as { ticket?: string };
          return ticket ? { ticket, tenantId } : null;
        } catch (cause) {
          logger.warn('realtime.ticket_request_failed', { cause });
          return null;
        }
      },
    });
  }, [tenantId]);

  useEffect(() => {
    transport?.connect();
    return () => transport?.disconnect();
  }, [transport]);

  return <RealtimeContext.Provider value={transport}>{children}</RealtimeContext.Provider>;
}

/**
 * Subscribes to one realtime event type for the lifetime of the component.
 *
 * The listener is held in a ref-free closure deliberately: callers pass a
 * stable callback (usually a query invalidation), and re-subscribing on every
 * render would churn the transport.
 */
export function useRealtimeEvent(type: RealtimeEventType, listener: RealtimeListener): void {
  const transport = useContext(RealtimeContext);
  useEffect(() => transport?.on(type, listener), [transport, type, listener]);
}

/**
 * The transport's connection state.
 *
 * `useSyncExternalStore` rather than an effect plus `setState`: the socket is
 * an external store, and this is the primitive for reading one. It also gets
 * the server render right for free - there is no socket during SSR, so the
 * server snapshot is always `idle`.
 */
export function useRealtimeConnectionState(): ConnectionState {
  const transport = useContext(RealtimeContext);

  const subscribe = useCallback(
    (onChange: () => void) => transport?.onStateChange(onChange) ?? (() => {}),
    [transport],
  );
  const getSnapshot = useCallback(() => transport?.state ?? 'idle', [transport]);

  return useSyncExternalStore(subscribe, getSnapshot, () => 'idle' as const);
}
