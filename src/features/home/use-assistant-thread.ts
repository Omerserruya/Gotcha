'use client';

import { useLocale } from 'next-intl';
import { useCallback, useRef, useState } from 'react';
import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { browserApi } from '@/api/client/browser-api';
import { streamServerSentEvents, type SseFrame } from '@/api/client/sse-client';
import {
  DEFAULT_SCOPE,
  THREADS_CHANGED,
  eventSeq,
  parseThreadEvent,
  threadDetailSchema,
  threadSchema,
  type Thread,
  type ThreadScope,
} from '@/api/contracts/assistant-threads';
import { assistantEndpoints } from '@/api/endpoints/registry';
import { appPath } from '@/lib/base-path';
import { logger } from '@/observability/logger';

import { applyEvent, newTurn, problemOf, turnsFromMessages, type ThreadTurn } from './thread-turns';

/** How many times a dropped stream is picked up again before the turn says it failed. */
const RESUMES = 3;
/** After Stop, how long the stream has to say `cancelled` before it is let go. */
const CANCEL_GRACE_MS = 3000;

type Opening = 'idle' | 'opening' | 'missing' | 'failed';

/** A run's place, per turn: what a resume needs and whether it has ended. */
interface Progress {
  runId: string | null;
  messageId: string | null;
  lastSeq: number;
  done: boolean;
}

/** Through the BFF, under the base path - the stream is not a `browserApi` call. */
const bff = (path: string) => appPath(`/api/bff${path}` as `/${string}`);

/**
 * ★★ Home's conversation on `/api/assistant/threads` (design 7, 01a; Backend
 * aef95f69 + 6a4fd095).
 *
 * - A thread is created on the first question, carries the URL (`?thread=`),
 *   and is reopened from it - Recent links to it, a reload comes back to it.
 * - An answer streams; a dropped stream is RESUMED from the last event seen
 *   (`Last-Event-ID`), and a reload mid-answer replays the run from its
 *   start onto an empty turn. Every event carries its sequence and a turn
 *   applies each once, so neither doubles a word.
 * - Stop is the route's cancel: the answer really stops, the stream ends
 *   with `cancelled`, and the text so far is kept. Leaving does NOT cancel -
 *   the answer finishes on the server and is there when the thread reopens.
 */
