import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConversationRow, ReplyTemplate } from '@/api/contracts/inbox';
import inbox from '@/i18n/messages/en/inbox.json';
import heInbox from '@/i18n/messages/he/inbox.json';

import { Composer } from './Composer';
import type { VerbResult } from './conversation-actions';
import type { SendResult } from './send-actions';
import type { TemplateListResult, TemplateSendResult } from './template-actions';

/**
 * The composer and the customer-service window (B7, Backend 47e376a4).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ A TEMPLATE SEND IS A REAL WHATSAPP MESSAGE. NOTHING HERE SENDS ANYTHING.
 * ════════════════════════════════════════════════════════════════════════════
 * Every action is mocked: the mocks record what the composer asked for and
 * return a decided outcome. No real action module is loaded.
 */

const sent = vi.hoisted(() => vi.fn<(id: string, body: string) => Promise<SendResult>>());
vi.mock('./send-actions', () => ({ sendReply: sent }));
vi.mock('./send-media', () => ({
  sendMedia: () => {
    throw new Error('a test must never call sendMedia here');
  },
  MAX_MEDIA_BYTES: 16 * 1024 * 1024,
}));
vi.mock('./compose-actions', () => ({
  composeDraft: () => {
    throw new Error('a test must never call composeDraft here');
  },
}));
const load = vi.hoisted(() => vi.fn<(id: string) => Promise<TemplateListResult>>());
const sendTemplate = vi.hoisted(() =>
  vi.fn<
    (id: string, templateId: string, v: Record<string, string>) => Promise<TemplateSendResult>
  >(),
);
vi.mock('./template-actions', () => ({ loadReplyTemplates: load, sendTemplate }));
const close = vi.hoisted(() => vi.fn<(id: string) => Promise<VerbResult>>());
vi.mock('./conversation-actions', () => ({ closeConversation: close }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

type Window = ConversationRow['replyWindow'];
const whatsappClosed: Window = {
  channel: 'WHATSAPP',
  open: false,
  closesAt: null,
  mode: 'template_only',
};
const instagramClosed: Window = {
  channel: 'INSTAGRAM',
  open: false,
  closesAt: null,
  mode: 'closed',
};

const show = (
  replyWindow: Window | undefined,
  extra: { resolved?: boolean; locale?: 'en' | 'he'; customerName?: string | null } = {},
) =>
  render(
    <NextIntlClientProvider
      locale={extra.locale ?? 'en'}
      messages={{ inbox: extra.locale === 'he' ? heInbox : inbox }}
    >
      <Composer
        conversationId="c1"
        channelName="WhatsApp"
        replyWindow={replyWindow}
        customerName={extra.customerName === undefined ? 'Yossi Cohen' : extra.customerName}
        resolved={extra.resolved ?? false}
      />
    </NextIntlClientProvider>,
  );

const template = (over: Partial<ReplyTemplate> = {}): ReplyTemplate => ({
  id: 't1',
  name: 'order_update',
  language: 'en',
  body: 'Hi {{1}}, your order {{2}} is ready.',
  headerType: null,
  headerContent: null,
  footer: null,
  buttons: [],
  placeholders: [
    { key: '1', sample: 'Dana' },
    { key: '2', sample: 'A-1734' },
  ],
  ...over,
});

const c = inbox.composer;

beforeEach(() => {
  sent.mockReset().mockResolvedValue({ ok: true });
  load.mockReset().mockResolvedValue({ ok: true, templates: [template()] });
  sendTemplate.mockReset().mockResolvedValue({ ok: true });
  close.mockReset().mockResolvedValue({ ok: true });
  window.sessionStorage.clear();
});

describe('★★ free: nothing changes', () => {
  it.each([
    ['absent', undefined],
    ['null (the server fails open)', null],
    ['an unknown mode', { channel: 'WHATSAPP', open: false, closesAt: null, mode: 'later' }],
    ['free', { channel: 'WHATSAPP', open: true, closesAt: null, mode: 'free' }],
  ])('%s is free', (_name, replyWindow) => {
    show(replyWindow as Window);
    expect(screen.getByTestId('composer-body')).toBeEnabled();
    expect(screen.queryByTestId('composer-window')).toBeNull();
    expect(screen.queryByTestId('composer-template-open')).toBeNull();
    expect(screen.queryByTestId('composer-closing-soon')).toBeNull();
  });
});

describe('★★ template_only - WhatsApp past 24 hours', () => {
  it('disables the box and says why', () => {
    show(whatsappClosed);
    expect(screen.getByTestId('composer-body')).toBeDisabled();
    expect(screen.getByTestId('composer-send')).toBeDisabled();
    expect(screen.getByTestId('composer-window-template')).toHaveTextContent(c.window.templateOnly);
    expect(load).not.toHaveBeenCalled();
  });

  it('★ the form itself refuses free text, not only the disabled button', () => {
    // A kept draft, and a submit that does not go through the button (Enter in a field).
    window.sessionStorage.setItem('gotcha:draft:c1', 'A kept draft');
    show(whatsappClosed);
    expect(screen.getByTestId('composer-body')).toHaveValue('A kept draft');
    fireEvent.submit(screen.getByTestId('composer'));
    expect(sent).not.toHaveBeenCalled();
  });

  it('★★ the picker: preview, variables prefilled, and the exact send', async () => {
    const user = userEvent.setup();
    show(whatsappClosed);
    await user.click(screen.getByTestId('composer-template-open'));
    expect(load).toHaveBeenCalledWith('c1');
    await user.click(await screen.findByTestId('template-option-t1'));

    // "Dana" is a name sample: the customer's name. "A-1734" is not: the sample.
    expect(screen.getByTestId('template-var-1')).toHaveValue('Yossi Cohen');
    expect(screen.getByTestId('template-var-2')).toHaveValue('A-1734');
    expect(screen.getByTestId('template-preview')).toHaveTextContent(
      'Hi Yossi Cohen, your order A-1734 is ready.',
    );

    await user.clear(screen.getByTestId('template-var-2'));
    expect(screen.getByTestId('template-send')).toBeDisabled();
    expect(screen.getByTestId('template-blank')).toHaveTextContent(c.template.blank);
    await user.type(screen.getByTestId('template-var-2'), 'B-9');

    await user.click(screen.getByTestId('template-send'));
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(sendTemplate).toHaveBeenCalledWith('c1', 't1', { '1': 'Yossi Cohen', '2': 'B-9' });
    expect(await screen.findByTestId('composer-queued')).toHaveTextContent(c.queued);
    expect(screen.queryByTestId('template-picker')).toBeNull();
    expect(sent).not.toHaveBeenCalled();
  });

  it('a refused template says why, and the picker stays', async () => {
    sendTemplate.mockResolvedValueOnce({ ok: false, reason: 'not_usable' });
    const user = userEvent.setup();
    show(whatsappClosed);
    await user.click(screen.getByTestId('composer-template-open'));
    await user.click(await screen.findByTestId('template-option-t1'));
    await user.click(screen.getByTestId('template-send'));
    expect(await screen.findByTestId('template-problem')).toHaveTextContent(
      c.template.error.notUsable,
    );
    expect(screen.getByTestId('template-picker')).toBeInTheDocument();
  });

  it('★★ no approved template: says so, with a real link to Outreach templates', async () => {
    load.mockResolvedValueOnce({ ok: true, templates: [] });
    const user = userEvent.setup();
    show(whatsappClosed);
    await user.click(screen.getByTestId('composer-template-open'));
    const none = await screen.findByTestId('template-none');
    expect(none).toHaveTextContent(c.template.none);
    expect(screen.getByTestId('template-none-link')).toHaveAttribute('href', '/outreach/templates');
    expect(screen.getByTestId('template-none-link')).toHaveTextContent(c.template.noneLink);
    expect(screen.queryByTestId('template-send')).toBeNull();
  });

  it('a failed read is said, never shown as "no templates"', async () => {
    load.mockResolvedValueOnce({ ok: false });
    const user = userEvent.setup();
    show(whatsappClosed);
    await user.click(screen.getByTestId('composer-template-open'));
    expect(await screen.findByTestId('template-load-failed')).toBeInTheDocument();
    expect(screen.queryByTestId('template-none')).toBeNull();
  });
});

describe('★★ closed - Instagram/Messenger past 24 hours', () => {
  it('disables the box, says so, and closes with the inbox’s own action', async () => {
    const user = userEvent.setup();
    show(instagramClosed);
    expect(screen.getByTestId('composer-body')).toBeDisabled();
    expect(screen.getByTestId('composer-window-closed')).toHaveTextContent(c.window.closed);
    expect(screen.queryByTestId('composer-template-open')).toBeNull();
    await user.click(screen.getByTestId('composer-close-conversation'));
    expect(close).toHaveBeenCalledWith('c1');
  });

  it('a failed close is said', async () => {
    close.mockResolvedValueOnce({ ok: false, reason: 'failed' });
    const user = userEvent.setup();
    show(instagramClosed);
    await user.click(screen.getByTestId('composer-close-conversation'));
    expect(await screen.findByTestId('composer-close-failed')).toHaveTextContent(
      c.window.closeFailed,
    );
  });

  it('an already closed conversation is not offered closing again', () => {
    show(instagramClosed, { resolved: true });
    expect(screen.queryByTestId('composer-close-conversation')).toBeNull();
  });
});

describe('★★ a 409 mid-typing: the window closed while the page was open', () => {
  it.each([
    ['template_required', 'composer-window-template'],
    ['window_closed', 'composer-window-closed'],
  ] as const)('%s switches state and KEEPS the draft', async (reason, testId) => {
    sent.mockResolvedValueOnce({ ok: false, reason });
    const user = userEvent.setup();
    show(null);
    await user.type(screen.getByTestId('composer-body'), 'We can ship tomorrow');
    await user.click(screen.getByTestId('composer-send'));

    expect(await screen.findByTestId(testId)).toBeInTheDocument();
    expect(screen.getByTestId('composer-body')).toHaveValue('We can ship tomorrow');
    expect(screen.getByTestId('composer-body')).toBeDisabled();
    expect(screen.queryByTestId('composer-problem')).toBeNull();
    expect(window.sessionStorage.getItem('gotcha:draft:c1')).toBe('We can ship tomorrow');
  });
});

describe('closing soon, said quietly', () => {
  const inMinutes = (m: number): Window => ({
    channel: 'WHATSAPP',
    open: true,
    closesAt: new Date(Date.now() + m * 60_000).toISOString(),
    mode: 'free',
  });

  it('under three hours: when', async () => {
    show(inMinutes(150));
    expect(await screen.findByTestId('composer-closing-soon')).toHaveTextContent(
      'The reply window closes in 2 hours',
    );
  });

  it('under an hour: minutes (the clock is read by the minute, so up to one over)', async () => {
    show(inMinutes(40));
    expect(await screen.findByTestId('composer-closing-soon')).toHaveTextContent(
      /closes in (40|41) minutes/,
    );
  });

  it('in Hebrew, with a geresh', async () => {
    show(inMinutes(150), { locale: 'he' });
    expect(await screen.findByTestId('composer-closing-soon')).toHaveTextContent(
      'החלון נסגר בעוד 2 שע׳',
    );
  });

  it('not with hours to spare', async () => {
    show(inMinutes(5 * 60));
    await waitFor(() => expect(screen.getByTestId('composer-body')).toBeEnabled());
    expect(screen.queryByTestId('composer-closing-soon')).toBeNull();
  });
});
