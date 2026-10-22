import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EmailTemplate } from '@/api/contracts/email-template';
import channels from '@/i18n/messages/en/channels.json';
import heChannels from '@/i18n/messages/he/channels.json';

/**
 * The template editor through its real component. Both actions are mocked
 * and THROW unless a test says otherwise: nothing here saves a template or
 * sends an email.
 */
const NEVER = 'a test must never save a template or send an email for real';
const { saveEmailTemplate, sendEmailTemplateTest, refresh } = vi.hoisted(() => ({
  saveEmailTemplate: vi.fn(async (_id: string, _body: unknown): Promise<unknown> => {
    throw new Error('unreachable');
  }),
  sendEmailTemplateTest: vi.fn(async (_id: string): Promise<unknown> => {
    throw new Error('unreachable');
  }),
  refresh: vi.fn(),
}));
vi.mock('./email-template-actions', () => ({ saveEmailTemplate, sendEmailTemplateTest }));
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { EmailTemplateEditor } from './EmailTemplateEditor';

const NONE: EmailTemplate = { enabled: false, html: null, updatedAt: null };
const STORED: EmailTemplate = {
  enabled: true,
  html: '<table><tr><td>{{content}}</td></tr></table>',
  updatedAt: '2026-10-22T09:00:00Z',
};
const NAMES = { agent: 'Maya Levi', business: 'Halvo & Co' };

function editor(
  stored = STORED,
  names: { agent: string | null; business: string | null } = NAMES,
  locale: 'en' | 'he' = 'en',
) {
  return render(
    <NextIntlClientProvider
      locale={locale}
      messages={{ channels: locale === 'en' ? channels : heChannels }}
    >
      <EmailTemplateEditor channelId="ca1" stored={stored} names={names} />
    </NextIntlClientProvider>,
  );
}

const html = () => screen.getByTestId<HTMLTextAreaElement>('email-template-html');
const type = (value: string) => fireEvent.change(html(), { target: { value } });

beforeEach(() => {
  for (const mock of [saveEmailTemplate, sendEmailTemplateTest]) {
    mock.mockReset();
    mock.mockImplementation(async () => {
      throw new Error(NEVER);
    });
  }
  refresh.mockClear();
});

describe('the editor', () => {
  it('opens on the stored html, saved, with nothing to save', () => {
    editor();
    expect(html().value).toBe(STORED.html);
    expect(html()).toHaveAttribute('dir', 'ltr');
    expect(screen.getByTestId('email-template-save')).toBeDisabled();
    expect(screen.queryByTestId('email-template-unsaved')).toBeNull();
  });

  it('★ saving is blocked, in words, while {{content}} is missing', () => {
    editor();
    type('<p>Hello</p>');
    expect(screen.getByTestId('email-template-save')).toBeDisabled();
    expect(screen.getByTestId('email-template-problem')).toHaveTextContent(
      'Add {{content}} where the message goes.',
    );
    expect(html()).toHaveAttribute('aria-invalid', 'true');
  });

  it('★ over 100 KB in UTF-8 bytes is blocked, and the size says so', () => {
    editor();
    // 60,000 Hebrew letters: 60 K characters, 120 K bytes.
    type(`{{content}}${'א'.repeat(60_000)}`);
    expect(screen.getByTestId('email-template-save')).toBeDisabled();
    expect(screen.getByTestId('email-template-size')).toHaveAttribute('data-over', 'yes');
    expect(screen.getByTestId('email-template-size')).toHaveTextContent('117.2 KB of 100.0 KB');
    expect(screen.getByTestId('email-template-problem')).toHaveTextContent(
      'This template is 117.2 KB. The limit is 100.0 KB.',
    );
  });

  it('a placeholder is inserted at the cursor', async () => {
    editor({ ...STORED, html: '<p></p>' });
    html().setSelectionRange(3, 3);
    await userEvent.click(screen.getByTestId('email-template-insert-content'));
    expect(html().value).toBe('<p>{{content}}</p>');
    expect(screen.getByTestId('email-template-unsaved')).toBeInTheDocument();
  });

  it('every placeholder is listed beside the editor, {{content}} marked required', () => {
    editor();
    for (const name of ['content', 'agent_name', 'business_name', 'customer_name']) {
      expect(screen.getByTestId(`email-template-insert-${name}`)).toHaveTextContent(`{{${name}}}`);
    }
    expect(screen.getByTestId('email-template-insert-content').parentElement).toHaveTextContent(
      'Required',
    );
  });
});

