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
  | (RealtimeEventBase & { type: 'presence.changed'; userId: string })
  /**
   * One FINAL utterance of a live call. Interim results are not published.
   *
   * `speaker` is the separation the call screen renders on; `seq` orders
   * utterances independently of arrival, because the stream reassembles
   * out-of-order fragments (`transcript/reorder-buffer.ts`) and nothing
   * guarantees the socket preserves that order end to end.
   */
  | (RealtimeEventBase & {
      type: 'call.transcript';
      conversationId: string;
      callSid: string;
      speaker: 'agent' | 'customer';
      text: string;
      seq: number;
      confidence: number | null;
    })
  /** Copilot's suggested replies, recomputed on each customer final. */
  | (RealtimeEventBase & {
      type: 'call.suggestions';
      conversationId: string;
      suggestions: readonly string[];
    })
  | (RealtimeEventBase & { type: 'call.ended'; conversationId: string });

export type RealtimeEventType = RealtimeEvent['type'];

/**
 * Maps one wire frame onto a domain event, or returns null to ignore it.
 *
 * Was deliberately empty: inventing event names would produce a listener that
 * silently never fires, which is worse than one that does not exist. Each
 * entry is added when the backend contract for that event is confirmed.
 *
 * ── THE FIRST ENTRIES, AND WHERE THEY CAME FROM ──
 * Read off the publishers, not guessed:
 *
 *   `voice.transcript`            stream-router.ts:57
 *   `voice.copilot.suggestions`   voice-assist.service.ts:192
 *   `voice.session.ended`         voice-copilot routes
 *
 * ── WHY `voice.copilot.suggestions` AND NOT `voice.frame.updated` ──
 * Both are published. The structured one is the newer design and it is **not**
 * the one to consume, in the words of the person who fixed it:
 *
 *   *"The legacy suggestions pipeline below was deleted with Phase 4 but its
 *   replacement turned out to be incomplete — the frontend kept showing zero
 *   copilot suggestions. Restored as a safety net."*
 *
 * So consuming only the structured channel reproduces a documented bug by
 * name. `voice.frame.updated` is not dead — `voice-flow-runner.ts` consumes
 * it to fire flow triggers — it simply is not yet the channel that reliably
 * produces user-facing suggestions. **Do not "upgrade" to it without checking
 * that comment again.**
 */
export type EventTranslator = (wireEvent: string, payload: unknown) => RealtimeEvent | null;

/** Narrow an unknown payload without trusting any of it. */
function field(payload: unknown, key: string): unknown {
  return typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>)[key]
    : undefined;
}

function str(payload: unknown, key: string): string | null {
  const value = field(payload, key);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export const translators: readonly EventTranslator[] = [
  (wireEvent, payload) => {
    if (wireEvent !== 'voice.transcript') return null;
    // The publisher nests the utterance under `data`.
    const data = field(payload, 'data') ?? payload;
    const tenantId = str(payload, 'tenantId') ?? str(data, 'tenantId');
    const conversationId = str(data, 'conversationId');
    const text = str(data, 'text');
    const speaker = str(data, 'speaker');
    // A frame missing any of these cannot be attributed to a call, and an
    // unattributable transcript line is one that could be rendered under the
    // wrong call. Dropped rather than guessed.
    if (!tenantId || !conversationId || !text) return null;
    if (speaker !== 'agent' && speaker !== 'customer') return null;

    const seq = field(data, 'seq');
    const confidence = field(data, 'confidence');
    return {
      type: 'call.transcript',
      tenantId,
      at: Date.now(),
      conversationId,
      callSid: str(data, 'callSid') ?? '',
      speaker,
      text,
      seq: typeof seq === 'number' ? seq : 0,
      confidence: typeof confidence === 'number' ? confidence : null,
    };
  },

  (wireEvent, payload) => {
    if (wireEvent !== 'voice.copilot.suggestions') return null;
    const data = field(payload, 'data') ?? payload;
    const tenantId = str(payload, 'tenantId') ?? str(data, 'tenantId');
    const conversationId = str(data, 'conversationId');
    if (!tenantId || !conversationId) return null;

    const raw = field(data, 'suggestions');
    return {
      type: 'call.suggestions',
      tenantId,
      at: Date.now(),
      conversationId,
      suggestions: Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string') : [],
    };
  },

  (wireEvent, payload) => {
    if (wireEvent !== 'voice.session.ended') return null;
    const data = field(payload, 'data') ?? payload;
    const tenantId = str(payload, 'tenantId') ?? str(data, 'tenantId');
    const conversationId = str(data, 'conversationId');
    if (!tenantId || !conversationId) return null;
    return { type: 'call.ended', tenantId, at: Date.now(), conversationId };
  },
];

export function translate(wireEvent: string, payload: unknown): RealtimeEvent | null {
  for (const translator of translators) {
    const event = translator(wireEvent, payload);
    if (event) return event;
  }
  return null;
}
