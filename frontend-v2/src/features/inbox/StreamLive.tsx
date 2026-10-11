'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef } from 'react';

import { useRealtimeEvent } from '@/realtime/realtime-provider';

/**
 * Keeps the open conversation current, so the composer's promise is true.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THE COMPOSER SAYS "IT WILL SAY SO IF IT FAILS". THIS IS WHAT MAKES THAT SO.
 * ════════════════════════════════════════════════════════════════════════════
 * A send answers 201 with the row at `PENDING`. Everything after that -
 * `SENT`, `DELIVERED`, `FAILED` - happens asynchronously, in the outgoing worker
 * and the provider webhook. `revalidatePath` re-reads once, at send time, when
 * there is nothing new to see.
 *
 * So without this the stream shows `PENDING` for ever and the copy is a lie. Not
 * a comment's lie, which only misleads a developer: a sentence in the product,
 * read by somebody deciding whether a customer has their answer.
 *
 * ── IT REFRESHES THE ROUTE RATHER THAN PATCHING A MESSAGE ──
 * `router.refresh()` re-runs the server render, so the stream, the queue row and
 * the header all come from one read. Patching a status into client state would be
 * a second source of truth for delivery, on the screen where being wrong about
 * delivery is the whole hazard - and it would be a status this app decided rather
 * than one the platform reported.
 *
 * ── FILTERED AND DEBOUNCED, BECAUSE THE EVENT IS TENANT-WIDE ──
 * The platform emits to `tenant:<id>`, not to a conversation. On a busy tenant
 * that is every message everywhere, and a refresh each time would re-render this
 * screen continuously. Two guards: the conversation must match, and refreshes
 * coalesce into one per interval. A burst of four status changes for one message
 * - `SENT`, then `DELIVERED`, then `READ` - is one re-read.
 */

/**
 * Long enough to coalesce a provider's burst, short enough that a person who has
 * just pressed send sees the result without wondering. Not a poll: nothing fires
 * unless an event arrives.
 */
const COALESCE_MS = 800;

/** How many message ids are remembered for the once-per-message rule. */
const SEEN_LIMIT = 500;

export function StreamLive({ conversationId }: { readonly conversationId: string }) {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* A refresh scheduled as the screen unmounts would run against a gone route. */
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const schedule = useCallback(() => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      router.refresh();
    }, COALESCE_MS);
  }, [router]);

  const forThisConversation = useCallback(
    (event: { conversationId?: string }) => {
      if (event.conversationId !== conversationId) return;
      schedule();
    },
    [conversationId, schedule],
  );

  useRealtimeEvent(
    'message.delivery_changed',
    useCallback(
      (event) => {
        if (event.type !== 'message.delivery_changed') return;
        forThisConversation(event);
      },
      [forThisConversation],
    ),
  );

  /*
   * An inbound reply while the agent is reading. Same refresh: a customer
   * answering is the other thing that makes this screen stale, and an agent
   * writing a reply to a message that has already been superseded is the failure
   * it prevents.
   *
   * ★ ONCE PER MESSAGE. An agent's own send is announced twice - directly and
   * again through the bus (Backend, 2026-10-11) - and the second can land after
   * the coalescing window has closed. A message already seen is not news.
   */
  const seen = useRef(new Set<string>());
  useRealtimeEvent(
    'message.received',
    useCallback(
      (event) => {
        if (event.type !== 'message.received') return;
        if (event.conversationId !== conversationId) return;
        if (seen.current.has(event.messageId)) return;
        // Bounded: a conversation left open all day must not grow without end.
        if (seen.current.size >= SEEN_LIMIT) seen.current.clear();
        seen.current.add(event.messageId);
        forThisConversation(event);
      },
      [conversationId, forThisConversation],
    ),
  );

  return null;
}
