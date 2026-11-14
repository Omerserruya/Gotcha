'use client';

import { io, type Socket } from 'socket.io-client';

import { logger } from '@/observability/logger';
import { isSupportEnded } from '@/support/support-codes';

import { translate, type RealtimeEvent, type RealtimeEventType } from './events';

/** What the platform sends a support-mode socket when the session ends. */
const SUPPORT_ENDED_WIRE_EVENT = 'support:ended';
import type {
  ConnectionState,
  RealtimeCredentialProvider,
  RealtimeListener,
  RealtimeTransport,
} from './transport';

/**
 * The only module in the codebase that knows the gateway speaks Socket.IO.
 *
 * Events arriving for a tenant other than the active one are dropped rather
 * than delivered. A tenant switch and an in-flight event can otherwise race,
 * and the consequence - one workspace's activity appearing in another - is the
 * exact failure the tenancy rules exist to prevent.
 */
export class SocketTransport implements RealtimeTransport {
  private socket: Socket | null = null;
  private currentState: ConnectionState = 'idle';
  private readonly listeners = new Map<RealtimeEventType, Set<RealtimeListener>>();
  private readonly stateListeners = new Set<(state: ConnectionState) => void>();
  /** Conversation rooms asked for, counted: two screens on one conversation leave once. */
  private readonly rooms = new Map<string, number>();
  private supportEnded = false;

  constructor(
    private readonly options: {
      readonly url: string;
      readonly tenantId: string;
      readonly credentials: RealtimeCredentialProvider;
      /** Support mode ended: the handshake was refused, or the platform said so. */
      readonly onSupportEnded?: () => void;
    },
  ) {}

  get state(): ConnectionState {
    return this.currentState;
  }

  connect(): void {
    if (this.socket) return;
    this.setState('connecting');

    void this.options.credentials().then((auth) => {
      if (!auth) {
        // No handshake credential contract exists yet. Fail visibly in the
        // connection state rather than retrying forever against a closed door.
        logger.warn('realtime.credentials_unavailable');
        this.setState('failed');
        return;
      }

      const socket = io(this.options.url, {
        auth,
        // Skip the HTTP long-poll handshake: the gateway advertises a
        // websocket upgrade, and going straight there halves connect latency.
        transports: ['websocket'],
        withCredentials: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 15_000,
      });

      socket.on('connect', () => {
        this.setState('connected');
        /*
         * ★ EVERY CONNECT, NOT THE FIRST. A room is the server's memory of this
         *   socket, and a reconnect is a new socket: without asking again, a
         *   conversation open across a network blip goes quiet for good.
         */
        for (const conversationId of this.rooms.keys()) this.subscribe(conversationId);
      });
      socket.on('disconnect', () => {
        if (!this.supportEnded) this.setState('reconnecting');
      });
      socket.on('connect_error', (error) => {
        logger.warn('realtime.connect_error', { message: error.message });
        /*
         * ★ SUPPORT MODE ENDED: not a network fault to retry - no ticket of
         *   this session will ever be accepted again. Stopped, and handed up.
         */
        if (isSupportEnded(error.message)) {
          this.endSupport();
          return;
        }
        this.setState('reconnecting');
      });
      /*
       * ★★ ENDED WHILE CONNECTED (Backend ae81a9de): the console's end, a
       *   logout or the expiry sweep (up to 15s late) sends this, then closes
       *   the socket from the server - which never reconnects by itself. The
       *   event's name is the news; its code is not needed to act on it.
       */
      socket.on(SUPPORT_ENDED_WIRE_EVENT, () => this.endSupport());

      socket.onAny((wireEvent: string, payload: unknown) => {
        const event = translate(wireEvent, payload);
        if (!event) {
          logger.debug('realtime.untranslated_event', { wireEvent });
          return;
        }
        if (event.tenantId !== this.options.tenantId) return;
        this.dispatch(event);
      });

      this.socket = socket;
    });
  }

  /** Once: the event, the refused join and the refused handshake can all say it. */
  private endSupport(): void {
    if (this.supportEnded) return;
    this.supportEnded = true;
    this.socket?.disconnect();
    this.setState('failed');
    this.options.onSupportEnded?.();
  }

  disconnect(): void {
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    this.socket = null;
    this.setState('idle');
  }

  on(type: RealtimeEventType, listener: RealtimeListener): () => void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
    return () => set.delete(listener);
  }

  joinConversation(conversationId: string): () => void {
    const count = this.rooms.get(conversationId) ?? 0;
    this.rooms.set(conversationId, count + 1);
    if (count === 0 && this.socket?.connected) this.subscribe(conversationId);
    let left = false;
    return () => {
      if (left) return;
      left = true;
      const now = (this.rooms.get(conversationId) ?? 1) - 1;
      if (now > 0) {
        this.rooms.set(conversationId, now);
        return;
      }
      this.rooms.delete(conversationId);
      this.socket?.emit('unsubscribe:conversation', { conversationId });
    };
  }

  /**
   * The server answers with an ack, deliberately: a join that failed in
   * silence looks exactly like a conversation with nothing new. Logged, so it
   * is not silent here either.
   */
  private subscribe(conversationId: string): void {
    this.socket?.emit(
      'subscribe:conversation',
      { conversationId },
      (answer: { ok?: boolean; reason?: string } | undefined) => {
        if (answer?.ok) return;
        if (isSupportEnded(answer?.reason)) {
          this.endSupport();
          return;
        }
        logger.warn('realtime.conversation_join_refused', {
          reason: answer?.reason ?? 'no_answer',
        });
      },
    );
  }

  onStateChange(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private dispatch(event: RealtimeEvent): void {
    for (const listener of this.listeners.get(event.type) ?? []) {
      try {
        listener(event);
      } catch (cause) {
        logger.error('realtime.listener_failed', { type: event.type, cause });
      }
    }
  }

  private setState(state: ConnectionState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    for (const listener of this.stateListeners) listener(state);
  }
}
