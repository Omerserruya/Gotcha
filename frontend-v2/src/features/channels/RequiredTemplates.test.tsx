import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { requiredTemplatesSchema } from '@/api/contracts/required-templates';
import en from '@/i18n/messages/en/channels.json';
import he from '@/i18n/messages/he/channels.json';

/* ★ Nothing here reaches a server: both actions are spies. A submit is a real Meta write. */
const actions = vi.hoisted(() => ({
  saveRequiredTemplate: vi.fn(),
  loadRequiredTemplates: vi.fn(),
  requiredForConnected: vi.fn(),
}));
vi.mock('./required-templates-actions', () => actions);
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: unknown; children?: ReactNode }) => (
    <a href={typeof href === 'string' ? href : JSON.stringify(href)} {...rest}>
      {children}
    </a>
  ),
}));

import { RequiredTemplates } from './RequiredTemplates';

/** The route's shape (Backend 7e91418b), field for field. */
const item = (over: Record<string, unknown> = {}) => ({
  role: 'reopen',
  name: 'gotcha_reopen',
  language: 'en',
  category: 'UTILITY',
  state: 'missing',
  templateId: null,
  reason: null,
  body: 'Hi {{1}}, we have a reply to your message. You can continue the conversation here.',
  buttons: [{ type: 'QUICK_REPLY', text: 'Continue' }],
  ...over,
});
const followup = (over: Record<string, unknown> = {}) =>
  item({
    role: 'followup',
    name: 'gotcha_followup',
    body: "Hi {{1}}, we didn't hear back from you. Reply here whenever it suits you.",
    buttons: [],
    ...over,
  });
const data = (over: Record<string, unknown> = {}) =>
  requiredTemplatesSchema.parse({
    channelAccountId: 'ca1',
    connectionStatus: 'CONNECTED',
    canSubmit: true,
    languages: ['en'],
    items: [item(), followup()],
    ...over,
  });

const show = (initial = data(), locale: 'en' | 'he' = 'en') =>
  render(
    <NextIntlClientProvider locale={locale} messages={{ channels: locale === 'en' ? en : he }}>
      <RequiredTemplates initial={initial} />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  actions.saveRequiredTemplate.mockReset();
  actions.loadRequiredTemplates.mockReset();
  actions.saveRequiredTemplate.mockResolvedValue({ ok: true, submitted: false });
  actions.loadRequiredTemplates.mockResolvedValue({ ok: false, reason: 'failed' });
});

describe('★★ each role: its purpose, its text, its state', () => {
  it.each([
    ['missing', 'Not saved yet'],
    ['draft', 'Draft'],
    ['pending', 'Waiting for Meta'],
    ['approved', 'Approved'],
    ['rejected', 'Rejected'],
    ['PAUSED_BY_SOMETHING_NEW', 'Unknown state'],
  ])('state %s reads "%s"', (state, words) => {
    show(data({ items: [item({ state })] }));
    const chip = screen.getByTestId('required-state-reopen-en');
    expect(chip).toHaveTextContent(new RegExp(`^${words}$`));
    expect(chip).toHaveAttribute(
      'data-state',
      state === 'PAUSED_BY_SOMETHING_NEW' ? 'unknown' : state,
    );
  });

  it('each role says what it is for, in one line', () => {
    show();
    expect(screen.getByTestId('required-reopen-en')).toHaveTextContent(
      'Reopens a conversation after 24 hours',
    );
    expect(screen.getByTestId('required-followup-en')).toHaveTextContent(
      "A reminder to a customer who didn't reply",
    );
  });

  it('Hebrew: the purposes in Omer’s words, and the submit names Meta', () => {
    show(data(), 'he');
    expect(screen.getByTestId('required-reopen-en')).toHaveTextContent(
      'פתיחה מחדש של שיחה אחרי 24 שעות',
    );
    expect(screen.getByTestId('required-followup-en')).toHaveTextContent('תזכורת ללקוח שלא ענה');
    expect(screen.getByTestId('required-submit')).toHaveTextContent('אישור ושליחה ל‑Meta');
  });

  it('an approved or pending one is not edited here: its text, and Outreach on it', () => {
    show(
      data({
        items: [
          item({ state: 'approved', templateId: 't9' }),
          followup({ state: 'pending', templateId: 't8' }),
        ],
      }),
    );
    expect(screen.queryByTestId('required-body-reopen-en')).toBeNull();
    expect(screen.getByTestId('required-outreach-reopen-en')).toHaveAttribute(
      'href',
      JSON.stringify({ pathname: '/outreach/templates', query: { template: 't9' } }),
    );
    expect(screen.getByTestId('required-outreach-followup-en')).toHaveAttribute(
      'href',
      JSON.stringify({ pathname: '/outreach/templates', query: { template: 't8' } }),
    );
    // Nothing left to save or send.
    expect(screen.queryByTestId('required-save')).toBeNull();
    expect(screen.queryByTestId('required-submit')).toBeNull();
  });

  it('a rejected one: Meta’s reason, its text to fix', () => {
    show(data({ items: [item({ state: 'rejected', reason: 'INVALID_FORMAT' })] }));
    expect(screen.getByTestId('required-reason-reopen-en')).toHaveTextContent(
      "Meta's reason: INVALID_FORMAT",
    );
    expect(screen.getByTestId('required-body-reopen-en')).toBeEnabled();
  });
});

