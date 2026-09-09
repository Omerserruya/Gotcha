/**
 * Normalised realtime events.
 *
 * Features subscribe to these, never to socket frames. Two reasons:
 *
 *  - The transport is replaceable. The gateway speaks Socket.IO today; if it
 *    becomes SSE or something else, only `socket-transport.ts` changes.
 *  - Wire event names are the backend's vocabulary, not the product's. A
 *    component that listens for `"msg:new"` has quietly taken a dependency on
 *    a string nobody owns.
 *
 * ── Contract status ───────────────────────────────────────────────────────
 * The gateway is live (Socket.IO / Engine.IO v4), but the platform's OpenAPI
 * document covers Express routes only, so the event catalogue, payload shapes,
 * room/namespace conventions and handshake auth are **not documented
 * anywhere**. This union therefore describes the events the product will need,
 * as the boundary they must be mapped onto. `translators` below is where that
 * mapping goes, once the backend publishes the contract - see docs/api-gaps.md.
 * ──────────────────────────────────────────────────────────────────────────
 */

/** Every event carries the tenant it belongs to, so stale ones can be dropped. */
interface RealtimeEventBase {
  readonly tenantId: string;
  /** Server timestamp, epoch milliseconds. */
  readonly at: number;
}

export type RealtimeEvent =
  | (RealtimeEventBase & { type: 'conversation.updated'; conversationId: string })
  | (RealtimeEventBase & {
      type: 'conversation.assigned';
      conversationId: string;
      assigneeId: string | null;
    })
  | (RealtimeEventBase & { type: 'message.received'; conversationId: string; messageId: string })
  | (RealtimeEventBase & {
      type: 'message.delivery_changed';
      conversationId: string;
      messageId: string;
    })
  | (RealtimeEventBase & { type: 'approval.requested'; approvalId: string })
  | (RealtimeEventBase & { type: 'approval.resolved'; approvalId: string })
  | (RealtimeEventBase & { type: 'ai.activity'; conversationId: string })
  | (RealtimeEventBase & { type: 'presence.changed'; userId: string });

export type RealtimeEventType = RealtimeEvent['type'];

/**
 * Maps one wire frame onto a domain event, or returns null to ignore it.
 *
 * Deliberately empty: inventing event names would produce a listener that
 * silently never fires, which is worse than one that does not exist. Each
 * entry is added when the backend contract for that event is confirmed.
 */
export type EventTranslator = (wireEvent: string, payload: unknown) => RealtimeEvent | null;

export const translators: readonly EventTranslator[] = [];

export function translate(wireEvent: string, payload: unknown): RealtimeEvent | null {
  for (const translator of translators) {
    const event = translator(wireEvent, payload);
    if (event) return event;
  }
  return null;
}
