import { isApiError } from '@/api/client/api-error';
import type { ThreadEvent, ThreadMessage, ThreadStep } from '@/api/contracts/assistant-threads';

/**
 * Why a turn has no (whole) answer, in the terms the screen words it:
 *
 *   budget       the answer reached its token budget; the text so far is kept
 *   unavailable  the model provider failed, or billing refused mid-answer
 *   busy         409 RUN_IN_PROGRESS - an answer is still being written here
 *   rate         429 - more than 10 questions a minute; `retryAfterSeconds`
 *   credits      402 - the workspace cannot use AI now
 *   missing      404 - deleted, or not this person's
 *   failed       anything else
 */
export type TurnProblem =
  | { readonly kind: 'budget' | 'unavailable' | 'busy' | 'credits' | 'missing' | 'failed' }
  | { readonly kind: 'rate'; readonly retryAfterSeconds: number | null };

/** One question and its answer, as it streams or as it was stored. */
export interface ThreadTurn {
  /** Local key: stable across the answer's ids arriving. */
  readonly id: string;
  readonly question: string;
  readonly answer: string;
  readonly steps: readonly ThreadStep[];
  readonly suggestions: readonly string[];
  readonly status: 'running' | 'done' | 'cancelled' | 'failed';
  /** Stop was pressed; the stream has not said `cancelled` yet. */
  readonly cancelling: boolean;
  readonly problem: TurnProblem | null;
  /** The last event applied (`<runId>:<seq>`): anything at or below it is a replay. */
  readonly lastSeq: number;
}

export function newTurn(id: string, question: string): ThreadTurn {
  return {
    id,
    question,
    answer: '',
    steps: [],
    suggestions: [],
    status: 'running',
    cancelling: false,
    problem: null,
    lastSeq: 0,
  };
}

/**
 * Folds one event into a turn. `seq` is the event's place in its run: a
 * replayed one (a resume, a reconnect, a reload that replays from the start)
 * is at or below `lastSeq` and changes nothing - so no text is ever doubled.
 */
export function applyEvent(turn: ThreadTurn, event: ThreadEvent, seq: number | null): ThreadTurn {
  if (seq !== null && seq <= turn.lastSeq) return turn;
  const next = seq !== null ? { ...turn, lastSeq: seq } : turn;
  switch (event.name) {
    case 'step.start':
      return next.steps.some((step) => step.id === event.data.stepId)
        ? next
        : {
            ...next,
            steps: [
              ...next.steps,
              {
                id: event.data.stepId,
                text: event.data.text,
                status: 'running',
                durationMs: null,
                approvalRequestId: null,
              },
            ],
          };
    case 'step.done':
      return {
        ...next,
        steps: next.steps.map((step) =>
          step.id === event.data.stepId
            ? {
                ...step,
                status: event.data.status,
                durationMs: event.data.durationMs,
                approvalRequestId: event.data.approvalRequestId,
              }
            : step,
        ),
      };
    case 'text.delta':
      return { ...next, answer: next.answer + event.data.text };
    case 'suggestions':
      return { ...next, suggestions: event.data.items.slice(0, 3) };
    case 'error':
      return {
        ...next,
        problem: {
          kind:
            event.data.code === 'BUDGET_EXCEEDED'
              ? 'budget'
              : event.data.code === 'AI_UNAVAILABLE'
                ? 'unavailable'
                : 'failed',
        },
      };
    case 'message.done':
      return { ...next, status: event.data.status, cancelling: false };
    // `run.start` and `thread.title` belong to the thread, not to the turn's words.
    default:
      return next;
  }
}

/** A refusal before the stream opened, in the screen's terms. */
export function problemOf(cause: unknown): TurnProblem {
  if (!isApiError(cause)) return { kind: 'failed' };
  switch (cause.status) {
    case 409:
      return { kind: 'busy' };
    case 429:
      return { kind: 'rate', retryAfterSeconds: cause.retryAfterSeconds ?? null };
    case 402:
      return { kind: 'credits' };
    case 404:
      return { kind: 'missing' };
    default:
      return { kind: 'failed' };
  }
}

/**
 * The stored messages as turns: each question with the answer after it. A
 * message still `streaming` is a turn still running (its run is resumed by
 * the caller). A question with no answer stored is one that never got one.
 */
export function turnsFromMessages(messages: readonly ThreadMessage[]): ThreadTurn[] {
  const turns: ThreadTurn[] = [];
  let answered = true;
  for (const message of messages) {
    if (message.role === 'user') {
      turns.push({ ...newTurn(message.id, message.text), status: 'failed' });
      answered = false;
      continue;
    }
    const last = turns.at(-1);
    if (!last || answered) continue;
    answered = true;
    turns[turns.length - 1] = {
      ...last,
      answer: message.text,
      steps: message.steps,
      suggestions: message.suggestions.slice(0, 3),
      status: message.status === 'streaming' ? 'running' : message.status,
    };
  }
  return turns;
}