describe('★★ Save keeps drafts; nothing is sent', () => {
  it('edited text, then Save: each one saved with submit:false, exactly', async () => {
    show();
    const body = screen.getByTestId('required-body-reopen-en');
    await userEvent.clear(body);
    await userEvent.type(body, 'Hello again');
    await userEvent.click(screen.getByTestId('required-save'));
    await waitFor(() => expect(actions.saveRequiredTemplate).toHaveBeenCalledTimes(2));
    expect(actions.saveRequiredTemplate.mock.calls.map((c) => c[0])).toStrictEqual([
      {
        channelAccountId: 'ca1',
        role: 'reopen',
        language: 'en',
        body: 'Hello again',
        button: 'Continue',
        submit: false,
      },
      {
        channelAccountId: 'ca1',
        role: 'followup',
        language: 'en',
        body: "Hi {{1}}, we didn't hear back from you. Reply here whenever it suits you.",
        button: null,
        submit: false,
      },
    ]);
    expect(await screen.findByTestId('required-outcome-reopen-en')).toHaveTextContent(
      'Saved as a draft.',
    );
  });

  it('an empty text cannot be saved or sent', async () => {
    show();
    await userEvent.clear(screen.getByTestId('required-body-reopen-en'));
    expect(screen.getByTestId('required-save')).toBeDisabled();
    expect(screen.getByTestId('required-submit')).toBeDisabled();
  });

  it('the states are read again after a save', async () => {
    actions.loadRequiredTemplates.mockResolvedValue({
      ok: true,
      data: data({ items: [item({ state: 'draft' }), followup({ state: 'draft' })] }),
    });
    show();
    await userEvent.click(screen.getByTestId('required-save'));
    await waitFor(() =>
      expect(screen.getByTestId('required-state-reopen-en')).toHaveTextContent('Draft'),
    );
    expect(actions.loadRequiredTemplates).toHaveBeenCalledWith('ca1');
  });
});

