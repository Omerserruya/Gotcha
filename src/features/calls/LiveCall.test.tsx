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
  it('offers transfer and end', () => {
    renderCall();
    expect(screen.getByTestId('transfer')).toBeInTheDocument();
    expect(screen.getByTestId('end-call')).toBeInTheDocument();
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

  it('stops offering controls once the call has ended', () => {
    renderCall();
    deliver({
      type: 'call.ended',
      tenantId: 't1',
      at: Date.now(),
      conversationId: 'conv-1',
    });
    expect(screen.getByTestId('transfer')).toBeDisabled();
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
