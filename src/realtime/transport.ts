import type { RealtimeEvent, RealtimeEventType } from './events';

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

export type RealtimeListener = (event: RealtimeEvent) => void;

/**
 * What a realtime transport must do, expressed without reference to any
 * particular protocol. The React layer and every feature depend on this
 * interface; only one file depends on Socket.IO.
 */
export interface RealtimeTransport {
  connect(): void;
  disconnect(): void;
  readonly state: ConnectionState;
  /** Subscribes to one event type. Returns an unsubscribe function. */
  on(type: RealtimeEventType, listener: RealtimeListener): () => void;
  /** Subscribes to connection-state changes. Returns an unsubscribe function. */
  onStateChange(listener: (state: ConnectionState) => void): () => void;
  /**
   * Ask for one conversation's room (`conv:{id}`), where events scoped to it
   * are sent — the tenant room never carries them. Returns the leave.
   */
  joinConversation(conversationId: string): () => void;
}

/**
 * How the socket authenticates its handshake.
 *
 * The access token lives in an HttpOnly cookie precisely so that scripts
 * cannot read it — which equally means the browser cannot put it in a
 * handshake. `POST /api/realtime/ticket` resolves that: it mints a
 * short-lived, single-use credential the page may safely hold.
 *
 * Returning null keeps the transport dormant, which is what should happen if
 * the ticket cannot be obtained — a socket is not worth degrading the token's
 * confinement for.
 */
export interface RealtimeCredentialProvider {
  (): Promise<Record<string, string> | null>;
}
