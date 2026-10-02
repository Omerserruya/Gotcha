import { act, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import type { RealtimeEvent, RealtimeEventType } from '@/realtime/events';

import messages from '@/i18n/messages/en/calls.json';

import { LiveCall } from './LiveCall';

/**
 * Screen 05e, tested rather than photographed.
 *
 * **A live call cannot be captured.** This tenant has voice disabled, zero
 * sessions and zero voice messages — and originating a call means dialling a
 * real phone number through Twilio, which is further outside what evidence
 * justifies than sending a campaign or submitting a template to Meta, both of
 * which were declined.
 *
 * So these are the only place the screen's judgements are checked, and as with
 * the approvals keyboard, most of what matters is what the screen does **not**
 * do.
 */

/** Captures each subscription so a test can fire a frame at it. */
const listeners = new Map<RealtimeEventType, (event: RealtimeEvent) => void>();

/**
 * Delivers a frame the way the socket would.
 *
 * Wrapped in `act` because the transport calls listeners outside React's
 * batching — so without it the state update lands after the assertion and
 * every one of these tests fails for a reason that has nothing to do with the
 * component.
 */
function deliver(event: RealtimeEvent): void {
  act(() => listeners.get(event.type)!(event));
}

vi.mock('@/i18n/navigation', () => ({
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: { pathname: string; query?: Record<string, string> };
    children: React.ReactNode;
  }) => (
    <a href={`${href.pathname}?${new URLSearchParams(href.query ?? {})}`} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/realtime/realtime-provider', () => ({
  useRealtimeEvent: (type: RealtimeEventType, listener: (event: RealtimeEvent) => void) => {
    listeners.set(type, listener);
  },
}));

function renderCall(initial: Parameters<typeof LiveCall>[0]['initialTranscript'] = []) {
  listeners.clear();
  return render(
    <NextIntlClientProvider locale="en" messages={{ calls: messages }}>
      <LiveCall
        conversationId="conv-1"
        customerNumber="+447700900123"
        initialTranscript={initial}
      />
    </NextIntlClientProvider>,
  );
}

const transcript = (over: Partial<Extract<RealtimeEvent, { type: 'call.transcript' }>> = {}) =>
  ({
    type: 'call.transcript' as const,
    tenantId: 't1',
    at: Date.now(),
    conversationId: 'conv-1',
    callSid: 'CA1',
    speaker: 'customer' as const,
    text: 'I called last week about a parcel.',
    seq: 1,
    confidence: 0.9,
    ...over,
  }) satisfies RealtimeEvent;

describe('the transcript', () => {
  it('shows who is speaking on every line', () => {
    renderCall();
    deliver(transcript());
    expect(screen.getByText(/parcel/)).toBeInTheDocument();
    expect(screen.getByText('Them')).toBeInTheDocument();
  });

  it('orders by seq, not by arrival', () => {
    // The stream reassembles out-of-order fragments upstream and nothing
    // guarantees the socket preserves that order end to end.
    renderCall();
    const fire = deliver;
    fire(transcript({ seq: 2, text: 'second' }));
    fire(transcript({ seq: 1, text: 'first' }));

    const lines = screen.getAllByText(/first|second/).map((n) => n.textContent);
    expect(lines).toEqual(['first', 'second']);
  });

  it('replaces a repeated seq rather than showing it twice', () => {
    renderCall();
    const fire = deliver;
    fire(transcript({ seq: 1, text: 'once' }));
    fire(transcript({ seq: 1, text: 'once' }));
    expect(screen.getAllByText('once')).toHaveLength(1);
  });

  it('says it is listening rather than looking broken before anyone speaks', () => {
    // Only FINAL utterances are published, so a pause is normal. The copy
    // says when a line will appear instead of implying a fault.
    renderCall();
    expect(screen.getByTestId('transcript-waiting')).toHaveTextContent(/each person finishes/i);
  });

  it('keeps lines already persisted, so a reload mid-call is not blank', () => {
    renderCall([
      {
        id: 'm1',
        direction: 'INBOUND',
        body: 'said before the reload',
        senderName: 'Customer',
        createdAt: null,
      },
    ]);
    expect(screen.getByText('said before the reload')).toBeInTheDocument();
  });
});

