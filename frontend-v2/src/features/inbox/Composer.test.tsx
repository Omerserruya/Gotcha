import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import inbox from '@/i18n/messages/en/inbox.json';

import { Composer } from './Composer';
import { fillComposer } from './reply-event';
import type { ComposeResult } from './compose-actions';
import type { SendResult } from './send-actions';
import type { MediaResult } from './send-media';

/**
 * The reply box.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ NOTHING HERE SENDS ANYTHING, AND THAT NEEDED MORE THAN THE USUAL CARE
 * ════════════════════════════════════════════════════════════════════════════
 * Every other write in this project is mocked to throw because a test must never
 * press it. This one is different in kind: a composer's whole purpose is to be
 * pressed, so the tests DO press it - and the mock returns a decided outcome
 * instead of reaching the action.
 *
 * The real `sendReply` is never imported by this file's runtime. `sent` records
 * what the component asked for, which is the only way to assert the arguments
 * without a request existing anywhere.
 */

const sent = vi.hoisted(() => vi.fn<(id: string, body: string) => Promise<SendResult>>());
vi.mock('./send-actions', () => ({ sendReply: sent }));

/*
 * ★ THE OTHER TWO WAYS OUT, MOCKED THE SAME WAY. `sendMedia` is a send - the
 *   upload IS the send - and `composeDraft` is a billed model call. Neither
 *   real one is reachable from this file.
 */
const media = vi.hoisted(() =>
  vi.fn<(id: string, file: File, caption: string) => Promise<MediaResult>>(),
);
vi.mock('./send-media', () => ({ sendMedia: media, MAX_MEDIA_BYTES: 16 * 1024 * 1024 }));
const compose = vi.hoisted(() =>
  vi.fn<(id: string, kind: string, draft: string) => Promise<ComposeResult>>(),
);
vi.mock('./compose-actions', () => ({ composeDraft: compose }));
const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const show = (channelName: string | null = 'WhatsApp') =>
  render(
    <NextIntlClientProvider locale="en" messages={{ inbox }}>
      <Composer conversationId="c1" channelName={channelName} />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  sent.mockReset().mockResolvedValue({ ok: true });
  media.mockReset().mockResolvedValue({ ok: true });
  compose.mockReset().mockResolvedValue({ ok: true, text: 'Reworked draft' });
  refresh.mockReset();
});

