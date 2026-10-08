import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';
import { THREADS_CHANGED } from '@/api/contracts/assistant-threads';
import home from '@/i18n/messages/en/home.json';
import heHome from '@/i18n/messages/he/home.json';

/**
 * ★★ Home · in conversation (design 7, 01a) on `/api/assistant/threads`.
 *
 * A controllable stream stands in for the routes' event streams - each test
 * pushes the frames the server would, with their `<runId>:<seq>` ids - and
 * `browserApi` for the JSON routes (create, open, rename, scope, delete,
 * cancel). The address is `useSearchParams`, set by the test.
 */
const sse = vi.hoisted(() => {
  type Frame = { event?: string; id?: string; data: string };
  type Stream = {
    url: string;
    method: string;
    body: unknown;
    headers: Record<string, string> | undefined;
    push: (f: Frame) => void;
    end: () => void;
    drop: () => void;
  };
  const streams: Stream[] = [];
  /** Refusals to throw, in order, before the next streams open (409, 429, 402...). */
  const refusals: unknown[] = [];
  const stream = vi.fn(
    (options: {
      url: string;
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
      signal: AbortSignal;
    }) => {
      const queue: Frame[] = [];
      let wake: (() => void) | null = null;
      let ended = false;
      let dropped = false;
      const refusal = refusals.shift();
      streams.push({
        url: options.url,
        method: options.method ?? 'POST',
        body: options.body,
        headers: options.headers,
        push: (f) => {
          queue.push(f);
          wake?.();
        },
        end: () => {
          ended = true;
          wake?.();
        },
        drop: () => {
          dropped = true;
          wake?.();
        },
      });
      return (async function* () {
        if (refusal) throw refusal;
        for (;;) {
          if (options.signal.aborted) throw new DOMException('aborted', 'AbortError');
          if (queue.length > 0) {
            yield queue.shift()!;
            continue;
          }
          if (dropped) throw new TypeError('network connection lost');
          if (ended) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
            options.signal.addEventListener('abort', () => resolve(), { once: true });
          });
        }
      })();
    },
  );
  return { stream, streams, refusals };
});
vi.mock('@/api/client/sse-client', () => ({ streamServerSentEvents: sse.stream }));

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));
vi.mock('@/api/client/browser-api', () => ({ browserApi: api }));

const nav = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => nav.params }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: string | { pathname: string; query?: Record<string, string> };
    children: ReactNode;
  }) => (
    <a
      href={
        typeof href === 'string'
          ? href
          : `${href.pathname}?${new URLSearchParams(href.query ?? {})}`
      }
      {...rest}
    >
      {children}
    </a>
  ),
}));

const { HomeConversation } = await import('./HomeConversation');
const { CommandSurface } = await import('./CommandSurface');

const THREAD = { id: 'th1', title: null, scope: { range: 'last_7', channels: 'all' } };

/** Each language's answer chrome, as the page sends it (load-answer-words.ts). */
const WORDS = { en: home.conversation, he: heHome.conversation };
const tree = () => (
  <NextIntlClientProvider locale="en" messages={{ home }} timeZone="UTC">
    <HomeConversation answerWords={WORDS}>
      <div data-testid="home-snapshot">
        <p>Good morning, Maya</p>
        <CommandSurface />
      </div>
    </HomeConversation>
  </NextIntlClientProvider>
);
const show = () => render(tree());

/** A frame as the server sends it: its name, `<runId>:<seq>`, and its data. */
const ev = (name: string, seq: number, data: Record<string, unknown>, run = 'run1') => ({
  event: name,
  id: `${run}:${seq}`,
  data: JSON.stringify(data),
});
const START = ev('run.start', 1, { runId: 'run1', userMessageId: 'u1', messageId: 'm1' });
const DONE = (seq: number, status = 'done') => ev('message.done', seq, { messageId: 'm1', status });
const last = () => sse.streams.at(-1)!;
const push = (...frames: ReturnType<typeof ev>[]) =>
  act(async () => {
    for (const frame of frames) last().push(frame);
  });
const flush = () => act(async () => {});