describe('★★★ sending to Meta: its own button, and a confirm first', () => {
  it('the submit asks first, and sends nothing until asked', async () => {
    show();
    await userEvent.click(screen.getByTestId('required-submit'));
    expect(screen.getByTestId('required-confirm')).toHaveTextContent(
      'Send the templates to Meta for review? After that they can be edited only in Outreach · Templates.',
    );
    expect(actions.saveRequiredTemplate).not.toHaveBeenCalled();
  });

  it('Cancel sends nothing, and the buttons come back', async () => {
    show();
    await userEvent.click(screen.getByTestId('required-submit'));
    await userEvent.click(screen.getByTestId('required-confirm-no'));
    expect(screen.queryByTestId('required-confirm')).toBeNull();
    expect(screen.getByTestId('required-submit')).toBeEnabled();
    expect(actions.saveRequiredTemplate).not.toHaveBeenCalled();
  });

  it('confirmed: each editable one with submit:true, and said', async () => {
    actions.saveRequiredTemplate.mockResolvedValue({ ok: true, submitted: true });
    show();
    await userEvent.click(screen.getByTestId('required-submit'));
    await userEvent.click(screen.getByTestId('required-confirm-yes'));
    await waitFor(() => expect(actions.saveRequiredTemplate).toHaveBeenCalledTimes(2));
    for (const [call] of actions.saveRequiredTemplate.mock.calls) {
      expect(call).toMatchObject({ channelAccountId: 'ca1', submit: true });
    }
    expect(await screen.findByTestId('required-outcome-followup-en')).toHaveTextContent(
      'Sent to Meta for review.',
    );
  });

  it('Hebrew confirm, in Omer’s words', async () => {
    show(data(), 'he');
    await userEvent.click(screen.getByTestId('required-submit'));
    expect(screen.getByTestId('required-confirm')).toHaveTextContent(
      'לשלוח את התבניות לאישור של Meta? אחרי השליחה אפשר לערוך אותן רק בפנייה יזומה · תבניות.',
    );
  });

  it('a number not connected: said, the submit is off, Save still keeps drafts', async () => {
    show(data({ canSubmit: false, connectionStatus: 'PENDING' }));
    expect(screen.getByTestId('required-not-connected')).toHaveTextContent(
      "This number isn't connected yet. The templates can be sent to Meta once it is; until then, Save keeps them as drafts.",
    );
    expect(screen.getByTestId('required-submit')).toBeDisabled();
    await userEvent.click(screen.getByTestId('required-save'));
    await waitFor(() => expect(actions.saveRequiredTemplate).toHaveBeenCalledTimes(2));
    for (const [call] of actions.saveRequiredTemplate.mock.calls) {
      expect(call).toMatchObject({ submit: false });
    }
  });

  it('a connected number has no such note', () => {
    show();
    expect(screen.queryByTestId('required-not-connected')).toBeNull();
  });
});

describe('★★ refusals, in words', () => {
  const submit = async () => {
    await userEvent.click(screen.getByTestId('required-submit'));
    await userEvent.click(screen.getByTestId('required-confirm-yes'));
  };

  it('409 NUMBER_NOT_CONNECTED: saved as a draft, sent once connected', async () => {
    actions.saveRequiredTemplate.mockResolvedValue({ ok: false, reason: 'not_connected' });
    show();
    await submit();
    expect(await screen.findByTestId('required-outcome-reopen-en')).toHaveTextContent(
      "Saved as a draft. The number isn't connected yet, so it can be sent to Meta once it is.",
    );
  });

  it('409 ALREADY_SUBMITTED: edited in Outreach, on that template', async () => {
    actions.saveRequiredTemplate.mockResolvedValue({
      ok: false,
      reason: 'already_submitted',
      templateId: 't7',
    });
    show();
    await submit();
    expect(await screen.findByTestId('required-outcome-reopen-en')).toHaveTextContent(
      "It was already sent to Meta, so it's edited in Outreach · Templates.",
    );
    expect(screen.getByTestId('required-outreach-reopen-en')).toHaveAttribute(
      'href',
      JSON.stringify({ pathname: '/outreach/templates', query: { template: 't7' } }),
    );
  });

  it('403: only an Owner can, and the rest are not tried', async () => {
    actions.saveRequiredTemplate.mockResolvedValue({ ok: false, reason: 'forbidden' });
    show();
    await submit();
    expect(await screen.findByTestId('required-forbidden')).toHaveTextContent(
      'Only an Owner can save these templates and send them to Meta.',
    );
    expect(actions.saveRequiredTemplate).toHaveBeenCalledTimes(1);
  });

  it('403 in Hebrew', async () => {
    actions.saveRequiredTemplate.mockResolvedValue({ ok: false, reason: 'forbidden' });
    show(data(), 'he');
    await userEvent.click(screen.getByTestId('required-save'));
    expect(await screen.findByTestId('required-forbidden')).toHaveTextContent(
      'רק בעלים יכולים לשמור את התבניות האלה ולשלוח אותן ל‑Meta.',
    );
  });

  it('Meta refused it: saved, fix and send again', async () => {
    actions.saveRequiredTemplate.mockResolvedValue({ ok: false, reason: 'refused' });
    show();
    await submit();
    expect(await screen.findByTestId('required-outcome-reopen-en')).toHaveTextContent(
      "Saved as a draft, but Meta didn't accept it. Fix the text and send it again.",
    );
  });
});
