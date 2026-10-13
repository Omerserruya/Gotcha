import { act, fireEvent, render as rtlRender, screen } from '@testing-library/react';
import { createFormatter, createTranslator, NextIntlClientProvider } from 'next-intl';
import type { ReactElement, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { requiredTemplatesSchema } from '@/api/contracts/required-templates';
import { templateSchema } from '@/api/contracts/templates';
import { exclusionSchema, numberEventSchema } from '@/api/contracts/whatsapp-numbers';
import channels from '@/i18n/messages/en/channels.json';
import templates from '@/i18n/messages/en/templates.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({
      locale: 'en',
      messages: { channels, templates },
      namespace: namespace as never,
    }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'Asia/Jerusalem' }),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: unknown; children?: ReactNode }) => (
    <a href={typeof href === 'string' ? href : JSON.stringify(href)} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
}));
const actions = vi.hoisted(() => ({ addPrivateContact: vi.fn(), removePrivateContact: vi.fn() }));
vi.mock('./number-actions', () => actions);
/* ★ The required templates' writes are spies: a submit is a real Meta write. */
const required = vi.hoisted(() => ({
  saveRequiredTemplate: vi.fn(),
  loadRequiredTemplates: vi.fn(),
  requiredForConnected: vi.fn(),
}));
vi.mock('./required-templates-actions', () => required);

const render = (node: ReactElement) =>
  rtlRender(
    <NextIntlClientProvider locale="en" messages={{ channels, templates }}>
      {node}
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  actions.addPrivateContact.mockReset();
  actions.removePrivateContact.mockReset();
});

const { ActivityTab, ContactsTab, TemplatesTab } = await import('./WhatsAppTabContent');

describe('★★ 13b · Templates', () => {
  it("WhatsApp's templates with their state and category; another channel's are not here", async () => {
    const tpl = (over: Record<string, unknown>) =>
      templateSchema.parse({ id: 't', name: 'order_ready', body: 'Hi', ...over });
    render(
      await TemplatesTab({
        templates: [
          tpl({ id: 't1', status: 'APPROVED', category: 'UTILITY', channel: 'WHATSAPP' }),
          tpl({ id: 't2', status: 'REJECTED', category: 'MARKETING', channel: null }),
          tpl({ id: 't3', channel: 'EMAIL' }),
        ],
      }),
    );
    expect(screen.getByTestId('tab-template-t1')).toHaveTextContent('Utility · Ready to send');
    expect(screen.getByTestId('tab-template-t2')).toHaveTextContent('Marketing · Rejected');
    expect(screen.queryByTestId('tab-template-t3')).toBeNull();
  });

  describe('★★ each number’s required templates, first', () => {
    const read = (items: Record<string, unknown>[]) =>
      ({
        ok: true,
        data: requiredTemplatesSchema.parse({
          channelAccountId: 'ca1',
          canSubmit: true,
          languages: ['en'],
          items,
        }),
      }) as const;

    it('a rejected one shows Meta’s reason and its text to fix; an approved one opens in Outreach', async () => {
      render(
        await TemplatesTab({
          templates: [],
          required: [
            {
              channelAccountId: 'ca1',
              label: '+972 54 000 0000',
              read: read([
                {
                  role: 'reopen',
                  name: 'gotcha_reopen',
                  language: 'en',
                  state: 'rejected',
                  templateId: 't1',
                  reason: '[PAUSED] Low quality',
                  body: 'Hi {{1}}',
                },
                {
                  role: 'followup',
                  name: 'gotcha_followup',
                  language: 'en',
                  state: 'approved',
                  templateId: 't2',
                  body: 'Hi {{1}}',
                },
              ]),
            },
          ],
        }),
      );
      expect(screen.getByTestId('tab-required')).toHaveTextContent('Required templates');
      expect(screen.getByTestId('required-state-reopen-en')).toHaveTextContent('Rejected');
      expect(screen.getByTestId('required-reason-reopen-en')).toHaveTextContent(
        "Meta's reason: [PAUSED] Low quality",
      );
      expect(screen.getByTestId('required-body-reopen-en')).toHaveValue('Hi {{1}}');
      expect(screen.getByTestId('required-outreach-followup-en')).toHaveAttribute(
        'href',
        JSON.stringify({ pathname: '/outreach/templates', query: { template: 't2' } }),
      );
      // One number: no label over its list.
      expect(screen.getByTestId('tab-required-ca1')).not.toHaveTextContent('+972 54 000 0000');
      // The account's own list still follows.
      expect(screen.getByTestId('tab-empty')).toBeInTheDocument();
    });

    it('a 403: only an Owner, in words', async () => {
      render(
        await TemplatesTab({
          templates: [],
          required: [
            { channelAccountId: 'ca1', label: null, read: { ok: false, reason: 'forbidden' } },
          ],
        }),
      );
      expect(screen.getByTestId('required-unread')).toHaveTextContent(
        'Only an Owner can see and send the required templates.',
      );
    });

    it('two numbers: each under its own number', async () => {
      render(
        await TemplatesTab({
          templates: [],
          required: [
            { channelAccountId: 'ca1', label: '+972 54 000 0000', read: read([]) },
            { channelAccountId: 'ca2', label: '+972 3 555 0000', read: read([]) },
          ],
        }),
      );
      expect(screen.getByTestId('tab-required-ca2')).toHaveTextContent('+972 3 555 0000');
    });
  });

  it('none, and unread, are different sentences', async () => {
    const none = render(await TemplatesTab({ templates: [] }));
    expect(screen.getByTestId('tab-empty')).toHaveTextContent('No WhatsApp templates yet');
    none.unmount();
    render(await TemplatesTab({ templates: null }));
    expect(screen.getByTestId('tab-unread')).toHaveTextContent("Couldn't read");
  });
});