describe('★ saving', () => {
  it('sends the html with the switch as it is, then shows what was STORED', async () => {
    saveEmailTemplate.mockResolvedValueOnce({
      ok: true,
      template: { ...STORED, html: '<p>{{content}}</p>' },
      removed: ['script', 'on*'],
    });
    editor();
    type('<p onclick="x()">{{content}}</p><script>1</script>');
    await userEvent.click(screen.getByTestId('email-template-save'));
    expect(saveEmailTemplate).toHaveBeenCalledWith('ca1', {
      enabled: true,
      html: '<p onclick="x()">{{content}}</p><script>1</script>',
    });
    expect(html().value).toBe('<p>{{content}}</p>');
    expect(screen.getByTestId('email-template-removed')).toHaveTextContent(
      'Removed for email safety: scripts, inline event handlers.',
    );
    expect(screen.queryByTestId('email-template-unsaved')).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('nothing removed says nothing about removal', async () => {
    saveEmailTemplate.mockResolvedValueOnce({
      ok: true,
      template: { ...STORED, html: '<b>{{content}}</b>' },
      removed: [],
    });
    editor();
    type('<b>{{content}}</b>');
    await userEvent.click(screen.getByTestId('email-template-save'));
    expect(screen.getByTestId('email-template-notice')).toHaveTextContent('Saved.');
    expect(screen.queryByTestId('email-template-removed')).toBeNull();
  });

  it('a refusal is said, and the edit stays in the editor', async () => {
    saveEmailTemplate.mockResolvedValueOnce({ ok: false, reason: 'content_missing' });
    editor();
    type('<script>{{content}}</script>');
    await userEvent.click(screen.getByTestId('email-template-save'));
    expect(screen.getByTestId('email-template-notice')).toHaveTextContent(
      'The saved HTML has no {{content}}. If it was inside a script, it was removed with it.',
    );
    expect(html().value).toBe('<script>{{content}}</script>');
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('★ the switch', () => {
  it('sends `enabled` alone, and an unsaved edit stays unsaved', async () => {
    saveEmailTemplate.mockResolvedValueOnce({
      ok: true,
      template: { ...STORED, enabled: false },
      removed: [],
    });
    editor();
    type('<i>{{content}}</i>');
    const toggle = screen.getByTestId('email-template-switch');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(toggle);
    expect(saveEmailTemplate).toHaveBeenCalledWith('ca1', { enabled: false });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(html().value).toBe('<i>{{content}}</i>');
    expect(screen.getByTestId('email-template-unsaved')).toBeInTheDocument();
  });

  it('with nothing stored it cannot be turned on, and says why', () => {
    editor(NONE);
    expect(screen.getByTestId('email-template-switch')).toBeDisabled();
    expect(screen.getByText('Save a template to turn this on.')).toBeInTheDocument();
  });
});

describe('★ the preview', () => {
  it('is a sandboxed iframe with NO permissions, and the html never enters this page', () => {
    editor({ ...STORED, html: '<p id="pasted">{{content}}</p><img src=x onerror="boom()">' });
    const frame = screen.getByTestId('email-template-preview');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(document.getElementById('pasted')).toBeNull();
    expect(document.querySelector('img[onerror]')).toBeNull();
  });

  it('real names as text, a labelled block for the message, a chip for the customer', () => {
    editor({
      ...STORED,
      html: '{{agent_name}}|{{business_name}}|{{customer_name}}|{{content}}',
    });
    const doc = screen.getByTestId('email-template-preview').getAttribute('srcdoc')!;
    expect(doc).toContain('Maya Levi|Halvo &amp; Co|');
    expect(doc).toContain('{{customer_name}}</span>');
    expect(doc).toContain('Your message appears here</div>');
  });

  it('a name that is unread is a chip too, never invented', () => {
    editor({ ...STORED, html: '{{agent_name}} {{content}}' }, { agent: null, business: null });
    const doc = screen.getByTestId('email-template-preview').getAttribute('srcdoc')!;
    expect(doc).toContain('{{agent_name}}</span>');
  });

  it('with nothing pasted, says where it will appear', () => {
    editor(NONE);
    expect(screen.queryByTestId('email-template-preview')).toBeNull();
    expect(screen.getByTestId('email-template-preview-empty')).toBeInTheDocument();
  });
});

describe('★ the test send', () => {
  it('sends the stored template and says to which address', async () => {
    sendEmailTemplateTest.mockResolvedValueOnce({ ok: true, sentTo: 'maya@halvo-dev.test' });
    editor();
    await userEvent.click(screen.getByTestId('email-template-test'));
    expect(sendEmailTemplateTest).toHaveBeenCalledWith('ca1');
    expect(screen.getByTestId('email-template-test-result')).toHaveTextContent(
      'Test sent to maya@halvo-dev.test.',
    );
  });

  it('is not offered while there are unsaved changes, and says to save first', () => {
    editor();
    type('<u>{{content}}</u>');
    expect(screen.getByTestId('email-template-test')).toBeDisabled();
    expect(screen.getByTestId('email-template-test-hint')).toHaveTextContent(
      'Save your changes first.',
    );
  });

  it('is not offered with nothing stored', () => {
    editor(NONE);
    expect(screen.getByTestId('email-template-test')).toBeDisabled();
  });

  it.each([
    [
      { ok: false, reason: 'send_failed', detail: 'Mailbox unavailable' },
      'The email provider refused the test: Mailbox unavailable',
    ],
    [{ ok: false, reason: 'send_failed' }, 'The email provider refused the test.'],
    [
      { ok: false, reason: 'no_sender' },
      "Your account has no email address, so we can't send you a test.",
    ],
    [{ ok: false, reason: 'not_connected' }, 'This mailbox is not connected, so it cannot send.'],
  ])('a refusal is said in words (%o)', async (result, words) => {
    sendEmailTemplateTest.mockResolvedValueOnce(result);
    editor();
    await userEvent.click(screen.getByTestId('email-template-test'));
    const said = screen.getByTestId('email-template-test-result');
    expect(said).toHaveAttribute('role', 'alert');
    expect(said).toHaveTextContent(words);
  });
});

describe('the upload', () => {
  const choose = async (file: File) => {
    await act(async () => {
      fireEvent.change(screen.getByTestId('email-template-file'), { target: { files: [file] } });
    });
  };

  it('reads an .html file into the editor, unsaved', async () => {
    editor(NONE);
    await choose(new File(['<div>{{content}}</div>'], 'brand.html', { type: 'text/html' }));
    expect(html().value).toBe('<div>{{content}}</div>');
    expect(saveEmailTemplate).not.toHaveBeenCalled();
  });

  it('refuses a file that is not HTML, and leaves the editor as it was', async () => {
    editor();
    await choose(new File(['x'], 'logo.png', { type: 'image/png' }));
    expect(html().value).toBe(STORED.html);
    expect(screen.getByTestId('email-template-notice')).toHaveTextContent('Choose an .html file.');
  });

  it('refuses a file over the limit before reading it', async () => {
    editor();
    await choose(new File(['a'.repeat(100 * 1024 + 1)], 'big.html', { type: 'text/html' }));
    expect(html().value).toBe(STORED.html);
    expect(screen.getByTestId('email-template-notice')).toHaveTextContent(
      'The template is over the 100.0 KB limit.',
    );
  });
});

describe('Hebrew', () => {
  it('reads in Hebrew, and the code stays left to right', () => {
    editor(STORED, NAMES, 'he');
    expect(screen.getByTestId('email-template-save')).toHaveTextContent('שמירת התבנית');
    expect(html()).toHaveAttribute('dir', 'ltr');
  });
});
