import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import home from '@/i18n/messages/en/home.json';

/**
 * ★★ Home · in conversation (design 7, 01a). A controllable stream stands in
 * for `POST /api/agent/run`: each test pushes the frames it needs.
 */
const sse = vi.hoisted(() => {
  type Frame = { data: string };
  const streams: { push: (f: Frame) => void; end: () => void; body: unknown }[] = [];
  const stream = vi.fn((options: { body: unknown; signal: AbortSignal }) => {
    const queue: Frame[] = [];
    let wake: (() => void) | null = null;
    let ended = false;
    streams.push({
      body: options.body,
      push: (f) => {
        queue.push(f);
        wake?.();
      },
      end: () => {
        ended = true;
        wake?.();
      },
    });
    return (async function* () {
      for (;;) {
        if (options.signal.aborted) throw new DOMException('aborted', 'AbortError');
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
          options.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      }
    })();
  });
  return { stream, streams };
});
vi.mock('@/api/client/sse-client', () => ({ streamServerSentEvents: sse.stream }));

const { HomeConversation } = await import('./HomeConversation');
const { CommandSurface } = await import('./CommandSurface');

const show = () =>
  render(
    <NextIntlClientProvider locale="en" messages={{ home }}>
      <HomeConversation>
        <div data-testid="home-snapshot">
          <p>Good morning, Maya</p>
          <CommandSurface />
        </div>
      </HomeConversation>
    </NextIntlClientProvider>,
  );

const frame = (event: Record<string, unknown>) => ({ data: JSON.stringify(event) });
const last = () => sse.streams.at(-1)!;
const flush = () => act(async () => {});

const ask = async (text: string) => {
  fireEvent.change(screen.getByLabelText(home.command.label), { target: { value: text } });
  await act(async () => {
    fireEvent.submit(screen.getByLabelText(home.command.label).closest('form')!);
  });
};

beforeEach(() => {
  sse.stream.mockClear();
  sse.streams.length = 0;
});

