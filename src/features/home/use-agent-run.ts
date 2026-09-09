'use client';

import { useCallback, useRef, useState } from 'react';

import { streamServerSentEvents } from '@/api/client/sse-client';
import { agentEndpoints } from '@/api/endpoints/registry';
import { agentEventSchema, type AgentEvent } from '@/api/contracts/agent';
import { logger } from '@/observability/logger';

/**
 * What the surface shows while the agent is working.
 *
 * `answer` grows a token at a time; `steps` is the visible trace. The design
 * asks for exactly this — "AI work is a visible trace you can stop" — and the
 * brief is explicit that the trace shows operational steps, never reasoning.
 */
export interface AgentRunState {
  readonly status: 'idle' | 'running' | 'done' | 'failed' | 'cancelled';
  readonly answer: string;
  readonly steps: readonly AgentStep[];
  /** Set when the agent proposed something that needs a person to accept it. */
  readonly awaitingApproval?: { approvalRequestId?: string; summary?: string };
  readonly error?: string;
}

export interface AgentStep {
  readonly id: string;
  readonly name: string;
  readonly status: 'running' | 'succeeded' | 'failed' | 'denied';
  readonly detail?: string;
}

const IDLE: AgentRunState = { status: 'idle', answer: '', steps: [] };

/**
 * Runs one agent turn and exposes the stream as state.
 *
 * The session id is minted once per mount and reused, because agent memory is
 * keyed on `(tenant, user, sessionId)` — a fresh id per message would give the
 * agent amnesia between turns.
 *
 * A run in flight is aborted when a new one starts or the component unmounts;
 * the endpoint holds the connection open with heartbeats, so a forgotten
 * stream would otherwise stay open indefinitely.
 */
export function useAgentRun() {
  const [state, setState] = useState<AgentRunState>(IDLE);
  const abortRef = useRef<AbortController | null>(null);
  /*
   * Minted once per mount and reused for every turn: agent memory is keyed on
   * `(tenant, user, sessionId)`, so a fresh id per message would give the
   * agent amnesia between them.
   *
   * `null` as the initial value is what lets this be set exactly once without
   * reading the ref during render.
   */
  const sessionRef = useRef<string | null>(null);
  sessionRef.current ??= globalThis.crypto.randomUUID();

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState((current) =>
      current.status === 'running' ? { ...current, status: 'cancelled' } : current,
    );
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState(IDLE);
  }, []);

  const run = useCallback(async (message: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState({ status: 'running', answer: '', steps: [] });

    try {
      const stream = streamServerSentEvents({
        // Through the BFF, like every other browser call: the bearer token is
        // attached server-side and never reaches the page.
        url: `/api/bff${agentEndpoints.run().path}`,
        body: { message, sessionId: sessionRef.current },
        signal: controller.signal,
      });

      for await (const frame of stream) {
        const parsed = agentEventSchema.safeParse(safeJson(frame.data));
        if (!parsed.success) {
          // One unrecognised frame must not end the run — the backend adds
          // event types without versioning.
          logger.debug('agent.unrecognised_event', { event: frame.event });
          continue;
        }
        setState((current) => reduce(current, parsed.data));
      }

      setState((current) =>
        current.status === 'running' ? { ...current, status: 'done' } : current,
      );
    } catch (cause) {
      if (controller.signal.aborted) return;
      logger.warn('agent.run_failed', { cause });
      setState((current) => ({ ...current, status: 'failed' }));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, []);

  return { state, run, cancel, reset };
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Folds one event into the visible state. */
function reduce(current: AgentRunState, event: AgentEvent): AgentRunState {
  switch (event.type) {
    case 'token':
      return { ...current, answer: current.answer + event.text };

    case 'tool_start':
      return {
        ...current,
        steps: [
          ...current.steps,
          {
            id: event.toolCallId ?? `${event.name}-${current.steps.length}`,
            name: event.name ?? 'unknown',
            status: 'running',
          },
        ],
      };

    case 'tool_end':
      return {
        ...current,
        steps: current.steps.map((step) =>
          step.id === event.toolCallId
            ? {
                ...step,
                status: event.ok === false ? 'failed' : 'succeeded',
                detail: event.resultSummary,
              }
            : step,
        ),
      };

    case 'denied':
      return {
        ...current,
        steps: [
          ...current.steps,
          {
            id: `denied-${current.steps.length}`,
            name: event.tool ?? 'unknown',
            status: 'denied',
            detail: event.reason,
          },
        ],
      };

    case 'plan_proposed':
    case 'awaiting_approval':
      return {
        ...current,
        awaitingApproval: {
          approvalRequestId: event.approvalRequestId,
          // Only `plan_proposed` carries a summary; `awaiting_approval` names
          // the tool instead. `looseObject` widens absent keys to `unknown`,
          // so the type is narrowed rather than asserted.
          summary: event.type === 'plan_proposed' ? event.summary : event.tool,
        },
      };

    case 'error':
      return { ...current, status: 'failed', error: event.message };

    case 'done':
      return { ...current, status: 'done' };

    // `ready`, `context_attached` and `round_end` carry nothing the operator
    // needs to see.
    default:
      return current;
  }
}
