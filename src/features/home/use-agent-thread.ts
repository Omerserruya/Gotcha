'use client';

import { useLocale } from 'next-intl';
import { useCallback, useRef, useState } from 'react';

import { streamServerSentEvents } from '@/api/client/sse-client';
import { agentEventSchema } from '@/api/contracts/agent';
import { agentEndpoints } from '@/api/endpoints/registry';
import { appPath } from '@/lib/base-path';
import { logger } from '@/observability/logger';

import { reduce, type AgentRunState } from './use-agent-run';

/** One question and its answer, as it streams. */
export interface Turn extends AgentRunState {
  readonly id: string;
  readonly question: string;
}

/**
 * Home's conversation (design 7, 01a), turn after turn on one session - the
 * agent's memory is keyed on it, so a follow-up is understood as one.
 *
 * ★ Stage 1, over the run that exists today (`POST /api/agent/run`): steps
 *   and streamed text, Stop. Threads that persist, a title from the server,
 *   suggestions and the scope come with `/api/assistant/threads`; nothing
 *   here stands in for them.
 */
export function useAgentThread() {
  const [turns, setTurns] = useState<readonly Turn[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const sessionRef = useRef<string | null>(null);
  sessionRef.current ??= globalThis.crypto.randomUUID();
  // The interface language: the steps' words and summaries come in it (the answer follows the question).
  const localeRef = useRef(useLocale());

  /** Fold into the last turn only - an earlier one is finished. */
  const onLast = (change: (turn: Turn) => Turn) =>
    setTurns((all) => (all.length === 0 ? all : [...all.slice(0, -1), change(all.at(-1)!)]));

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    onLast((turn) => (turn.status === 'running' ? { ...turn, status: 'cancelled' } : turn));
  }, []);

  /** Back to Home: whatever runs stops; the next question starts afresh. */
  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setTurns([]);
    sessionRef.current = globalThis.crypto.randomUUID();
  }, []);

  const ask = useCallback(async (question: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setTurns((all) => [
      // A turn left running by a new question is stopped, and says so.
      ...all.map((turn) =>
        turn.status === 'running' ? { ...turn, status: 'cancelled' as const } : turn,
      ),
      { id: globalThis.crypto.randomUUID(), question, status: 'running', answer: '', steps: [] },
    ]);

    try {
      const stream = streamServerSentEvents({
        url: appPath(`/api/bff${agentEndpoints.run().path}` as `/${string}`),
        body: { message: question, sessionId: sessionRef.current, locale: localeRef.current },
        signal: controller.signal,
      });
      for await (const frame of stream) {
        const parsed = agentEventSchema.safeParse(safeJson(frame.data));
        if (!parsed.success) {
          logger.debug('agent.unrecognised_event', { event: frame.event });
          continue;
        }
        const now = Date.now();
        onLast((turn) => reduce(turn, parsed.data, now));
      }
      onLast((turn) => (turn.status === 'running' ? { ...turn, status: 'done' } : turn));
    } catch (cause) {
      if (controller.signal.aborted) return;
      logger.warn('agent.thread_turn_failed', { cause });
      onLast((turn) => ({ ...turn, status: 'failed' }));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, []);

  return { turns, ask, cancel, reset };
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