describe('frames for another call never reach this one', () => {
  it('ignores a transcript line from a different conversation', () => {
    /*
     * The tenant-broadcast leak was fixed server-side, so this filter is
     * defence in depth and NOT the protection — if it were, the data would
     * still be arriving in every other agent's browser. It is here because a
     * screen should not render what it cannot attribute.
     */
    renderCall();
    // Delivered through `deliver` so the state actually flushes. Firing the
    // listener directly would leave React un-rendered, and the assertion
    // below would pass whether or not the component filters — a negative
    // assertion that cannot fail is not a test.
    deliver(transcript({ conversationId: 'someone-elses-call', text: 'not for us' }));

    // And a positive control in the same test: a line for THIS call does
    // arrive. Without it, a component that dropped every frame would pass.
    deliver(transcript({ seq: 9, text: 'this one is ours' }));

    expect(screen.queryByText('not for us')).toBeNull();
    expect(screen.getByText('this one is ours')).toBeInTheDocument();
  });

  it('ignores suggestions from a different conversation', () => {
    renderCall();
    deliver({
      type: 'call.suggestions',
      tenantId: 't1',
      at: Date.now(),
      conversationId: 'someone-elses-call',
      suggestions: ['not for us'],
    });
    expect(screen.queryByTestId('suggestions')).toBeNull();
  });

  it('does not end this call when another one ends', () => {
    renderCall();
    deliver({
      type: 'call.ended',
      tenantId: 't1',
      at: Date.now(),
      conversationId: 'someone-elses-call',
    });
    expect(screen.getByTestId('live-call')).toHaveAttribute('data-ended', 'no');
  });
});

describe('the controls are the two that exist', () => {
  it('★★ draws transfer and end — and NOT live: they were buttons that did nothing', () => {
    /*
     * Superseded: these were live-looking buttons with no handler. Hanging up
     * or moving a customer's live call waits on Omer, like Send; until then
     * they are drawn disabled and say why.
     */
    renderCall();
    expect(screen.getByTestId('transfer')).toBeDisabled();
    expect(screen.getByTestId('end-call')).toBeDisabled();
    expect(screen.getByTestId('end-call')).toHaveAttribute('title', 'Not available from here yet.');
  });

  it('offers no mute, not even a disabled one', () => {
    /*
     * The design puts Mute in the header beside two controls that work.
     * Nothing in the platform implements it. A greyed button still says one
     * exists — and on a live call the failure is silent while somebody is
     * speaking, which is the "Pause the rest" class.
     */
    renderCall();
    expect(screen.queryByTestId('mute')).toBeNull();
    expect(document.body.textContent).not.toMatch(/\bmute\b/i);
  });

  it('when the call ends, it says so — the controls were never live', () => {
    renderCall();
    expect(screen.getByTestId('live-state')).toHaveTextContent('On the call');
    deliver({
      type: 'call.ended',
      tenantId: 't1',
      at: Date.now(),
      conversationId: 'conv-1',
    });
    expect(screen.getByTestId('live-state')).toHaveTextContent('The call ended');
    expect(screen.getByTestId('end-call')).toBeDisabled();
  });
});

describe('nothing on this screen claims what the platform cannot do', () => {
  it('renders no translation, no extracted intent, no approval routing', () => {
    renderCall();
    deliver(transcript());

    const text = document.body.textContent ?? '';
    // "Hebrew · translating as she speaks" — no translation anywhere.
    expect(text).not.toMatch(/translat/i);
    // "Refund asked for" / "Gift · date passed" — no live intent extraction.
    expect(text).not.toMatch(/refund asked for|date passed/i);
    // Nothing on the voice path creates an ApprovalRequest.
    expect(text).not.toMatch(/approval|approve/i);
  });

  it('shows suggestions as things to say, never as something sent', () => {
    renderCall();
    deliver({
      type: 'call.suggestions',
      tenantId: 't1',
      at: Date.now(),
      conversationId: 'conv-1',
      suggestions: ['Offer the replacement again'],
    });
    expect(screen.getByTestId('suggestions')).toHaveTextContent(/things you could say/i);
    // There is no route that speaks on an agent's behalf.
    expect(document.body.textContent).not.toMatch(/\bsend\b|\bsay it\b/i);
  });
});