/** Dev: one number. */
const ONE = [{ id: 'ca1', label: '+972 54 000 0000' }];
const TWO = [...ONE, { id: 'ca2', label: '+972 3 555 0000' }];

describe('★★ 13b · Private contacts', () => {
  it('each as it was typed, with its note', async () => {
    render(
      await ContactsTab({
        numbers: ONE,
        exclusions: [
          exclusionSchema.parse({
            id: 'x1',
            value: '054-123-4567',
            normalized: '972541234567',
            note: 'My mother',
          }),
        ],
      }),
    );
    expect(screen.getByTestId('tab-contact-x1')).toHaveTextContent('054-123-4567');
    expect(screen.getByTestId('tab-contact-x1')).toHaveTextContent('My mother');
    expect(screen.getByTestId('tab-contact-x1')).not.toHaveTextContent('972541234567');
  });

  it('none: says every number reaches GOTCHA', async () => {
    render(await ContactsTab({ exclusions: [], numbers: ONE }));
    expect(screen.getByTestId('tab-empty')).toHaveTextContent('Every number that writes in');
  });
});

describe('★★ 13b · Activity', () => {
  it('a known step in our words, its outcome, the number and when; Meta’s message as it came', async () => {
    render(
      await ActivityTab({
        events: [
          {
            ...numberEventSchema.parse({
              id: 'e1',
              step: 'REGISTER_NUMBER',
              outcome: 'FAILED',
              message: 'Two-step PIN mismatch',
              createdAt: '2026-10-07T08:05:00Z',
            }),
            number: '+972 54 000 0000',
          },
          {
            ...numberEventSchema.parse({
              id: 'e2',
              step: 'SOMETHING_NEW',
              outcome: 'SUCCESS',
              createdAt: '2026-10-06T08:05:00Z',
            }),
            number: null,
          },
        ],
      }),
    );
    const failed = screen.getByTestId('tab-event-e1');
    expect(failed).toHaveTextContent('Number registered · failed');
    expect(failed).toHaveTextContent('+972 54 000 0000');
    expect(failed).toHaveTextContent('Two-step PIN mismatch');
    expect(failed).toHaveAttribute('data-outcome', 'FAILED');
    expect(screen.getByTestId('tab-event-e2')).toHaveTextContent('SOMETHING_NEW · done');
  });

  it('none recorded: said', async () => {
    render(await ActivityTab({ events: [] }));
    expect(screen.getByTestId('tab-empty')).toHaveTextContent('Nothing recorded');
  });
});

describe('★★ 13b · Private contacts, live', () => {
  const type = (id: string, value: string) =>
    fireEvent.change(screen.getByTestId(id), { target: { value } });

  it('add: a number and a note go to the route', async () => {
    actions.addPrivateContact.mockResolvedValue({ ok: true });
    render(await ContactsTab({ exclusions: [], numbers: ONE }));
    type('contact-number', '054-123-4567');
    type('contact-note', 'My mother');
    await act(async () => {
      fireEvent.submit(screen.getByTestId('contact-add'));
    });
    expect(actions.addPrivateContact).toHaveBeenCalledWith({
      value: '054-123-4567',
      note: 'My mother',
      // The one number is the one: sent without asking.
      channelAccountId: 'ca1',
    });
    expect(screen.getByTestId('contact-number')).toHaveValue('');
  });

  it('★ not a phone number: said here, and never sent', async () => {
    render(await ContactsTab({ exclusions: [], numbers: ONE }));
    for (const bad of ['12345', 'mom', '054-12a-4567']) {
      type('contact-number', bad);
      await act(async () => {
        fireEvent.submit(screen.getByTestId('contact-add'));
      });
      expect(screen.getByTestId('contact-add-problem')).toHaveTextContent('at least 6 digits');
    }
    expect(actions.addPrivateContact).not.toHaveBeenCalled();
  });

  it('the route refusing the number: its reason, in the same words', async () => {
    actions.addPrivateContact.mockResolvedValue({ ok: false, reason: 'invalid_number' });
    render(await ContactsTab({ exclusions: [], numbers: ONE }));
    type('contact-number', '000000');
    await act(async () => {
      fireEvent.submit(screen.getByTestId('contact-add'));
    });
    expect(screen.getByTestId('contact-add-problem')).toHaveTextContent('at least 6 digits');
  });

  it('remove: a short "are you sure", then the route', async () => {
    actions.removePrivateContact.mockResolvedValue({ ok: true });
    render(
      await ContactsTab({
        numbers: ONE,
        exclusions: [exclusionSchema.parse({ id: 'x1', value: '054-123-4567', normalized: '1' })],
      }),
    );
    fireEvent.click(screen.getByTestId('contact-remove-x1'));
    expect(screen.getByTestId('tab-contact-x1')).toHaveTextContent('will reach GOTCHA again');
    expect(actions.removePrivateContact).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByTestId('contact-remove-yes-x1'));
    });
    expect(actions.removePrivateContact).toHaveBeenCalledWith('x1');
  });
});

