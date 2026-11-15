import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlatformTemplate } from '@/api/contracts/platform-whatsapp';
import consoleEn from '@/i18n/messages/en/console.json';
import consoleHe from '@/i18n/messages/he/console.json';

/* ⚠ Mocked - a submit is real and outward: nothing reaches Meta. */
const { actions, refresh } = vi.hoisted(() => ({
  actions: {
    savePlatformTemplate: vi.fn(),
    submitPlatformTemplate: vi.fn(),
    syncPlatformTemplates: vi.fn(),
  },
  refresh: vi.fn(),
}));
vi.mock('./platform-whatsapp-actions', () => actions);
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { allEight, language, template } from './fixtures';
import { PlatformTemplates } from './PlatformTemplates';

const w = consoleEn.platformWhatsApp;
const show = (templates: readonly PlatformTemplate[], canSubmit = true, he = false) =>
  render(
    <NextIntlClientProvider
      locale={he ? 'he' : 'en'}
      messages={{ console: he ? consoleHe : consoleEn }}
    >
      <PlatformTemplates templates={templates} canSubmit={canSubmit} />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  for (const fn of Object.values(actions)) {
    fn.mockReset();
    fn.mockResolvedValue({ ok: true });
  }
  refresh.mockClear();
});

describe('★★ the alert templates', () => {
  it('★★ all eight, each in Hebrew and English, each named in words', () => {
    show(allEight());
    for (const [name, label] of Object.entries(w.event)) {
      const row = screen.getByTestId(`tpl-${name}`);
      expect(row).toHaveTextContent(label);
      expect(within(row).getByTestId(`tpl-${name}-he`)).toBeInTheDocument();
      expect(within(row).getByTestId(`tpl-${name}-en`)).toBeInTheDocument();
    }
  });

  it('★★ rejected: Meta’s reason, Edit, and Send again', () => {
    show([
      template({
        languages: {
          he: language({ status: 'REJECTED', rejectedReason: 'INVALID_FORMAT' }),
          en: language(),
        },
      }),
    ]);
    const id = 'tpl-gotcha_customer_waiting-he';
    expect(screen.getByTestId(`${id}-status`)).toHaveTextContent(w.templates.status.REJECTED);
    expect(screen.getByTestId(`${id}-reason`)).toHaveTextContent('INVALID_FORMAT');
    expect(screen.getByTestId(`${id}-edit`)).toBeInTheDocument();
    expect(screen.getByTestId(`${id}-submit-open`)).toBeInTheDocument();
  });

  it('★★ pending at Meta: read only, nothing to send', () => {
    show([template({ languages: { he: language({ status: 'PENDING' }), en: language() } })]);
    const id = 'tpl-gotcha_customer_waiting-he';
    expect(screen.getByTestId(`${id}-status`)).toHaveTextContent(w.templates.status.PENDING);
    expect(screen.queryByTestId(`${id}-edit`)).toBeNull();
    expect(screen.queryByTestId(`${id}-submit-open`)).toBeNull();
  });

  it('★★ verification: Meta’s text, never an editor; it can still be sent', () => {
    show(allEight());
    const id = 'tpl-gotcha_verification_code-en';
    expect(screen.queryByTestId(`${id}-edit`)).toBeNull();
    expect(screen.getByTestId(id)).toHaveTextContent(w.templates.fixed);
    expect(screen.getByTestId(`${id}-submit-open`)).toBeInTheDocument();
  });

  it('★★ save is a draft with the edited text, then the page reads again', async () => {
    show([template()]);
    const id = 'tpl-gotcha_customer_waiting-en';
    fireEvent.click(screen.getByTestId(`${id}-edit`));
    expect(screen.getByTestId(`${id}-save`)).toBeDisabled();
    fireEvent.change(screen.getByTestId(`${id}-editor`), {
      target: { value: 'Waiting: {{1}} on {{2}}.' },
    });
    await act(async () => fireEvent.click(screen.getByTestId(`${id}-save`)));
    expect(actions.savePlatformTemplate).toHaveBeenCalledWith(
      'conversation.waiting',
      'en',
      'Waiting: {{1}} on {{2}}.',
    );
    expect(actions.submitPlatformTemplate).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalled();
    expect(screen.getByTestId(`${id}-outcome`)).toHaveTextContent(w.templates.saved);
  });

  it('★★ an invalid body is refused in words, and the editor stays open with the text', async () => {
    actions.savePlatformTemplate.mockResolvedValue({ ok: false, reason: 'template_body_invalid' });
    show([template()]);
    const id = 'tpl-gotcha_customer_waiting-en';
    fireEvent.click(screen.getByTestId(`${id}-edit`));
    fireEvent.change(screen.getByTestId(`${id}-editor`), { target: { value: '{{1}} only' } });
    await act(async () => fireEvent.click(screen.getByTestId(`${id}-save`)));
    expect(screen.getByTestId(`${id}-outcome`)).toHaveTextContent(w.refusal.template_body_invalid);
    expect(screen.getByTestId(`${id}-editor`)).toHaveValue('{{1}} only');
  });

  it('★★ send asks first, then submits that one language', async () => {
    show([template()]);
    const id = 'tpl-gotcha_customer_waiting-he';
    fireEvent.click(screen.getByTestId(`${id}-submit-open`));
    expect(actions.submitPlatformTemplate).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByTestId(`${id}-submit-yes`)));
    expect(actions.submitPlatformTemplate).toHaveBeenCalledWith('conversation.waiting', 'he');
  });

  it('★★ with no number, sending is held and said', () => {
    show([template()], false);
    expect(screen.getByTestId('platform-templates-no-number')).toHaveTextContent(
      w.templates.noNumber,
    );
    expect(screen.getByTestId('tpl-gotcha_customer_waiting-he-submit-open')).toBeDisabled();
  });

  it('★ a saved draft is shown as the text, marked not sent', () => {
    show([
      template({
        languages: {
          he: language(),
          en: language({ status: 'APPROVED', draftBody: 'New {{1}} and {{2}}.' }),
        },
      }),
    ]);
    const id = 'tpl-gotcha_customer_waiting-en';
    expect(screen.getByTestId(`${id}-body`)).toHaveTextContent('New {{1}} and {{2}}.');
    expect(screen.getByTestId(`${id}-draft`)).toHaveTextContent(w.templates.draft);
    expect(screen.getByTestId(`${id}-submit-open`)).toBeInTheDocument();
  });

  it('★ the Hebrew body is drawn right to left, the English left to right', () => {
    show([template()], true, true);
    expect(screen.getByTestId('tpl-gotcha_customer_waiting-he-body')).toHaveAttribute('dir', 'rtl');
    expect(screen.getByTestId('tpl-gotcha_customer_waiting-en-body')).toHaveAttribute('dir', 'ltr');
  });
});
