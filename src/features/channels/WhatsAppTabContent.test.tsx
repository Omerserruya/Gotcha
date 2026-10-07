import { act, fireEvent, render as rtlRender, screen } from '@testing-library/react';
import { createFormatter, createTranslator, NextIntlClientProvider } from 'next-intl';
import type { ReactElement, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

  it('none, and unread, are different sentences', async () => {
    const none = render(await TemplatesTab({ templates: [] }));
    expect(screen.getByTestId('tab-empty')).toHaveTextContent('No WhatsApp templates yet');
    none.unmount();
    render(await TemplatesTab({ templates: null }));
    expect(screen.getByTestId('tab-unread')).toHaveTextContent("Couldn't read");
  });
});

describe('★★ 13b · Private contacts', () => {
  it('each as it was typed, with its note', async () => {
    render(
      await ContactsTab({
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
    render(await ContactsTab({ exclusions: [] }));
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
    render(await ContactsTab({ exclusions: [] }));
    type('contact-number', '054-123-4567');
    type('contact-note', 'My mother');
    await act(async () => {
      fireEvent.submit(screen.getByTestId('contact-add'));
    });
    expect(actions.addPrivateContact).toHaveBeenCalledWith({
      value: '054-123-4567',
      note: 'My mother',
      channelAccountId: null,
    });
    expect(screen.getByTestId('contact-number')).toHaveValue('');
  });

  it('★ not a phone number: said here, and never sent', async () => {
    render(await ContactsTab({ exclusions: [] }));
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
    render(await ContactsTab({ exclusions: [] }));
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