describe('★★ 13b · Private contacts are per WhatsApp number (Backend, 2026-10-07)', () => {
  const type = (id: string, value: string) =>
    fireEvent.change(screen.getByTestId(id), { target: { value } });
  const submit = () =>
    act(async () => {
      fireEvent.submit(screen.getByTestId('contact-add'));
    });

  it('one number: no picker, it is said which, and every add goes to it', async () => {
    render(await ContactsTab({ exclusions: [], numbers: ONE }));
    expect(screen.queryByTestId('contact-on')).toBeNull();
    expect(screen.getByTestId('contact-on-one')).toHaveTextContent('Private on +972 54 000 0000.');
  });

  it('★ several: a number is chosen, never guessed - unchosen is said and nothing is sent', async () => {
    actions.addPrivateContact.mockResolvedValue({ ok: true });
    render(await ContactsTab({ exclusions: [], numbers: TWO }));
    type('contact-number', '054-123-4567');
    await submit();
    expect(screen.getByTestId('contact-add-problem')).toHaveTextContent(
      "Choose which of your WhatsApp numbers it's private on.",
    );
    expect(actions.addPrivateContact).not.toHaveBeenCalled();
    type('contact-on', 'ca2');
    await submit();
    expect(actions.addPrivateContact).toHaveBeenCalledWith({
      value: '054-123-4567',
      note: '',
      channelAccountId: 'ca2',
    });
  });

  it('★ each rule says which number; one from before is on every number and says "All numbers"', async () => {
    render(
      await ContactsTab({
        numbers: TWO,
        exclusions: [
          exclusionSchema.parse({ id: 'x1', value: '050', channelAccountId: 'ca2' }),
          exclusionSchema.parse({ id: 'x2', value: '052', channelAccountId: null }),
          exclusionSchema.parse({ id: 'x3', value: '053', channelAccountId: 'gone' }),
        ],
      }),
    );
    expect(screen.getByTestId('tab-contact-on-x1')).toHaveTextContent('+972 3 555 0000');
    expect(screen.getByTestId('tab-contact-on-x2')).toHaveTextContent(/^All numbers$/);
    expect(screen.getByTestId('tab-contact-on-x3')).toHaveTextContent(
      'A number no longer connected',
    );
  });

  it('with one number, a rule on it needs no label - a rule from before still says "All numbers"', async () => {
    render(
      await ContactsTab({
        numbers: ONE,
        exclusions: [
          exclusionSchema.parse({ id: 'x1', value: '050', channelAccountId: 'ca1' }),
          exclusionSchema.parse({ id: 'x2', value: '052', channelAccountId: null }),
        ],
      }),
    );
    expect(screen.queryByTestId('tab-contact-on-x1')).toBeNull();
    expect(screen.getByTestId('tab-contact-on-x2')).toHaveTextContent('All numbers');
  });

  it('no number connected: Add cannot be pressed, and why is said', async () => {
    render(await ContactsTab({ exclusions: [], numbers: [] }));
    type('contact-number', '054-123-4567');
    expect(screen.getByTestId('contact-add-submit')).toBeDisabled();
    expect(screen.getByTestId('contact-no-numbers')).toHaveTextContent(
      'Connect a WhatsApp number first',
    );
  });

  it('the number went away meanwhile: said in those words, not as a bad phone number', async () => {
    actions.addPrivateContact.mockResolvedValue({ ok: false, reason: 'number_gone' });
    render(await ContactsTab({ exclusions: [], numbers: ONE }));
    type('contact-number', '054-123-4567');
    await submit();
    expect(screen.getByTestId('contact-add-problem')).toHaveTextContent(
      "That WhatsApp number isn't connected here any more",
    );
  });
});
