import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Suggestion } from '@/api/contracts/copilot';
import { DirectionProvider } from '@/i18n/direction-context';
import inbox from '@/i18n/messages/en/inbox.json';
import type { RealtimeEvent, RealtimeEventType } from '@/realtime/events';

import { FILL_COMPOSER_EVENT, type ComposerFill } from '../reply-event';
import type { CopilotRead } from '../load-copilot';
import { SuggestionCarousel } from './SuggestionCarousel';
import type { RefreshRead } from './wall-actions';

const read = vi.hoisted(() => vi.fn<(id: string) => Promise<CopilotRead>>());
const refresh = vi.hoisted(() => vi.fn<(id: string) => Promise<RefreshRead>>());
vi.mock('./wall-actions', () => ({ readSuggestions: read, refreshSuggestions: refresh }));

const listeners = vi.hoisted(() => new Map<string, ((event: RealtimeEvent) => void)[]>());
const joined = vi.hoisted(() => vi.fn());
vi.mock('@/realtime/realtime-provider', () => ({
  useRealtimeEvent: (type: RealtimeEventType, listener: (event: RealtimeEvent) => void) => {
    listeners.set(type, [...(listeners.get(type) ?? []).filter((l) => l !== listener), listener]);
  },
  useConversationRoom: joined,
}));

const deliver = (conversationId: string) => {
  const event = {
    type: 'copilot.suggestions.updated',
    tenantId: 't1',
    at: 0,
    conversationId,
  } as RealtimeEvent;
  // The latest registration per type is the live one.
  listeners.get(event.type)?.at(-1)?.(event);
};

const s = (id: string, over: Partial<Suggestion> = {}): Suggestion => ({
  id,
  text: `Reply ${id}`,
  confidence: 0.8,
  type: 'reply',
  approach: `approach ${id}`,
  ...over,
});

const ok = (data: Suggestion[], over: Record<string, unknown> = {}): CopilotRead => ({
  state: 'ok',
  response: {
    data,
    copilotMode: 'READY_MESSAGE',
    stale: false,
    generating: false,
    basedOnMessageId: null,
    generatedAt: null,
    ...over,
  },
});

const show = (locale = 'en') =>
  render(
    <NextIntlClientProvider locale={locale} messages={{ inbox }}>
      <DirectionProvider locale={locale}>
        <SuggestionCarousel conversationId="c1" />
      </DirectionProvider>
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  read.mockReset();
  refresh.mockReset();
  joined.mockClear();
  listeners.clear();
});