export function useAssistantThread() {
  const [thread, setThreadState] = useState<Thread | null>(null);
  const [turns, setTurns] = useState<readonly ThreadTurn[]>([]);
  const [opening, setOpening] = useState<Opening>('idle');
  const [draftScope, setDraftScope] = useState<ThreadScope>(DEFAULT_SCOPE);
  const threadRef = useRef<Thread | null>(null);
  const scopeRef = useRef<ThreadScope>(DEFAULT_SCOPE);
  const abortRef = useRef<AbortController | null>(null);
  const progress = useRef(new Map<string, Progress>());
  // The interface language: steps, suggestions and the title come in it (the answer follows the question).
  const localeRef = useRef(useLocale());

  const setThread = (next: Thread | null) => {
    threadRef.current = next;
    setThreadState(next);
  };
  const update = (turnId: string, change: (turn: ThreadTurn) => ThreadTurn) =>
    setTurns((all) => all.map((turn) => (turn.id === turnId ? change(turn) : turn)));

  /** Reads one stream into a turn. `true` when the run said it ended. */
  const consume = async (turnId: string, frames: AsyncGenerator<SseFrame>) => {
    const place = progress.current.get(turnId)!;
    for await (const frame of frames) {
      const seq = eventSeq(frame.id);
      if (seq !== null && seq <= place.lastSeq) continue;
      if (seq !== null) place.lastSeq = seq;
      const event = parseThreadEvent(frame.event, frame.data);
      if (!event) continue;
      if (event.name === 'run.start') {
        place.runId = event.data.runId;
        place.messageId = event.data.messageId;
      } else if (event.name === 'thread.title' && threadRef.current) {
        setThread({ ...threadRef.current, title: event.data.title });
        announce();
      } else if (event.name === 'message.done') {
        place.done = true;
      }
      update(turnId, (turn) => applyEvent(turn, event, seq));
    }
    return place.done;
  };

  /**
   * Follows a run to its end, picking a dropped stream up where it stopped.
   * A refusal before the run started (409, 402, 429...) is thrown to the
   * caller, which words it; after 15 minutes (410) the stored thread is read.
   */
  const follow = async (
    turnId: string,
    threadId: string,
    first: AsyncGenerator<SseFrame>,
    signal: AbortSignal,
  ) => {
    const place = progress.current.get(turnId)!;
    let frames = first;
    let attempts = 0;
    for (;;) {
      const before = place.lastSeq;
      try {
        if (await consume(turnId, frames)) return;
      } catch (cause) {
        if (signal.aborted) return;
        if (place.runId === null) throw cause;
        if (isApiError(cause) && cause.status === 410) {
          await open(threadId);
          return;
        }
        if (isApiError(cause) && cause.status !== undefined && cause.status < 500) throw cause;
        logger.warn('assistant.stream_dropped', { cause });
      }
      if (signal.aborted) return;
      if (place.runId === null) throw new Error('The stream ended before the answer started.');
      if (place.lastSeq > before) attempts = 0;
      if (++attempts > RESUMES) throw new Error('The stream could not be picked up again.');
      await wait(400 * 2 ** (attempts - 1), signal);
      frames = streamServerSentEvents({
        url: bff(assistantEndpoints.runEvents(threadId, place.runId).path),
        method: 'GET',
        headers: { 'last-event-id': `${place.runId}:${place.lastSeq}` },
        signal,
      });
    }
  };

  const start = () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    return controller;
  };

  const ask = useCallback(async (question: string) => {
    const controller = start();
    const turnId = globalThis.crypto.randomUUID();
    progress.current.set(turnId, { runId: null, messageId: null, lastSeq: 0, done: false });
    setTurns((all) => [...all, newTurn(turnId, question)]);
    try {
      let current = threadRef.current;
      if (!current) {
        current = await browserApi.post({
          endpoint: assistantEndpoints.threads(),
          body: { scope: scopeRef.current },
          payload: threadSchema,
        });
        setThread(current);
        showInUrl(current.id);
        announce();
      }
      const frames = streamServerSentEvents({
        url: bff(assistantEndpoints.messages(current.id).path),
        body: { text: question, locale: localeRef.current },
        signal: controller.signal,
      });
      await follow(turnId, current.id, frames, controller.signal);
    } catch (cause) {
      if (controller.signal.aborted) return;
      logger.warn('assistant.ask_failed', { cause });
      update(turnId, (turn) => ({
        ...turn,
        status: 'failed',
        cancelling: false,
        problem: turn.problem ?? problemOf(cause),
      }));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs and stable setters only
  }, []);

  /** Stop: the route's cancel, then the stream's own `cancelled`. */
  const cancel = useCallback(async (turnId: string) => {
    const place = progress.current.get(turnId);
    const current = threadRef.current;
    const letGo = () => {
      abortRef.current?.abort();
      abortRef.current = null;
      update(turnId, (turn) =>
        turn.status === 'running' ? { ...turn, status: 'cancelled', cancelling: false } : turn,
      );
    };
    if (!place?.messageId || !current) {
      letGo();
      return;
    }
    update(turnId, (turn) => ({ ...turn, cancelling: true }));
    try {
      await browserApi.post({
        endpoint: assistantEndpoints.cancel(current.id, place.messageId),
        body: {},
        payload: z.object({ status: z.string() }),
      });
    } catch (cause) {
      logger.warn('assistant.cancel_failed', { cause });
    }
    setTimeout(() => {
      if (!place.done) letGo();
    }, CANCEL_GRACE_MS);
  }, []);

  /** Opens a stored thread; a run still writing is replayed from its start and followed. */
  const open = useCallback(async (threadId: string) => {
    const controller = start();
    setOpening('opening');
    setTurns([]);
    setThread(null);
    progress.current.clear();
    let detail;
    try {
      detail = await browserApi.get({
        endpoint: assistantEndpoints.thread(threadId),
        payload: threadDetailSchema,
      });
    } catch (cause) {
      if (controller.signal.aborted) return;
      setOpening(isApiError(cause) && cause.status === 404 ? 'missing' : 'failed');
      return;
    }
    if (controller.signal.aborted) return;
    const stored = turnsFromMessages(detail.messages);
    const active = detail.activeRun;
    const running = active ? stored.at(-1) : undefined;
    setThread(detail.thread);
    setTurns(
      running
        ? // The stored partial text is dropped: the replay below rebuilds it, once.
          [...stored.slice(0, -1), { ...running, answer: '', steps: [], status: 'running' }]
        : stored.map((turn) =>
            turn.status === 'running' ? { ...turn, status: 'failed' as const } : turn,
          ),
    );
    setOpening('idle');
    if (!active || !running) return;
    progress.current.set(running.id, {
      runId: active.runId,
      messageId: active.messageId,
      lastSeq: 0,
      done: false,
    });
    try {
      await follow(
        running.id,
        threadId,
        streamServerSentEvents({
          url: bff(assistantEndpoints.runEvents(threadId, active.runId).path),
          method: 'GET',
          headers: { 'last-event-id': `${active.runId}:0` },
          signal: controller.signal,
        }),
        controller.signal,
      );
    } catch (cause) {
      if (controller.signal.aborted) return;
      logger.warn('assistant.resume_failed', { cause });
      update(running.id, (turn) => ({ ...turn, status: 'failed', problem: problemOf(cause) }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs and stable setters only
  }, []);

  /** Back to Home. Nothing is cancelled: an answer still being written finishes on the server. */
  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    progress.current.clear();
    setTurns([]);
    setThread(null);
    setOpening('idle');
    scopeRef.current = DEFAULT_SCOPE;
    setDraftScope(DEFAULT_SCOPE);
    showInUrl(null);
  }, []);

  /** The person's title; the server never writes over it. `false` when it was not saved. */
  const rename = useCallback(async (title: string) => {
    const current = threadRef.current;
    if (!current) return false;
    try {
      setThread(
        await browserApi.patch({
          endpoint: assistantEndpoints.thread(current.id),
          body: { title },
          payload: threadSchema,
        }),
      );
      announce();
      return true;
    } catch (cause) {
      logger.warn('assistant.rename_failed', { cause });
      return false;
    }
  }, []);

  /** For the questions after it; before the first, it goes with the new thread. */
  const setScope = useCallback(async (scope: ThreadScope) => {
    const current = threadRef.current;
    if (!current) {
      scopeRef.current = scope;
      setDraftScope(scope);
      return true;
    }
    try {
      setThread(
        await browserApi.patch({
          endpoint: assistantEndpoints.thread(current.id),
          body: { scope },
          payload: threadSchema,
        }),
      );
      return true;
    } catch (cause) {
      logger.warn('assistant.scope_failed', { cause });
      return false;
    }
  }, []);

  /** Deletes the thread and its messages (a running answer is cancelled first, by the route). */
  const remove = useCallback(async () => {
    const current = threadRef.current;
    if (!current) return false;
    try {
      await browserApi.delete({
        endpoint: assistantEndpoints.thread(current.id),
        payload: z.unknown(),
      });
    } catch (cause) {
      logger.warn('assistant.delete_failed', { cause });
      return false;
    }
    reset();
    announce();
    return true;
  }, [reset]);

  return {
    thread,
    turns,
    opening,
    scope: thread?.scope ?? draftScope,
    ask,
    cancel,
    open,
    reset,
    rename,
    setScope,
    remove,
  };
}

function announce() {
  window.dispatchEvent(new CustomEvent(THREADS_CHANGED));
}

/**
 * The thread in the address, without a navigation: Next's router follows a
 * native `replaceState`, so `useSearchParams` sees it and nothing reloads.
 */
function showInUrl(threadId: string | null) {
  const url = new URL(window.location.href);
  if (threadId) url.searchParams.set('thread', threadId);
  else url.searchParams.delete('thread');
  window.history.replaceState(null, '', url);
}

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
