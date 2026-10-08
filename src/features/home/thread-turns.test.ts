import { describe, expect, it } from 'vitest';

import { ApiError } from '@/api/client/api-error';
import {
  eventSeq,
  parseThreadEvent,
  threadDetailSchema,
  threadMessageSchema,
  type ThreadEvent,
} from '@/api/contracts/assistant-threads';

import { applyEvent, newTurn, problemOf, turnsFromMessages, type ThreadTurn } from './thread-turns';

const ev = (name: string, data: unknown): ThreadEvent => {
  const parsed = parseThreadEvent(name, JSON.stringify(data));
  if (!parsed) throw new Error(`fixture ${name} does not parse`);
  return parsed;
};

/** The run as the server sends it (Backend's live order): seq from 1, no gaps. */
const RUN: readonly ThreadEvent[] = [
  ev('run.start', { runId: 'run1', userMessageId: 'u1', messageId: 'm1' }),
  ev('step.start', { stepId: 's1', text: 'Counting open WhatsApp conversations' }),
  ev('step.done', { stepId: 's1', status: 'done', durationMs: 840 }),
  ev('text.delta', { text: 'You have ' }),
  ev('text.delta', { text: '**9** open.' }),
  ev('suggestions', { items: ['Which are oldest?', 'By channel', 'By agent', 'A fourth'] }),
  ev('thread.title', { title: 'Open conversations' }),
  ev('message.done', { messageId: 'm1', status: 'done' }),
];
const play = (events: readonly ThreadEvent[], from = 1, turn = newTurn('t', 'How many?')) =>
  events.reduce<ThreadTurn>((acc, event, i) => applyEvent(acc, event, from + i), turn);

describe('★★ a turn is folded from the run, each event once', () => {
  it('steps with their time, the text in order, up to three suggestions, then done', () => {
    const turn = play(RUN);
    expect(turn.steps).toEqual([
      {
        id: 's1',
        text: 'Counting open WhatsApp conversations',
        status: 'done',
        durationMs: 840,
        approvalRequestId: null,
      },
    ]);
    expect(turn.answer).toBe('You have **9** open.');
    expect(turn.suggestions).toEqual(['Which are oldest?', 'By channel', 'By agent']);
    expect(turn).toMatchObject({ status: 'done', lastSeq: 8, problem: null });
  });

  it('★★ a replay is applied once: a resume from seq 3, then a reload from 0, double no word', () => {
    const firstFive = play(RUN.slice(0, 5));
    expect(firstFive.answer).toBe('You have **9** open.');
    // The resume sends 3.. again (Last-Event-ID run1:2 lost the ack of 3-5).
    const resumed = play(RUN.slice(2), 3, firstFive);
    expect(resumed.answer).toBe('You have **9** open.');
    expect(resumed.steps).toHaveLength(1);
    // A whole replay over a finished turn changes nothing at all.
    expect(play(RUN, 1, resumed)).toBe(resumed);
  });

  it('a waiting step keeps its approval request', () => {
    const turn = play([
      ev('step.start', { stepId: 's2', text: 'Preparing a refund' }),
      ev('step.done', {
        stepId: 's2',
        status: 'waiting_approval',
        durationMs: 10,
        approvalRequestId: 'ar1',
      }),
    ]);
    expect(turn.steps[0]).toMatchObject({ status: 'waiting_approval', approvalRequestId: 'ar1' });
  });

  it('the stream’s own errors in the screen’s terms; the text so far is kept', () => {
    const cut = play([
      ev('text.delta', { text: 'Partly' }),
      ev('error', { code: 'BUDGET_EXCEEDED', message: 'x' }),
      ev('message.done', { messageId: 'm1', status: 'failed' }),
    ]);
    expect(cut).toMatchObject({ answer: 'Partly', status: 'failed', problem: { kind: 'budget' } });
    expect(play([ev('error', { code: 'AI_UNAVAILABLE' })]).problem).toEqual({
      kind: 'unavailable',
    });
    expect(play([ev('error', { code: 'SOMETHING_NEW' })]).problem).toEqual({ kind: 'failed' });
  });

  it('a cancelled answer keeps its text and is no longer "stopping"', () => {
    const turn = play(
      [
        ev('text.delta', { text: 'So far' }),
        ev('message.done', { messageId: 'm1', status: 'cancelled' }),
      ],
      1,
      { ...newTurn('t', 'q'), cancelling: true },
    );
    expect(turn).toMatchObject({ answer: 'So far', status: 'cancelled', cancelling: false });
  });
});

describe('★★ a refusal before the stream, each in its own terms', () => {
  it('409 busy, 429 rate with its wait, 402 credits, 404 missing, the rest failed', () => {
    const refusal = (status: number, extra: object = {}) =>
      problemOf(new ApiError({ kind: 'conflict', status, ...extra }));
    expect(refusal(409, { code: 'RUN_IN_PROGRESS' })).toEqual({ kind: 'busy' });
    expect(refusal(429, { retryAfterSeconds: 12 })).toEqual({
      kind: 'rate',
      retryAfterSeconds: 12,
    });
    expect(refusal(429)).toEqual({ kind: 'rate', retryAfterSeconds: null });
    expect(refusal(402, { code: 'AI_UNITS_EXHAUSTED' })).toEqual({ kind: 'credits' });
    expect(refusal(404)).toEqual({ kind: 'missing' });
    expect(refusal(500)).toEqual({ kind: 'failed' });
    expect(problemOf(new Error('x'))).toEqual({ kind: 'failed' });
  });
});