describe('★★ three reads, each with one cause', () => {
  it('★★ once on open - and a re-render does not read again', async () => {
    read.mockResolvedValue(ok([s('a')]));
    const { rerender } = show();
    await screen.findByTestId('wall-suggestion-a');
    // The same tree again: a re-render, not a remount.
    rerender(
      <NextIntlClientProvider locale="en" messages={{ inbox }}>
        <DirectionProvider locale="en">
          <SuggestionCarousel conversationId="c1" />
        </DirectionProvider>
      </NextIntlClientProvider>,
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith('c1');
    expect(joined).toHaveBeenCalledWith('c1');
  });

  it('★★ again on copilot.suggestions.updated for THIS conversation, not another', async () => {
    read.mockResolvedValue(ok([s('a')]));
    show();
    await screen.findByTestId('wall-suggestion-a');

    act(() => deliver('other'));
    expect(read).toHaveBeenCalledTimes(1);

    read.mockResolvedValue(ok([s('b')]));
    act(() => deliver('c1'));
    await screen.findByTestId('wall-suggestion-b');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('★★ refresh only from the button - and a 429 says how long', async () => {
    read.mockResolvedValue(ok([], { stale: true }));
    show();
    const retry = await screen.findByTestId('wall-suggestions-retry');
    expect(refresh).not.toHaveBeenCalled();
    /*
     * The first read is a transition, and Retry is disabled while it is
     * pending - a click on a disabled button never fires, so clicking the
     * moment it appears sometimes refreshed nothing (1 run in 3, alone).
     */
    await waitFor(() => expect(retry).toBeEnabled());

    refresh.mockResolvedValue({ state: 'rate_limited', retryAfterSeconds: 12 });
    fireEvent.click(retry);
    expect(await screen.findByTestId('wall-suggestions-wait')).toHaveTextContent(
      'Try again in 12s',
    );
    expect(refresh).toHaveBeenCalledTimes(1);

    refresh.mockResolvedValue(ok([s('n')]));
    await waitFor(() => expect(screen.getByTestId('wall-suggestions-retry')).toBeEnabled());
    fireEvent.click(screen.getByTestId('wall-suggestions-retry'));
    await screen.findByTestId('wall-suggestion-n');
  });
});

describe('★ what an empty answer says', () => {
  it.each([
    [{ stale: true }, 'waiting', 'Suggestions come when the customer writes.'],
    [{ stale: true, generating: true }, 'writing', 'Writing suggestions…'],
  ])('%o → %s', async (over, note, sentence) => {
    read.mockResolvedValue(ok([], over));
    show();
    const p = await screen.findByTestId('wall-suggestions-note');
    expect(p).toHaveAttribute('data-note', note);
    expect(p).toHaveTextContent(sentence);
  });

  it('stale with cards: the cards, and the quiet line', async () => {
    read.mockResolvedValue(ok([s('a')], { stale: true }));
    show();
    expect(await screen.findByTestId('wall-suggestions-stale')).toBeInTheDocument();
    expect(screen.getByTestId('wall-suggestion-a')).toBeInTheDocument();
  });
});

describe('★★ the carousel', () => {
  it('one open, the rest folded; "1 of 3 open"; › opens the next', async () => {
    read.mockResolvedValue(ok([s('a'), s('b'), s('c')]));
    show();
    await screen.findByTestId('wall-suggestion-a');
    expect(screen.getByTestId('wall-suggestion-a')).toHaveAttribute('data-open', 'yes');
    expect(screen.getByTestId('wall-suggestion-b')).toHaveAttribute('data-open', 'no');
    expect(screen.getByTestId('wall-suggestions-position')).toHaveTextContent('1 of 3 open');
    expect(screen.getByText('Three ways to answer')).toBeInTheDocument();
    expect(screen.getByTestId('wall-suggestions-previous')).toBeDisabled();

    fireEvent.click(screen.getByTestId('wall-suggestions-next'));
    expect(screen.getByTestId('wall-suggestion-b')).toHaveAttribute('data-open', 'yes');
    expect(screen.getByTestId('wall-suggestions-position')).toHaveTextContent('2 of 3 open');
  });

  it('a folded card opens on a click', async () => {
    read.mockResolvedValue(ok([s('a'), s('b'), s('c')]));
    show();
    fireEvent.click(await screen.findByTestId('wall-suggestion-c'));
    expect(screen.getByTestId('wall-suggestion-c')).toHaveAttribute('data-open', 'yes');
  });

  it('★ → is next in English; ← is next in Hebrew', async () => {
    read.mockResolvedValue(ok([s('a'), s('b')]));
    const { unmount } = show('en');
    const a = await screen.findByTestId('wall-suggestion-a');
    fireEvent.keyDown(a.parentElement!, { key: 'ArrowRight' });
    expect(screen.getByTestId('wall-suggestion-b')).toHaveAttribute('data-open', 'yes');
    unmount();

    show('he');
    const a2 = await screen.findByTestId('wall-suggestion-a');
    fireEvent.keyDown(a2.parentElement!, { key: 'ArrowRight' });
    expect(screen.getByTestId('wall-suggestion-a')).toHaveAttribute('data-open', 'yes');
    fireEvent.keyDown(a2.parentElement!, { key: 'ArrowLeft' });
    expect(screen.getByTestId('wall-suggestion-b')).toHaveAttribute('data-open', 'yes');
  });

  it('★ a swipe to the left brings the next one in (English)', async () => {
    read.mockResolvedValue(ok([s('a'), s('b')]));
    show();
    const region = (await screen.findByTestId('wall-suggestion-a')).parentElement!;
    fireEvent.pointerDown(region, { clientX: 200 });
    fireEvent.pointerUp(region, { clientX: 120 });
    expect(screen.getByTestId('wall-suggestion-b')).toHaveAttribute('data-open', 'yes');
    // A wobble is a click, not a swipe.
    fireEvent.pointerDown(region, { clientX: 200 });
    fireEvent.pointerUp(region, { clientX: 190 });
    expect(screen.getByTestId('wall-suggestion-b')).toHaveAttribute('data-open', 'yes');
  });
});

describe('★★ Use this and Edit put text in the box - and send nothing', () => {
  it('Use this: the text, caret at the end; Edit: the text, selected', async () => {
    read.mockResolvedValue(ok([s('a')]));
    const fills: ComposerFill[] = [];
    const onFill = (e: Event) => fills.push((e as CustomEvent<ComposerFill>).detail);
    window.addEventListener(FILL_COMPOSER_EVENT, onFill);
    show();
    fireEvent.click(await screen.findByTestId('wall-suggestion-use'));
    fireEvent.click(screen.getByTestId('wall-suggestion-edit'));
    window.removeEventListener(FILL_COMPOSER_EVENT, onFill);
    expect(fills).toEqual([
      { text: 'Reply a', select: false },
      { text: 'Reply a', select: true },
    ]);
  });

  it('⚠ a proposed action has no button', async () => {
    read.mockResolvedValue(ok([s('a', { type: 'quick_action' })]));
    show();
    await screen.findByTestId('wall-suggestion-a');
    expect(screen.queryByTestId('wall-suggestion-use')).toBeNull();
    expect(screen.queryByTestId('wall-suggestion-edit')).toBeNull();
  });

  it('the model’s approach is isolated as its text, and "Recommended" is ours', async () => {
    read.mockResolvedValue(ok([s('a', { approach: 'הסלמה' })]));
    show();
    await waitFor(() => expect(screen.getByText('הסלמה')).toBeInTheDocument());
    expect(screen.getByText('הסלמה').closest('bdi')?.textContent).toBe('הסלמה');
  });
});

describe('★ the card’s head, as 02 draws it', () => {
  it('★ "Recommended" once, when the model already led with it', async () => {
    read.mockResolvedValue(ok([s('a', { approach: 'Recommended · escalate' }), s('b')]));
    show();
    const head = (await screen.findByTestId('wall-suggestion-a')).querySelector(
      '[data-recommended]',
    );
    expect(head?.textContent).toBe('Recommended · escalate');
  });

  it('ours when it did not', async () => {
    read.mockResolvedValue(ok([s('a', { approach: 'escalate' })]));
    show();
    const head = (await screen.findByTestId('wall-suggestion-a')).querySelector(
      '[data-recommended]',
    );
    expect(head?.textContent).toBe('Recommended · escalate');
  });

  it('★★ top right is the why - confidence in its title; folded cards too', async () => {
    read.mockResolvedValue(
      ok([s('a', { rationale: 'no refund yet' }), s('b', { rationale: 'costs ₪179' }), s('c')]),
    );
    show();
    const why = await screen.findByTestId('wall-why-a');
    expect(why).toHaveTextContent('no refund yet');
    expect(why).toHaveAttribute('title', 'Confident');
    expect(screen.getByTestId('wall-why-b')).toHaveTextContent('costs ₪179');
    // No rationale: the confidence is the line, so the corner is never blank.
    expect(screen.getByTestId('wall-why-c')).toHaveTextContent('Confident');
    // And not repeated under the text.
    expect(screen.getAllByText('no refund yet')).toHaveLength(1);
  });
});