const ask = async (text: string) => {
  fireEvent.change(screen.getByLabelText(home.command.label), { target: { value: text } });
  await act(async () => {
    fireEvent.submit(screen.getByLabelText(home.command.label).closest('form')!);
  });
};
/** As the real client does: the answer is parsed by the request's own schema. */
const answering =
  (value: unknown) =>
  async ({ payload }: { payload: { parse: (v: unknown) => unknown } }) =>
    payload.parse(value);
const called = (fn: typeof api.post, path: string) =>
  fn.mock.calls.filter(
    ([request]) => (request as { endpoint: { path: string } }).endpoint.path === path,
  );

beforeEach(() => {
  sse.stream.mockClear();
  sse.streams.length = 0;
  sse.refusals.length = 0;
  nav.params = new URLSearchParams();
  window.history.replaceState(null, '', '/home');
  api.get.mockReset();
  api.patch.mockReset();
  api.delete.mockReset();
  api.post.mockReset();
  api.post.mockImplementation(async ({ endpoint }: { endpoint: { path: string } }) =>
    endpoint.path === '/api/assistant/threads' ? THREAD : { status: 'cancelling' },
  );
});
afterEach(() => {
  vi.useRealTimers();
});

describe('★★ the first question makes a thread, and Home becomes the conversation in place', () => {
  it('the snapshot leaves; the thread is created with the scope, then the question streams on it', async () => {
    const changed = vi.fn();
    window.addEventListener(THREADS_CHANGED, changed);
    show();
    expect(screen.getByTestId('home-snapshot')).toBeInTheDocument();
    await ask('Why are returns up this week?');
    expect(screen.queryByTestId('home-snapshot')).toBeNull();
    expect(called(api.post, '/api/assistant/threads')[0]![0]).toMatchObject({
      body: { scope: { range: 'last_7', channels: 'all' } },
    });
    expect(last()).toMatchObject({
      url: '/api/bff/api/assistant/threads/th1/messages',
      method: 'POST',
      body: { text: 'Why are returns up this week?', locale: 'en' },
    });
    // The thread is in the address (a reload comes back to it) and Recent reads again.
    expect(new URL(window.location.href).searchParams.get('thread')).toBe('th1');
    expect(changed).toHaveBeenCalled();
    window.removeEventListener(THREADS_CHANGED, changed);
    expect(screen.getByTestId('conversation-title')).toHaveTextContent(
      'Why are returns up this week?',
    );
    expect(screen.getByRole('status')).toHaveTextContent('Working on it');
  });

  it('steps in the run’s words with the time each took, then the answer as it streams, then the follow-ups', async () => {
    show();
    await ask('How many are open?');
    await push(START, ev('step.start', 2, { stepId: 's1', text: 'Counting open conversations' }));
    expect(screen.getByTestId('step-s1')).toHaveAttribute('data-status', 'running');
    await push(
      ev('step.done', 3, { stepId: 's1', status: 'done', durationMs: 6200 }),
      ev('text.delta', 4, { text: 'You have ' }),
      ev('text.delta', 5, { text: '**9** open.' }),
    );
    const step = screen.getByTestId('step-s1');
    expect(step).toHaveTextContent('Counting open conversations');
    expect(step).toHaveTextContent('done');
    expect(step).toHaveTextContent('· 6s');
    expect(screen.getByTestId('turn-answer')).toHaveTextContent('You have 9 open.');
    expect(screen.getByTestId('turn-answer').querySelector('strong')).toHaveTextContent('9');
    // Not yet: suggestions wait for the answer to finish.
    await push(ev('suggestions', 6, { items: ['Which are oldest?', 'By channel'] }));
    expect(screen.queryByTestId('suggestions')).toBeNull();
    await push(DONE(7));
    expect(
      within(screen.getByTestId('suggestions'))
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Which are oldest?', 'By channel']);
    expect(screen.getByTestId('conversation-send')).toBeInTheDocument();
  });

  it('★ a follow-up, typed or a suggestion, goes to the SAME thread - no second thread', async () => {
    show();
    await ask('How many are open?');
    await push(START, ev('suggestions', 2, { items: ['Which are oldest?'] }), DONE(3));
    await act(async () => {
      fireEvent.click(within(screen.getByTestId('suggestions')).getByRole('button'));
    });
    expect(last()).toMatchObject({
      url: '/api/bff/api/assistant/threads/th1/messages',
      body: { text: 'Which are oldest?' },
    });
    expect(called(api.post, '/api/assistant/threads')).toHaveLength(1);
    expect(screen.getAllByRole('listitem').filter((li) => li.dataset.status)).toHaveLength(2);
  });

  it('the server’s title replaces the question as the title, and Recent reads again', async () => {
    show();
    await ask('How many are open?');
    const changed = vi.fn();
    window.addEventListener(THREADS_CHANGED, changed);
    await push(START, ev('thread.title', 2, { title: 'Open conversations' }));
    expect(screen.getByTestId('conversation-title')).toHaveTextContent(/^Open conversations$/);
    // The heading takes its title's direction - a Hebrew title on /en is right to left.
    expect(screen.getByTestId('conversation-title')).toHaveAttribute('dir', 'auto');
    expect(changed).toHaveBeenCalled();
    window.removeEventListener(THREADS_CHANGED, changed);
  });

  it('a step waiting for approval says so, and leads to Approvals', async () => {
    show();
    await ask('Refund Dana');
    await push(
      START,
      ev('step.start', 2, { stepId: 's9', text: 'Preparing the refund' }),
      ev('step.done', 3, {
        stepId: 's9',
        status: 'waiting_approval',
        durationMs: 300,
        approvalRequestId: 'ar1',
      }),
    );
    expect(screen.getByTestId('step-s9')).toHaveTextContent('waiting for your approval');
    expect(screen.getByTestId('step-s9-approvals')).toHaveAttribute('href', '/approvals');
  });

  it('★ the question and the answer read in their own direction - a Hebrew one right to left', async () => {
    show();
    await ask('מה קרה עם ההחזרות האחרונות?');
    await push(START, ev('text.delta', 2, { text: 'ההחזרות עלו ב־38%.' }));
    expect(screen.getByText('מה קרה עם ההחזרות האחרונות?', { selector: 'p' })).toHaveAttribute(
      'dir',
      'auto',
    );
    expect(screen.getByTestId('turn-answer').querySelector('p')).toHaveAttribute('dir', 'auto');
  });
});

describe('★★ stage 2: the work under the words, as the stream gives it (§9.6)', () => {
  it('a block renders as it arrives; the sources come once, after the text - its chips, and its citations', async () => {
    show();
    await ask('How many conversations this week?');
    await push(
      START,
      ev('text.delta', 2, { text: 'Up this week[^s1].' }),
      ev('block', 3, {
        block: {
          type: 'breakdown',
          id: 'b1',
          title: 'By channel',
          sourceId: 's1',
          items: [{ key: 'WHATSAPP', label: 'WhatsApp', value: 23, share: 0.61 }],
          total: 38,
          unit: 'count',
        },
      }),
    );
    expect(screen.getByTestId('block-b1')).toHaveTextContent('By channel');
    // The text cites a source not given yet: no marker, no chip.
    expect(screen.getByTestId('turn-answer')).toHaveTextContent(/^Up this week\.$/);
    await push(
      ev('sources', 4, {
        items: [{ id: 's1', label: '38 conversations', kind: 'conversations', deepLink: '/inbox' }],
      }),
      DONE(5),
    );
    // The chip, then the stop - one group with the word before it (AnswerText).
    expect(screen.getByTestId('turn-answer')).toHaveTextContent('Up this week38 conversations.');
    expect(screen.getByTestId('turn-sources')).toHaveTextContent('38 conversations');
  });
});

describe('★★ resume: a dropped stream is picked up where it stopped, and no word is doubled', () => {
  it('the drop: GET the run’s events after the last id seen; the replayed ones are not applied twice', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    show();
    await ask('How many are open?');
    await push(
      START,
      ev('text.delta', 2, { text: 'You have ' }),
      ev('text.delta', 3, { text: '9 ' }),
    );
    await act(async () => {
      last().drop();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(last()).toMatchObject({
      url: '/api/bff/api/assistant/threads/th1/runs/run1/events',
      method: 'GET',
      headers: { 'last-event-id': 'run1:3' },
    });
    // The server replays from where it thinks the client is: 3 again, then the rest.
    await push(
      ev('text.delta', 3, { text: '9 ' }),
      ev('text.delta', 4, { text: 'open.' }),
      DONE(5),
    );
    expect(screen.getByTestId('turn-answer')).toHaveTextContent(/^You have 9 open\.$/);
    expect(screen.queryByTestId('turn-failed')).toBeNull();
  });

  it('a drop before the run started is a failure, said - there is nothing to resume', async () => {
    show();
    await ask('How many are open?');
    await act(async () => {
      last().drop();
    });
    await flush();
    expect(screen.getByTestId('turn-failed')).toHaveTextContent("It couldn't answer just now");
    expect(sse.streams).toHaveLength(1);
  });
});

describe('★★ Stop is the route’s cancel; leaving is not', () => {
  it('Stop: POST cancel for THIS answer; the stream ends "cancelled" and the text so far stays', async () => {
    show();
    await ask('Why?');
    await push(START, ev('text.delta', 2, { text: 'So far' }));
    await act(async () => {
      fireEvent.click(screen.getByTestId('conversation-stop'));
    });
    expect(called(api.post, '/api/assistant/threads/th1/messages/m1/cancel')).toHaveLength(1);
    expect(screen.getByTestId('conversation-stop')).toBeDisabled();
    await push(DONE(3, 'cancelled'));
    expect(screen.getByTestId('turn-stopped')).toHaveTextContent('Stopped.');
    expect(screen.getByTestId('turn-answer')).toHaveTextContent('So far');
    expect(screen.getByTestId('conversation-send')).toBeInTheDocument();
  });

  it('← Home: the live Home is back, nothing is cancelled, and the next question is a new thread', async () => {
    show();
    await ask('Why?');
    await push(START);
    await act(async () => {
      fireEvent.click(screen.getByTestId('conversation-home'));
    });
    expect(screen.getByTestId('home-snapshot')).toBeInTheDocument();
    expect(called(api.post, '/api/assistant/threads/th1/messages/m1/cancel')).toHaveLength(0);
    expect(new URL(window.location.href).searchParams.get('thread')).toBeNull();
    await ask('Something else');
    expect(called(api.post, '/api/assistant/threads')).toHaveLength(2);
  });
});

describe('★★ refusals, each in honest words (§6)', () => {
  const refuse = async (error: ApiError) => {
    show();
    sse.refusals.push(error);
    await ask('Why?');
    await flush();
    return screen.getByTestId('turn-failed');
  };

  it('409: an answer is still being written here', async () => {
    const said = await refuse(
      new ApiError({ kind: 'conflict', status: 409, code: 'RUN_IN_PROGRESS' }),
    );
    expect(said).toHaveTextContent('An answer is still being written in this conversation');
  });

  it('429: the rate limit, with when to try again', async () => {
    const said = await refuse(
      new ApiError({
        kind: 'rate_limited',
        status: 429,
        code: 'RATE_LIMITED',
        retryAfterSeconds: 12,
      }),
    );
    expect(said).toHaveTextContent(
      "That's more than 10 questions in a minute. Try again in 12 seconds.",
    );
  });

  it('402: the workspace’s AI credits, and where to see them', async () => {
    const said = await refuse(
      new ApiError({ kind: 'tenant_inactive', status: 402, code: 'AI_UNITS_EXHAUSTED' }),
    );
    expect(said).toHaveTextContent('its credits have run out');
    expect(said.querySelector('a')).toHaveAttribute('href', '/settings/billing');
  });

  it('in the stream: the budget, with the text so far kept', async () => {
    show();
    await ask('Everything about returns');
    await push(
      START,
      ev('text.delta', 2, { text: 'Returns are' }),
      ev('error', 3, { code: 'BUDGET_EXCEEDED', message: 'budget' }),
      DONE(4, 'failed'),
    );
    expect(screen.getByTestId('turn-answer')).toHaveTextContent('Returns are');
    expect(screen.getByTestId('turn-failed')).toHaveTextContent('it reached the most it can write');
  });
});

describe('★★ an answer’s own chrome is in the turn’s language; the page’s stays the page’s', () => {
  const hebrewTurn = async (lang: string | undefined) => {
    show();
    await ask('כמה שיחות וואטסאפ פתוחות כרגע?');
    await push(
      ev('run.start', 1, {
        runId: 'run1',
        userMessageId: 'u1',
        messageId: 'm1',
        ...(lang ? { lang } : {}),
      }),
      ev('step.start', 2, { stepId: 's1', text: 'סופרת שיחות פתוחות' }),
      ev('step.done', 3, { stepId: 's1', status: 'done', durationMs: 200 }),
      ev('block', 4, {
        block: {
          type: 'breakdown',
          id: 'b1',
          title: 'לפי ערוץ',
          sourceId: 's1',
          items: [{ key: 'WHATSAPP', label: 'וואטסאפ', value: 2, share: 0.12 }],
          total: 17,
          unit: 'count',
          coverage: { covered: 14, of: 17 },
        },
      }),
      DONE(5, 'cancelled'),
    );
  };

  it('★ a Hebrew turn on /en: its step, its total and "Stopped" in Hebrew - the header in English', async () => {
    await hebrewTurn('he');
    expect(screen.getByTestId('step-s1')).toHaveTextContent('הסתיים');
    expect(screen.getByTestId('step-s1')).toHaveTextContent('פחות משנייה');
    expect(screen.getByTestId('block-b1')).toHaveTextContent('17 בסך הכל');
    expect(screen.getByTestId('block-b1')).toHaveTextContent('נרשם עבור 14 מתוך 17 שיחות');
    expect(screen.getByTestId('turn-stopped')).toHaveTextContent('נעצר');
    expect(screen.getByTestId(/^turn-.+-answer$/)).toHaveAttribute('lang', 'he');
    // The page's own words stay the interface's.
    expect(screen.getByTestId('conversation-home')).toHaveTextContent(home.conversation.home);
  });

  it('no language on the turn (an older service, or "17?"): the interface’s, as before', async () => {
    await hebrewTurn(undefined);
    expect(screen.getByTestId('step-s1')).toHaveTextContent('done');
    expect(screen.getByTestId('block-b1')).toHaveTextContent('17 in all');
    expect(screen.getByTestId(/^turn-.+-answer$/)).not.toHaveAttribute('lang');
  });
});

describe('★★ a thread by its address: Recent, and a reload', () => {
  const detail = (over: Record<string, unknown> = {}) => ({
    thread: { ...THREAD, title: 'Open conversations' },
    messages: [
      { id: 'u1', role: 'user', text: 'How many are open?', status: 'done' },
      {
        id: 'a1',
        role: 'assistant',
        text: 'You have 9 open.',
        status: 'done',
        suggestions: ['Which are oldest?'],
      },
    ],
    activeRun: null,
    ...over,
  });

  it('opens the stored thread: its title, its turns, its follow-ups', async () => {
    api.get.mockImplementation(answering(detail()));
    nav.params = new URLSearchParams('thread=th1');
    show();
    await flush();
    expect(api.get.mock.calls[0]![0]).toMatchObject({
      endpoint: { path: '/api/assistant/threads/th1' },
    });
    expect(screen.getByTestId('conversation-title')).toHaveTextContent(/^Open conversations$/);
    expect(screen.getByTestId('turn-answer')).toHaveTextContent('You have 9 open.');
    expect(screen.getByTestId('suggestions')).toHaveTextContent('Which are oldest?');
    expect(sse.streams).toHaveLength(0);
  });

  it('★★ someone else’s thread (or a deleted one) is a 404: said, never another thread', async () => {
    api.get.mockRejectedValue(
      new ApiError({ kind: 'not_found', status: 404, code: 'THREAD_NOT_FOUND' }),
    );
    nav.params = new URLSearchParams('thread=not-mine');
    show();
    await flush();
    expect(screen.getByTestId('conversation-unopened')).toHaveTextContent(
      "This conversation isn't here. It may have been deleted, or it belongs to someone else.",
    );
    expect(screen.queryByTestId('turn-answer')).toBeNull();
    expect(screen.queryByTestId('conversation-delete')).toBeNull();
  });

  it('★★ a reload mid-answer replays the run from its start onto an empty turn: the stored partial is not shown twice', async () => {
    api.get.mockImplementation(
      answering(
        detail({
          messages: [
            { id: 'u1', role: 'user', text: 'How many are open?', status: 'done' },
            { id: 'm1', role: 'assistant', text: 'You have ', status: 'streaming' },
          ],
          activeRun: { runId: 'run1', messageId: 'm1', lastEventId: 'run1:2' },
        }),
      ),
    );
    nav.params = new URLSearchParams('thread=th1');
    show();
    await flush();
    expect(last()).toMatchObject({
      url: '/api/bff/api/assistant/threads/th1/runs/run1/events',
      method: 'GET',
      headers: { 'last-event-id': 'run1:0' },
    });
    await push(
      START,
      ev('text.delta', 2, { text: 'You have ' }),
      ev('text.delta', 3, { text: '9 open.' }),
      DONE(4),
    );
    expect(screen.getByTestId('turn-answer')).toHaveTextContent(/^You have 9 open\.$/);
  });

  it('a Recent link to another thread opens it; Home’s own link is the live Home again', async () => {
    api.get.mockImplementation(answering(detail()));
    const view = show();
    await ask('First?');
    await push(START, DONE(2));
    nav.params = new URLSearchParams('thread=th2');
    view.rerender(tree());
    await flush();
    expect(api.get.mock.calls.at(-1)![0]).toMatchObject({
      endpoint: { path: '/api/assistant/threads/th2' },
    });
    nav.params = new URLSearchParams();
    view.rerender(tree());
    await flush();
    expect(screen.getByTestId('home-snapshot')).toBeInTheDocument();
  });
});

describe('★★ title, scope and delete - each through its route', () => {
  it('rename: the person’s title, saved; a refusal is said and the field stays', async () => {
    api.patch.mockImplementationOnce(answering({ ...THREAD, title: 'Weekly returns' }));
    show();
    await ask('Why are returns up?');
    fireEvent.click(screen.getByTestId('conversation-rename'));
    const input = screen.getByTestId('conversation-title-input');
    fireEvent.change(input, { target: { value: '  Weekly returns ' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(api.patch.mock.calls[0]![0]).toMatchObject({
      endpoint: { path: '/api/assistant/threads/th1' },
      body: { title: 'Weekly returns' },
    });
    expect(screen.getByTestId('conversation-title')).toHaveTextContent(/^Weekly returns$/);
    api.patch.mockRejectedValueOnce(new ApiError({ kind: 'validation', status: 400 }));
    fireEvent.click(screen.getByTestId('conversation-rename'));
    fireEvent.change(screen.getByTestId('conversation-title-input'), {
      target: { value: 'Other' },
    });
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('conversation-title-input'), { key: 'Enter' });
    });
    expect(screen.getByTestId('conversation-title-failed')).toHaveTextContent('Not renamed');
    expect(screen.getByTestId('conversation-title-input')).toBeInTheDocument();
  });

  it('the scope chip says what the answers look at; a new range is PATCHed for the questions after it', async () => {
    api.patch.mockImplementationOnce(
      answering({
        ...THREAD,
        scope: { range: 'last_30', channels: 'all' },
      }),
    );
    show();
    await ask('Why?');
    const chip = screen.getByTestId('conversation-scope');
    expect(chip).toHaveTextContent('Last 7 days · All channels');
    fireEvent.keyDown(chip, { key: 'Enter' });
    await act(async () => {
      fireEvent.click(await screen.findByTestId('conversation-scope-last_30'));
    });
    expect(api.patch.mock.calls[0]![0]).toMatchObject({
      endpoint: { path: '/api/assistant/threads/th1' },
      body: { scope: { range: 'last_30', channels: 'all' } },
    });
    expect(screen.getByTestId('conversation-scope')).toHaveTextContent(
      'Last 30 days · All channels',
    );
  });

  it('★ the chip carries the dates the answers use - the server’s, never recomputed here', async () => {
    api.get.mockImplementation(
      answering({
        thread: { ...THREAD, title: 'T', scopeDates: { from: '2026-10-01', to: '2026-10-07' } },
        messages: [],
        activeRun: null,
      }),
    );
    nav.params = new URLSearchParams('thread=th1');
    show();
    await flush();
    expect(screen.getByTestId('conversation-scope')).toHaveTextContent(
      /^Last 7 days · Oct 1 to Oct 7 · All channels$/,
    );
  });

  it('delete, confirmed: DELETE, then the live Home; Recent reads again', async () => {
    api.delete.mockResolvedValueOnce(undefined);
    const changed = vi.fn();
    show();
    await ask('Why?');
    await push(START, DONE(2));
    window.addEventListener(THREADS_CHANGED, changed);
    fireEvent.click(screen.getByTestId('conversation-delete'));
    expect(screen.getByTestId('conversation-delete-dialog')).toHaveTextContent(
      "This can't be undone.",
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('conversation-delete-yes'));
    });
    expect(api.delete.mock.calls[0]![0]).toMatchObject({
      endpoint: { path: '/api/assistant/threads/th1' },
    });
    expect(screen.getByTestId('home-snapshot')).toBeInTheDocument();
    expect(changed).toHaveBeenCalled();
    window.removeEventListener(THREADS_CHANGED, changed);
  });

  it('a delete that failed is said, and the conversation stays', async () => {
    api.delete.mockRejectedValueOnce(new ApiError({ kind: 'server', status: 500 }));
    show();
    await ask('Why?');
    fireEvent.click(screen.getByTestId('conversation-delete'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('conversation-delete-yes'));
    });
    expect(screen.getByTestId('conversation-delete-failed')).toHaveTextContent("It wasn't deleted");
    expect(screen.getByTestId('home-conversation')).toBeInTheDocument();
  });

  it('★ Recent renames or deletes it too: Home follows - another thread’s change leaves it be', async () => {
    show();
    await ask('Why?');
    await push(START, DONE(2));
    const change = (detail: unknown) =>
      act(async () => {
        window.dispatchEvent(new CustomEvent(THREADS_CHANGED, { detail }));
      });
    await change({ id: 'th1', title: 'Renamed in the rail' });
    expect(screen.getByTestId('conversation-title')).toHaveTextContent('Renamed in the rail');
    await change({ id: 'other', deleted: true });
    expect(screen.getByTestId('home-conversation')).toBeInTheDocument();
    await change(null);
    expect(screen.getByTestId('home-conversation')).toBeInTheDocument();
    await change({ id: 'th1', deleted: true });
    expect(screen.queryByTestId('home-conversation')).toBeNull();
    expect(screen.getByTestId('home-snapshot')).toBeInTheDocument();
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('Share is still a status ("next stage")', async () => {
    show();
    await ask('Why?');
    const share = screen.getByTestId('conversation-share');
    expect(share).toHaveAttribute('aria-disabled', 'true');
    expect(share).toHaveTextContent('Next stage');
  });
});

describe('★★ 03’s Ask lands here: a thread about one request, its box waiting (ai 9a86bfac)', () => {
  const about = (over: Record<string, unknown> = {}) => ({
    thread: { ...THREAD, id: 'th5', title: null, context: { approvalId: 'ap1' } },
    messages: [],
    activeRun: null,
    ...over,
  });

  it('says what it is about and links back; the box is focused and nothing is sent', async () => {
    api.get.mockImplementation(answering(about()));
    nav.params = new URLSearchParams('thread=th5');
    show();
    await flush();
    expect(screen.getByTestId('conversation-about')).toHaveTextContent(
      'About a request waiting for approval. GOTCHA can explain it here; deciding it stays on its page.',
    );
    expect(screen.getByTestId('conversation-about-open')).toHaveAttribute(
      'href',
      '/approvals?id=ap1',
    );
    expect(screen.getByTestId('conversation-title')).toHaveTextContent(/^About a request$/);
    expect(document.activeElement).toBe(screen.getByTestId('conversation-input'));
    expect(sse.streams).toHaveLength(0);
    expect(api.post).not.toHaveBeenCalled();
  });

  it('a thread with no context: no line, no focus taken', async () => {
    api.get.mockImplementation(
      answering({
        thread: { ...THREAD, title: 'Open conversations' },
        messages: [],
        activeRun: null,
      }),
    );
    nav.params = new URLSearchParams('thread=th1');
    show();
    await flush();
    expect(screen.queryByTestId('conversation-about')).toBeNull();
    expect(document.activeElement).not.toBe(screen.getByTestId('conversation-input'));
  });
});
