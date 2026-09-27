import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import inbox from '@/i18n/messages/en/inbox.json';

import { Composer } from './Composer';
import type { SendResult } from './send-actions';

/**
 * The reply box.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ NOTHING HERE SENDS ANYTHING, AND THAT NEEDED MORE THAN THE USUAL CARE
 * ════════════════════════════════════════════════════════════════════════════
 * Every other write in this project is mocked to throw because a test must never
 * press it. This one is different in kind: a composer's whole purpose is to be
 * pressed, so the tests DO press it — and the mock returns a decided outcome
 * instead of reaching the action.
 *
 * The real `sendReply` is never imported by this file's runtime. `sent` records
 * what the component asked for, which is the only way to assert the arguments
 * without a request existing anywhere.
 */

const sent = vi.hoisted(() => vi.fn<(id: string, body: string) => Promise<SendResult>>());
vi.mock('./send-actions', () => ({ sendReply: sent }));

const show = (channelName: string | null = 'WhatsApp') =>
  render(
    <NextIntlClientProvider locale="en" messages={{ inbox }}>
      <Composer conversationId="c1" channelName={channelName} />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  sent.mockReset().mockResolvedValue({ ok: true });
});

describe('★★ it never says "sent"', () => {
  it('★★ says QUEUED, and what will report the rest', async () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * A 201 IS A CLAIM ABOUT OUR DATABASE, NOT ABOUT A CUSTOMER'S PHONE
     * ════════════════════════════════════════════════════════════════════════
     * The route writes a row and enqueues it. Delivery happens later through a
     * path the response cannot see, so "sent" would be a claim about a phone we
     * have heard nothing from — and the operator who believes it stops watching
     * the one message that failed.
     *
     * Asserted in both directions: the true word present, the false one absent.
     */
    const user = userEvent.setup();
    show();
    await user.type(screen.getByTestId('composer-body'), 'On its way today');
    await user.click(screen.getByTestId('composer-send'));

    const note = await screen.findByTestId('composer-queued');
    expect(note).toHaveTextContent(/queued/i);
    expect(note).toHaveTextContent(/say so if it fails/i);
    expect(screen.queryByText(/\bsent\b/i)).toBeNull();
  });

  it('★★ the button names the outward action, not a save', async () => {
    show();
    expect(screen.getByTestId('composer-send')).toHaveTextContent(/send to the customer/i);
  });

  it('names the channel the reply goes out on', async () => {
    show('WhatsApp');
    expect(screen.getByLabelText(/your reply, on WhatsApp/i)).toBeInTheDocument();
  });

  it('★ still labels the box when the channel is unknown', async () => {
    // A conversation with no channel is a real row. The box must not lose its
    // label to a missing value.
    show(null);
    expect(screen.getByLabelText(/your reply/i)).toBeInTheDocument();
  });
});