describe('★★ the first question turns Home into the conversation, in place', () => {
  it('the greeting and snapshot leave; the bar, the turn and the docked box come', async () => {
    show();
    expect(screen.getByTestId('home-snapshot')).toBeInTheDocument();
    await ask('Why are returns up this week?');
    expect(screen.queryByTestId('home-snapshot')).toBeNull();
    expect(screen.getByTestId('conversation-title')).toHaveTextContent(
      'Why are returns up this week?',
    );
    expect(screen.getByTestId('conversation-dock')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Working on it');
  });

  it('steps first (running, then ✓ with the time it took), then the text as it streams', async () => {
    show();
    await ask('Why are returns up this week?');
    await act(async () => {
      last().push(frame({ type: 'tool_start', toolCallId: 's1', name: 'query_returns' }));
    });
    expect(screen.getByTestId('step-s1')).toHaveAttribute('data-status', 'running');
    await act(async () => {
      last().push(
        frame({ type: 'tool_end', toolCallId: 's1', ok: true, resultSummary: '61 returns' }),
      );
      last().push(frame({ type: 'token', text: 'Returns are up ' }));
      last().push(frame({ type: 'token', text: '38%.' }));
    });
    const step = screen.getByTestId('step-s1');
    expect(step).toHaveAttribute('data-status', 'succeeded');
    expect(step).toHaveTextContent(/done.*·/);
    // An unknown tool is "Checking your data"; never its name, never its raw output.
    expect(step).toHaveTextContent('Checking your data');
    expect(step).not.toHaveTextContent('query_returns');
    expect(step).not.toHaveTextContent('61 returns');
    expect(screen.getByTestId('turn-answer')).toHaveTextContent('Returns are up 38%.');
    await act(async () => {
      last().push(frame({ type: 'done' }));
      last().end();
    });
    expect(screen.getByTestId('conversation-send')).toBeInTheDocument();
  });

  it('★ a follow-up is a second turn on the SAME session - the agent remembers', async () => {
    show();
    await ask('Why are returns up this week?');
    await act(async () => {
      last().push(frame({ type: 'done' }));
      last().end();
    });
    fireEvent.change(screen.getByTestId('conversation-input'), {
      target: { value: 'Show me the 23 returns' },
    });
    await act(async () => {
      fireEvent.submit(screen.getByTestId('conversation-dock'));
    });
    expect(screen.getAllByRole('listitem').filter((li) => li.dataset.status)).toHaveLength(2);
    const [first, second] = sse.streams.map((s) => s.body as { sessionId: string });
    expect(second!.sessionId).toBe(first!.sessionId);
  });

  it('Stop while it runs: the turn says it stopped, and the box can ask again', async () => {
    show();
    await ask('Why are returns up this week?');
    await act(async () => {
      fireEvent.click(screen.getByTestId('conversation-stop'));
    });
    await flush();
    expect(screen.getByText('Stopped.')).toBeInTheDocument();
    expect(screen.getByTestId('conversation-send')).toBeInTheDocument();
  });

  it('a failure says so, in the run’s own words when it gave them', async () => {
    show();
    await ask('Why?');
    await act(async () => {
      last().push(frame({ type: 'error', message: 'the analytics service is down' }));
      last().end();
    });
    expect(screen.getByTestId('turn-failed')).toHaveTextContent('the analytics service is down');
  });

  it('← Home: the live Home is back, and the next question starts a new session', async () => {
    show();
    await ask('Why?');
    await act(async () => {
      fireEvent.click(screen.getByTestId('conversation-home'));
    });
    expect(screen.getByTestId('home-snapshot')).toBeInTheDocument();
    await ask('Something else');
    const [first, second] = sse.streams.map((s) => s.body as { sessionId: string });
    expect(second!.sessionId).not.toBe(first!.sessionId);
  });
});

describe('★ stage 1 draws only what exists', () => {
  it('Share is a status ("next stage"); no scope chip, no suggestion chips, no Recent', async () => {
    show();
    await ask('Why?');
    const share = screen.getByTestId('conversation-share');
    expect(share).toHaveAttribute('aria-disabled', 'true');
    expect(share).toHaveTextContent('Next stage');
    const chat = screen.getByTestId('home-conversation');
    expect(chat).not.toHaveTextContent(/THIS WEEK|ALL CHANNELS|Recent/i);
    expect(
      within(chat)
        .queryAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Home', '']);
  });
});

describe('★★ display (dev, 4efc9d8)', () => {
  it('a known tool in words - "system_get_metric · done · value: 3" was on screen', async () => {
    show();
    await ask('How many are waiting?');
    await act(async () => {
      last().push(frame({ type: 'tool_start', toolCallId: 'm', name: 'system_get_metric' }));
      last().push(
        frame({ type: 'tool_end', toolCallId: 'm', ok: true, resultSummary: 'value: 3' }),
      );
    });
    const step = screen.getByTestId('step-m');
    expect(step).toHaveTextContent('Looking up the figures');
    expect(step).not.toHaveTextContent(/system_get_metric|value: 3/);
  });

  it('★ the question and the answer read in their own direction - a Hebrew one right to left', async () => {
    show();
    await ask('מה קרה עם ההחזרות האחרונות?');
    await act(async () => {
      last().push(frame({ type: 'token', text: 'ההחזרות עלו ב־38%.' }));
    });
    expect(screen.getByText('מה קרה עם ההחזרות האחרונות?', { selector: 'p' })).toHaveAttribute(
      'dir',
      'auto',
    );
    expect(screen.getByTestId('turn-answer')).toHaveAttribute('dir', 'auto');
  });
});

describe('★★ the run speaks the interface language (Backend, 2026-10-07)', () => {
  it("the step in the run's own words, with its summary; the locale goes with the question", async () => {
    show();
    await ask('How many are waiting?');
    expect(last().body).toMatchObject({ locale: 'en' });
    await act(async () => {
      last().push(
        frame({
          type: 'tool_start',
          toolCallId: 'w',
          name: 'system_count_conversations',
          label: 'Counting the conversations waiting for your team',
        }),
      );
      last().push(
        frame({
          type: 'tool_end',
          toolCallId: 'w',
          ok: true,
          label: 'Counting the conversations waiting for your team',
          resultSummary: '9 conversations waiting for someone on your team to answer',
        }),
      );
    });
    const step = screen.getByTestId('step-w');
    expect(step).toHaveTextContent('Counting the conversations waiting for your team');
    expect(step).toHaveTextContent('9 conversations waiting');
    expect(step).not.toHaveTextContent('system_count_conversations');
  });
});