describe('★★ it never says "sent"', () => {
  it('★★ says QUEUED, and what will report the rest', async () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * A 201 IS A CLAIM ABOUT OUR DATABASE, NOT ABOUT A CUSTOMER'S PHONE
     * ════════════════════════════════════════════════════════════════════════
     * The route writes a row and enqueues it. Delivery happens later through a
     * path the response cannot see, so "sent" would be a claim about a phone we
     * have heard nothing from - and the operator who believes it stops watching
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
     * else - the same lie as "sent" in a different costume. The reply appears
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
     * it" - the first version looked for zero matches and found one, because a
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
     * without its button - programmatically, or by a key press in another field -
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
    await waitFor(() =>
      expect(sent).toHaveBeenCalledWith('c1', '  Thanks for waiting  ', undefined),
    );
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
     * the sentence points at the channel - and says the reply is still here.
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

describe('★★ 02’s bar - the four controls that have a backend', () => {
  const user = () => userEvent.setup();
  const photo = () => new File(['x'], 'receipt.png', { type: 'image/png' });

  it('⚠ draws no mic and no bookmark - neither has a backend', () => {
    show();
    expect(screen.queryByRole('button', { name: /voice|record|mic/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /saved|bookmark|template/i })).toBeNull();
    expect(screen.getByTestId('composer-attach-image')).toBeInTheDocument();
    expect(screen.getByTestId('composer-attach-file')).toBeInTheDocument();
  });

  it('★ the AI chips act on a draft, so with none they are not ready', async () => {
    show();
    for (const kind of ['rewrite', 'shorter', 'translate']) {
      expect(screen.getByTestId(`compose-${kind}`)).toBeDisabled();
    }
    await user().type(screen.getByTestId('composer-body'), 'Hi');
    expect(screen.getByTestId('compose-shorter')).toBeEnabled();
  });

  it('★★ Rewrite puts GOTCHA’s text in the BOX - it sends nothing - and says so', async () => {
    const u = user();
    show();
    await u.type(screen.getByTestId('composer-body'), 'my draft');
    await u.click(screen.getByTestId('compose-rewrite'));

    expect(compose).toHaveBeenCalledWith('c1', 'rewrite', 'my draft');
    await waitFor(() => expect(screen.getByTestId('composer-body')).toHaveValue('Reworked draft'));
    expect(screen.getByTestId('compose-done')).toBeInTheDocument();
    expect(sent).not.toHaveBeenCalled();
    expect(media).not.toHaveBeenCalled();
  });

  it('★★ and Undo puts the person’s own words back', async () => {
    const u = user();
    show();
    await u.type(screen.getByTestId('composer-body'), 'my draft');
    await u.click(screen.getByTestId('compose-translate'));
    // Enabled, not merely present: a click on a disabled button never fires.
    await waitFor(() => expect(screen.getByTestId('compose-undo')).toBeEnabled());
    await u.click(screen.getByTestId('compose-undo'));
    expect(screen.getByTestId('composer-body')).toHaveValue('my draft');
  });

  it('⚠ a failed rework leaves the draft exactly as it was', async () => {
    compose.mockResolvedValue({ ok: false, reason: 'failed' });
    const u = user();
    show();
    await u.type(screen.getByTestId('composer-body'), 'my draft');
    await u.click(screen.getByTestId('compose-shorter'));
    await waitFor(() => expect(screen.getByTestId('compose-problem')).toBeInTheDocument());
    expect(screen.getByTestId('composer-body')).toHaveValue('my draft');
    expect(screen.queryByTestId('compose-undo')).toBeNull();
  });

  it('⚠⚠ choosing a file HOLDS it - the upload is the send, so choosing is not', async () => {
    const u = user();
    show();
    await u.upload(screen.getByTestId('composer-image-input'), photo());
    expect(screen.getByTestId('composer-file-0')).toHaveTextContent('receipt.png');
    expect(media).not.toHaveBeenCalled();
    // A file alone is something to send.
    expect(screen.getByTestId('composer-send')).toBeEnabled();
  });

  it('★★ Send with a file sends the file, with the text as its caption', async () => {
    const u = user();
    show();
    const file = photo();
    await u.upload(screen.getByTestId('composer-file-input'), file);
    await u.type(screen.getByTestId('composer-body'), 'Here it is');
    await u.click(screen.getByTestId('composer-send'));

    await waitFor(() => expect(media).toHaveBeenCalledWith('c1', file, 'Here it is'));
    expect(sent).not.toHaveBeenCalled();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.queryByTestId('composer-files')).toBeNull();
  });

  it('★ a file can be taken back out before it goes', async () => {
    const u = user();
    show();
    await u.upload(screen.getByTestId('composer-image-input'), photo());
    await u.click(screen.getByTestId('composer-file-remove-0'));
    expect(screen.queryByTestId('composer-files')).toBeNull();
    expect(screen.getByTestId('composer-send')).toBeDisabled();
  });

  it('⚠ a refused file keeps the file AND the words, and says why', async () => {
    media.mockResolvedValue({ ok: false, reason: 'too_large' });
    const u = user();
    show();
    await u.upload(screen.getByTestId('composer-file-input'), photo());
    await u.type(screen.getByTestId('composer-body'), 'caption');
    await u.click(screen.getByTestId('composer-send'));
    await waitFor(() => expect(screen.getByTestId('composer-problem')).toHaveTextContent(/16 MB/));
    expect(screen.getByTestId('composer-file-0')).toBeInTheDocument();
    expect(screen.getByTestId('composer-body')).toHaveValue('caption');
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('⚠⚠ the box comes BACK after a send or a rework', () => {
  /*
   * As `useTransition`, the pending state never cleared once the async work
   * had set its result: the queued note showed, and the field, the chips and
   * Send stayed disabled. Traced, then replaced with a flag cleared in
   * `finally`. Whether a browser stuck the same way was not established - the
   * flag is correct either way, and this pins it.
   */
  it('★ after a send, the field can be typed in again', async () => {
    const u = userEvent.setup();
    show();
    await u.type(screen.getByTestId('composer-body'), 'hello');
    await u.click(screen.getByTestId('composer-send'));
    await waitFor(() => expect(screen.getByTestId('composer-queued')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('composer-body')).toBeEnabled());
  });

  it('★ and after a rework', async () => {
    const u = userEvent.setup();
    show();
    await u.type(screen.getByTestId('composer-body'), 'hello');
    await u.click(screen.getByTestId('compose-shorter'));
    await waitFor(() => expect(screen.getByTestId('compose-done')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('composer-body')).toBeEnabled());
  });
});

describe('★★ out of AI units is said as what it is', () => {
  it('★★ names the workspace’s units and where to top up - not "just now", not "our side"', async () => {
    compose.mockResolvedValue({ ok: false, reason: 'units_exhausted' });
    const u = userEvent.setup();
    show();
    await u.type(screen.getByTestId('composer-body'), 'draft');
    await u.click(screen.getByTestId('compose-rewrite'));
    const problem = await screen.findByTestId('compose-problem');
    expect(problem).toHaveTextContent(/used up its AI units/i);
    expect(problem.textContent).not.toMatch(/just now|our side/i);
    expect(screen.getByTestId('compose-units-link')).toHaveAttribute('href', '/settings/billing');
    expect(screen.getByTestId('composer-body')).toHaveValue('draft');
  });
});

describe('★★ 02’s Reply - answering one message', () => {
  const reply = (target = { id: 'm9', who: 'Customer', preview: 'Where is my parcel?' }) =>
    act(() => {
      window.dispatchEvent(new CustomEvent('gotcha:reply-to', { detail: target }));
    });

  it('★★ shows what is being answered, and the reply carries it', async () => {
    const u = userEvent.setup();
    show();
    reply();
    const strip = screen.getByTestId('composer-replying');
    expect(strip).toHaveTextContent('Replying to Customer');
    expect(strip).toHaveTextContent('Where is my parcel?');
    expect(screen.getByTestId('composer-body')).toHaveFocus();

    await u.type(screen.getByTestId('composer-body'), 'Tomorrow');
    await u.click(screen.getByTestId('composer-send'));
    await waitFor(() => expect(sent).toHaveBeenCalledWith('c1', 'Tomorrow', 'm9'));
    await waitFor(() => expect(screen.queryByTestId('composer-replying')).toBeNull());
  });

  it('★ can be cancelled - and then the reply is an ordinary one', async () => {
    const u = userEvent.setup();
    show();
    reply();
    await u.click(screen.getByTestId('composer-reply-cancel'));
    await u.type(screen.getByTestId('composer-body'), 'Hi');
    await u.click(screen.getByTestId('composer-send'));
    await waitFor(() => expect(sent).toHaveBeenCalledWith('c1', 'Hi', undefined));
  });

  it('⚠⚠ a file and a reply together: Send waits and says why - neither is dropped', async () => {
    const u = userEvent.setup();
    show();
    await u.upload(screen.getByTestId('composer-file-input'), new File(['x'], 'a.png'));
    reply();
    expect(screen.getByTestId('composer-conflict')).toBeInTheDocument();
    expect(screen.getByTestId('composer-send')).toBeDisabled();
    expect(screen.getByTestId('composer-file-0')).toBeInTheDocument();
    expect(screen.getByTestId('composer-replying')).toBeInTheDocument();
  });

  it('⚠ a quote the route refuses is said, and the words stay', async () => {
    sent.mockResolvedValue({ ok: false, reason: 'quote_not_here' });
    const u = userEvent.setup();
    show();
    reply();
    await u.type(screen.getByTestId('composer-body'), 'Tomorrow');
    await u.click(screen.getByTestId('composer-send'));
    expect(await screen.findByTestId('composer-problem')).toHaveTextContent(
      /isn’t in this conversation/,
    );
    expect(screen.getByTestId('composer-body')).toHaveValue('Tomorrow');
  });
});

describe('★★ up to five files - each its own upload, the words once', () => {
  const user = () => userEvent.setup();
  const file = (name: string, type = 'image/png') => new File(['x'], name, { type });

  it('sent in order; the caption with the FIRST only', async () => {
    media.mockResolvedValue({ ok: true });
    const u = user();
    show();
    const [a, b] = [file('a.png'), file('b.pdf', 'application/pdf')];
    await u.upload(screen.getByTestId('composer-file-input'), [a, b]);
    expect(screen.getByTestId('composer-files')).toHaveTextContent('2 of 5');
    await u.type(screen.getByTestId('composer-body'), 'Both');
    await u.click(screen.getByTestId('composer-send'));
    await waitFor(() => expect(media).toHaveBeenCalledTimes(2));
    expect(media.mock.calls[0]).toEqual(['c1', a, 'Both']);
    expect(media.mock.calls[1]).toEqual(['c1', b, '']);
  });

  it('never more than five held; the attach buttons rest at five', async () => {
    const u = user();
    show();
    await u.upload(
      screen.getByTestId('composer-file-input'),
      ['1', '2', '3', '4', '5', '6'].map((n) => file(`${n}.png`)),
    );
    expect(screen.getByTestId('composer-file-4')).toBeInTheDocument();
    expect(screen.queryByTestId('composer-file-5')).toBeNull();
    expect(screen.getByTestId('composer-attach-file')).toBeDisabled();
  });

  it('★ the second fails: the first is gone (sent), the rest stay to retry, the words went with the first', async () => {
    media
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, reason: 'failed' });
    const u = user();
    show();
    await u.upload(screen.getByTestId('composer-file-input'), [
      file('a.png'),
      file('b.png'),
      file('c.png'),
    ]);
    await u.type(screen.getByTestId('composer-body'), 'Three');
    await u.click(screen.getByTestId('composer-send'));
    await waitFor(() => expect(media).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('composer-file-0')).toHaveTextContent('b.png');
    expect(screen.getByTestId('composer-file-1')).toHaveTextContent('c.png');
    expect(screen.getByTestId('composer-body')).toHaveValue('');
  });

  it('a file dropped on the composer is held, not sent', async () => {
    show();
    const dropped = file('drop.png');
    const composer = screen.getByTestId('composer');
    fireEvent.drop(composer, { dataTransfer: { files: [dropped], types: ['Files'] } });
    expect(screen.getByTestId('composer-file-0')).toHaveTextContent('drop.png');
    expect(media).not.toHaveBeenCalled();
  });
});

describe('★★ the Copilot wall fills the box - and sends nothing', () => {
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

  it('★ Use this: the text, the caret at its end, ready to send - nothing sent', async () => {
    show();
    act(() => fillComposer('Sorry, Dana - on its way.'));
    const box = screen.getByTestId('composer-body') as HTMLTextAreaElement;
    expect(box).toHaveValue('Sorry, Dana - on its way.');
    await act(frame);
    expect(box).toHaveFocus();
    expect(box.selectionStart).toBe(box.value.length);
    expect(sent).not.toHaveBeenCalled();
  });

  it('★ Edit: the same text, selected, to be typed over', async () => {
    show();
    act(() => fillComposer('A reply', { select: true }));
    const box = screen.getByTestId('composer-body') as HTMLTextAreaElement;
    await act(frame);
    expect([box.selectionStart, box.selectionEnd]).toEqual([0, 'A reply'.length]);
    expect(sent).not.toHaveBeenCalled();
  });
});

describe('★★ a draft is kept per conversation - Esc closes without losing it', () => {
  it('typed in one, back again after the box was gone', async () => {
    const { unmount } = show();
    fireEvent.change(screen.getByTestId('composer-body'), { target: { value: 'Half a reply' } });
    unmount();
    show();
    expect(screen.getByTestId('composer-body')).toHaveValue('Half a reply');
  });

  it('★ and not carried into another conversation', () => {
    const { unmount } = show();
    fireEvent.change(screen.getByTestId('composer-body'), { target: { value: 'For c1 only' } });
    unmount();
    render(
      <NextIntlClientProvider locale="en" messages={{ inbox }}>
        <Composer conversationId="c2" channelName="WhatsApp" />
      </NextIntlClientProvider>,
    );
    expect(screen.getByTestId('composer-body')).toHaveValue('');
  });
});