describe('the stored thread as turns', () => {
  const message = (over: Record<string, unknown>) =>
    threadMessageSchema.parse({ id: 'x', role: 'user', text: '', status: 'done', ...over });

  it('each question with the answer after it; a streaming answer is running; an unanswered one failed', () => {
    const turns = turnsFromMessages([
      message({ id: 'u1', text: 'First?' }),
      message({ id: 'a1', role: 'assistant', text: 'One.', suggestions: ['More?'] }),
      message({ id: 'u2', text: 'Second?' }),
      message({ id: 'u3', text: 'Third?' }),
      message({ id: 'a3', role: 'assistant', text: 'Half', status: 'streaming' }),
    ]);
    expect(turns.map((t) => [t.question, t.answer, t.status])).toEqual([
      ['First?', 'One.', 'done'],
      ['Second?', '', 'failed'],
      ['Third?', 'Half', 'running'],
    ]);
    expect(turns[0]!.suggestions).toEqual(['More?']);
  });

  it('each answer keeps its language (Backend d43ba57c); none, or one with no words here: the interface’s', () => {
    const turns = turnsFromMessages([
      message({ id: 'u1', text: 'כמה?' }),
      message({ id: 'a1', role: 'assistant', text: '17.', lang: 'he' }),
      message({ id: 'u2', text: '17?' }),
      message({ id: 'a2', role: 'assistant', text: 'Yes.' }),
      message({ id: 'u3', text: 'Combien?' }),
      message({ id: 'a3', role: 'assistant', text: '17.', lang: 'fr' }),
    ]);
    expect(turns.map((t) => t.lang)).toEqual(['he', null, null]);
  });
});

describe('the contract reads the stream by the event’s NAME', () => {
  it('an unknown event, or one whose data does not fit, is skipped - never a crash', () => {
    expect(parseThreadEvent('run.heartbeat', '{}')).toBeNull();
    expect(parseThreadEvent(undefined, '{}')).toBeNull();
    expect(parseThreadEvent('text.delta', '{"txt":"x"}')).toBeNull();
    expect(parseThreadEvent('text.delta', 'not json')).toBeNull();
    expect(parseThreadEvent('text.delta', '{"text":"x"}')).toEqual({
      name: 'text.delta',
      data: { text: 'x' },
    });
  });

  it('an event id is <runId>:<seq>', () => {
    expect(eventSeq('run_ab:12')).toBe(12);
    expect(eventSeq('run:with:colons:3')).toBe(3);
    expect(eventSeq(undefined)).toBeNull();
    expect(eventSeq('run1:0')).toBeNull();
    expect(eventSeq('garbage')).toBeNull();
  });

  it('★ a message status it does not know fails the read - never guessed into "done"', () => {
    const detail = (status: string) => ({
      thread: { id: 't', title: null, scope: { range: 'last_7', channels: 'all' } },
      messages: [{ id: 'm', role: 'assistant', text: '', status }],
      activeRun: null,
    });
    expect(threadDetailSchema.safeParse(detail('done')).success).toBe(true);
    expect(threadDetailSchema.safeParse(detail('paused')).success).toBe(false);
  });
});

describe('★★ stage 2: blocks and sources are the server’s, applied once (§9)', () => {
  const chart = {
    type: 'chart',
    id: 'b1',
    title: 'Conversations this week',
    sourceId: 's1',
    kind: 'bar',
    x: { kind: 'day', values: ['2026-10-06', '2026-10-07'] },
    series: [{ key: 'c', label: 'Conversations', values: [3, 9] }],
    unit: 'count',
  };

  it('the run’s message id, each block once in order, the sources as given', () => {
    const turn = play([
      ev('run.start', { runId: 'run1', userMessageId: 'u1', messageId: 'm1' }),
      ev('block', { block: chart }),
      ev('block', { block: chart }),
      ev('block', {
        block: { type: 'record', id: 'b2', title: 'Duvet', kind: 'product', fields: [] },
      }),
      ev('sources', { items: [{ id: 's1', label: '12 conversations', kind: 'conversations' }] }),
    ]);
    expect(turn.messageId).toBe('m1');
    expect(turn.blocks.map((b) => b.id)).toEqual(['b1', 'b2']);
    expect(turn.sources.map((s) => s.label)).toEqual(['12 conversations']);
  });

  it('★ a block this screen cannot read is left out - the message is never rejected for it', () => {
    const message = threadMessageSchema.parse({
      id: 'a1',
      role: 'assistant',
      text: 'x',
      status: 'done',
      blocks: [chart, { type: 'map', id: 'b9' }, { type: 'chart', id: 'b8' }],
      sources: [{ id: 's1', label: 'L', kind: 'k' }, { nope: true }],
    });
    expect(message.blocks.map((b) => b.id)).toEqual(['b1']);
    expect(message.sources.map((s) => s.id)).toEqual(['s1']);
  });

  it('a stored answer carries its blocks, sources and message id', () => {
    const [turn] = turnsFromMessages([
      threadMessageSchema.parse({ id: 'u1', role: 'user', text: 'q', status: 'done' }),
      threadMessageSchema.parse({
        id: 'a1',
        role: 'assistant',
        text: 'x',
        status: 'done',
        blocks: [chart],
        sources: [{ id: 's1', label: 'L', kind: 'k' }],
      }),
    ]);
    expect(turn).toMatchObject({
      messageId: 'a1',
      blocks: [{ id: 'b1' }],
      sources: [{ id: 's1' }],
    });
  });
});