describe('★★ 05e — the call as a page', () => {
  function renderFull(over: Partial<Parameters<typeof LiveCall>[0]> = {}) {
    listeners.clear();
    return render(
      <NextIntlClientProvider locale="en" messages={{ calls: messages }}>
        <LiveCall
          conversationId="conv-1"
          customerNumber="972524189930"
          initialTranscript={[]}
          customerId="k1"
          direction="inbound"
          startedAt="2026-10-02T09:00:00.000Z"
          {...over}
        />
      </NextIntlClientProvider>,
    );
  }

  it('the header: the number in display form, who called whom, on the call', () => {
    renderFull();
    const call = screen.getByTestId('live-call');
    expect(call).toHaveTextContent('+972 52 418 9930');
    expect(call).toHaveTextContent('they called you');
    expect(screen.getByTestId('live-state')).toHaveTextContent('On the call');
  });

  it('★ each line carries its time from the call’s start', () => {
    renderFull({
      initialTranscript: [
        {
          id: 'm1',
          direction: 'INBOUND',
          body: 'Hi, I called last week about a parcel.',
          senderName: null,
          createdAt: '2026-10-02T09:00:04.000Z',
        },
      ],
    });
    deliver(
      transcript({
        seq: 1,
        at: Date.parse('2026-10-02T09:01:18.000Z'),
        text: 'Can you also tell me',
      }),
    );
    expect(screen.getByTestId('line--1')).toHaveTextContent('0:04');
    expect(screen.getByTestId('line-1')).toHaveTextContent('1:18');
  });

  it('⚠ a time before the start, or no start, is no time — never a negative', () => {
    renderFull({ startedAt: null });
    deliver(transcript({ seq: 1, at: Date.parse('2026-10-02T09:01:18.000Z') }));
    // The time cell is empty — not "NaN:NaN", which a \d:\d\d check would let through.
    expect(screen.getByTestId('line-1').querySelector('span')?.textContent).toBe('');
  });

  it('⚠ a line stamped before the start has no time — never "-0:03"', () => {
    renderFull();
    deliver(transcript({ seq: 2, at: Date.parse('2026-10-02T08:59:57.000Z') }));
    expect(screen.getByTestId('line-2').querySelector('span')?.textContent).toBe('');
  });

  it('Copilot: every block drawn — found, say this, do now — empty in its shape', () => {
    renderFull();
    expect(screen.getByTestId('copilot-found')).toHaveTextContent('Nothing found yet.');
    expect(screen.getByTestId('suggestions-block')).toHaveTextContent('Nothing to suggest yet.');
    expect(screen.getByTestId('copilot-do')).toHaveTextContent('Nothing to do yet.');
    expect(screen.getByPlaceholderText('Ask Copilot something…')).toBeDisabled();
  });

  it('★★ a matched caller is named in all three places — disc, header, and their lines', () => {
    renderFull({ contactName: 'Dana Cohen' });
    deliver(transcript({ seq: 1, at: Date.parse('2026-10-02T09:00:04.000Z') }));
    const head = screen.getByTestId('live-call').querySelector('header')!;
    expect(head).toHaveTextContent(/^DCDana Cohen/);
    // The speaker, exactly: 02's lines say "Dana", not "Dana Cohen".
    expect(screen.getByTestId('line-1').querySelector('span > span')?.textContent).toBe('Dana');
    expect(screen.getByTestId('line-1')).not.toHaveTextContent('Them');
  });

  it('unmatched, the number is the name and the disc says so — "#", never invented initials', () => {
    renderFull({ contactName: null, customerId: null });
    deliver(transcript({ seq: 1 }));
    expect(screen.getByTestId('live-call').querySelector('header')).toHaveTextContent(
      /^#\+972 52 418 9930/,
    );
    expect(screen.getByTestId('line-1')).toHaveTextContent('Them');
  });

  it('★ Copilot\'s "stop" is drawn and not live — nothing pauses it on a call', () => {
    renderFull();
    expect(screen.getByTestId('copilot-stop')).toBeDisabled();
    expect(screen.getByTestId('copilot-stop')).toHaveAttribute(
      'title',
      'Not available from here yet.',
    );
  });

  it('★ the "Careful" card is drawn in its shape — nothing produces a warning yet', () => {
    renderFull();
    expect(screen.getByTestId('copilot-careful')).toHaveTextContent(
      'CarefulNothing to watch for yet.',
    );
  });

  it('Add a note goes to the person’s notes; with no person it is drawn and not live', () => {
    const { unmount } = renderFull();
    expect(screen.getByTestId('live-note')).toHaveAttribute('href', '/customers/k1?tab=notes');
    unmount();
    renderFull({ customerId: null });
    expect(screen.getByText('Add a note')).toHaveAttribute('aria-disabled', 'true');
  });
});