describe('★★ what it refuses to do', () => {
  it('★★ Enter makes a new line and does NOT send', async () => {
    /*
     * The approvals screen refuses a one-keypress irreversible action because
     * this platform has no undo. The same argument applies here and more so:
     * Enter is the key a person presses to start a new line.
     */
    const user = userEvent.setup();
    show();
    await user.type(screen.getByTestId('composer-body'), 'First line{Enter}second line');
    expect(sent).not.toHaveBeenCalled();
    expect(screen.getByTestId('composer-body')).toHaveValue('First line\nsecond line');
  });

  it('★★ an empty box cannot be sent, and neither can whitespace', async () => {
    const user = userEvent.setup();
    show();
    expect(screen.getByTestId('composer-send')).toBeDisabled();
    await user.type(screen.getByTestId('composer-body'), '   ');
    expect(screen.getByTestId('composer-send')).toBeDisabled();
    expect(sent).not.toHaveBeenCalled();
  });

  it('★★ shows no optimistic echo of the reply', async () => {
    /*
     * An optimistic bubble is a message on screen that may not exist anywhere
     * else — the same lie as "sent" in a different costume. The reply appears
     * when the page has re-read it from the server, with its real status.
     */
    const user = userEvent.setup();
    sent.mockImplementation(() => new Promise(() => {}));
    show();
    await user.type(screen.getByTestId('composer-body'), 'Hello there');
    await user.click(screen.getByTestId('composer-send'));
    /*
     * The text stays in the box it was typed into, and nowhere else. Asserted as
     * "the only node carrying it is the textarea" rather than "no node carries
     * it" — the first version looked for zero matches and found one, because a
     * textarea's value IS its text content to a query. The assertion was wrong,
     * not the component.
     */
    const carrying = screen.getAllByText(/Hello there/);
    expect(carrying).toHaveLength(1);
    expect(carrying[0]).toBe(screen.getByTestId('composer-body'));
    expect(screen.getByTestId('composer-body')).toHaveValue('Hello there');
  });

  it('★★ the SUBMIT HANDLER refuses a second send, not only the disabled button', async () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * ★★ A MUTATION SURVIVED HERE AND THIS IS THE TEST IT SURVIVED THROUGH
     * ════════════════════════════════════════════════════════════════════════
     * Removing `isPending` from the guard inside `onSubmit` passed every test in
     * this file, because the BUTTON is disabled while a send is in flight and a
     * click on a disabled button never fires. So one of the two protections was
     * doing all the work and the other was never exercised.
     *
     * That matters more here than almost anywhere: a form can be submitted
     * without its button — programmatically, or by a key press in another field —
     * and the failure mode is sending a stranger the same message twice, with no
     * undo.
     *
     * `fireEvent.submit` is the path that skips the button. Both protections are
     * now asserted, separately, which is the only arrangement where losing either
     * one goes red.
     */
    sent.mockImplementation(() => new Promise(() => {}));
    show();
    const box = screen.getByTestId('composer-body');
    fireEvent.change(box, { target: { value: 'Hi' } });
    const form = screen.getByTestId('composer');
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(sent).toHaveBeenCalledTimes(1));
  });

  it('★★ the submit handler also refuses an empty body, button or no button', async () => {
    // Same reasoning: the disabled button is not the only guard, because a form
    // can be submitted without it.
    show();
    fireEvent.submit(screen.getByTestId('composer'));
    expect(sent).not.toHaveBeenCalled();
  });

  it('★★ does not send twice while the first send is in flight', async () => {
    // There is no undo, and two presses on a slow network is the commonest way
    // somebody sends a stranger the same message twice.
    const user = userEvent.setup();
    sent.mockImplementation(() => new Promise(() => {}));
    show();
    await user.type(screen.getByTestId('composer-body'), 'Hi');
    await user.click(screen.getByTestId('composer-send'));
    await user.click(screen.getByTestId('composer-send'));
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('sends the trimmed body and the conversation id', async () => {
    const user = userEvent.setup();
    show();
    await user.type(screen.getByTestId('composer-body'), '  Thanks for waiting  ');
    await user.click(screen.getByTestId('composer-send'));
    await waitFor(() => expect(sent).toHaveBeenCalledWith('c1', '  Thanks for waiting  '));
  });
});

describe('★★ a failed send keeps the words', () => {
  it('★★ does not empty the box on failure', async () => {
    /*
     * The commonest failure here is recoverable, and a box that clears itself
     * loses somebody's words and gives them nothing to retry with.
     */
    const user = userEvent.setup();
    sent.mockResolvedValue({ ok: false, reason: 'failed' });
    show();
    await user.type(screen.getByTestId('composer-body'), 'Please hold on');
    await user.click(screen.getByTestId('composer-send'));
    await screen.findByTestId('composer-problem');
    expect(screen.getByTestId('composer-body')).toHaveValue('Please hold on');
  });

  it('clears the box only on success', async () => {
    const user = userEvent.setup();
    show();
    await user.type(screen.getByTestId('composer-body'), 'Done');
    await user.click(screen.getByTestId('composer-send'));
    await screen.findByTestId('composer-queued');
    expect(screen.getByTestId('composer-body')).toHaveValue('');
  });

  it('★★ a disconnected channel does not say "try again"', async () => {
    /*
     * The conversation arrived on a channel whose credentials have since been
     * removed. Nothing about the message is at fault and retrying cannot help, so
     * the sentence points at the channel — and says the reply is still here.
     */
    const user = userEvent.setup();
    sent.mockResolvedValue({ ok: false, reason: 'channel_not_configured' });
    show();
    await user.type(screen.getByTestId('composer-body'), 'Hello');
    await user.click(screen.getByTestId('composer-send'));
    const problem = await screen.findByTestId('composer-problem');
    expect(problem).toHaveTextContent(/no longer connected/i);
    expect(problem).toHaveTextContent(/still here/i);
    expect(problem).not.toHaveTextContent(/try again/i);
  });

  it('★ a vanished conversation says so rather than blaming the send', async () => {
    const user = userEvent.setup();
    sent.mockResolvedValue({ ok: false, reason: 'not_found' });
    show();
    await user.type(screen.getByTestId('composer-body'), 'Hello');
    await user.click(screen.getByTestId('composer-send'));
    expect(await screen.findByTestId('composer-problem')).toHaveTextContent(/no longer there/i);
  });
});
