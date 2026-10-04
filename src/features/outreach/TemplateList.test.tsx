import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { templateSchema, type Template } from '@/api/contracts/templates';
import channels from '@/i18n/messages/en/channels.json';
import outreach from '@/i18n/messages/en/outreach.json';
import templates from '@/i18n/messages/en/templates.json';

/* Send / Submit reach outside; they have their own tests. Here: whether each is offered. */
vi.mock('./SendButtons', () => ({
  SendCampaign: ({ id }: { id: string }) => <span data-testid={`send-${id}`} />,
  SubmitTemplate: ({ id }: { id: string }) => <span data-testid={`submit-live-${id}`} />,
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'templates' | 'channels') =>
    createTranslator({ locale: 'en', messages: { templates, channels, outreach }, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'UTC' }),
  getLocale: async () => 'en',
}));
/* The copy button is a client island; it gets its own test. */
vi.mock('./DuplicateTemplate', () => ({
  DuplicateTemplate: ({ id }: { id: string }) => (
    <button type="button" data-testid="template-duplicate" data-id={id}>
      Duplicate and edit
    </button>
  ),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: { pathname: string; query?: Record<string, string> };
    children: ReactNode;
  }) => (
    <a href={`${href.pathname}?${new URLSearchParams(href.query ?? {})}`} {...rest}>
      {children}
    </a>
  ),
}));

import {
  RejectedCard,
  selectedGroup,
  TemplatePreview,
  TemplateTable,
  templateGroups,
  WorthKnowing,
} from './TemplateList';

/**
 * Screen 05c. This tenant has no templates, so dev photographs the empty
 * frame; these are the rows a real tenant will have, built through the real
 * contract so each is a shape the list route can send.
 */
const template = (over: Record<string, unknown> = {}): Template =>
  templateSchema.parse({
    id: 't1',
    name: 'Back in stock',
    language: 'en',
    channel: 'WHATSAPP',
    body: 'Hi {{1}} — the {{2}} is back in stock.',
    status: 'APPROVED',
    buttons: [{ type: 'QUICK_REPLY', text: 'See it' }, { text: 'Not now' }],
    variables: [
      { key: '1', sample: 'Dana', description: 'The customer' },
      { key: '2', sample: 'linen lamp', description: 'The product' },
    ],
    ...over,
  });

describe('★★ the table — every state drawn in the same frame', () => {
  it('★ a row per name: the body with its variables in braces, "—" for what nothing counts', async () => {
    const groups = templateGroups([template()]);
    render(await TemplateTable({ groups, selectedId: 't1' }));
    const row = screen.getByTestId('template-t1');
    expect(row).toHaveTextContent('Back in stock');
    expect(row).toHaveTextContent('Hi {Dana} — the {linen lamp} is back in stock.');
    expect(row.textContent?.match(/—/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(row).toHaveAttribute('aria-current', 'true');
    expect(row).toHaveAttribute('href', '/outreach/templates?template=t1');
  });

  it.each([
    ['APPROVED', 'WHATSAPP', 'Ready to send'],
    ['PENDING_APPROVAL', 'WHATSAPP', 'Being reviewed'],
    ['REJECTED', 'WHATSAPP', 'Rejected'],
    ['DRAFT', 'WHATSAPP', 'Not sent for review'],
    ['APPROVED', 'EMAIL', 'Email only'],
  ])('★ %s on %s says what you can do: "%s"', async (status, channel, words) => {
    render(
      await TemplateTable({
        groups: templateGroups([template({ status, channel })]),
        selectedId: null,
      }),
    );
    expect(screen.getByTestId('stance-t1')).toHaveTextContent(words);
  });

  it('★ the window note is the table’s foot, in every state', async () => {
    for (const groups of [null, [], templateGroups([template()])]) {
      const { unmount } = render(await TemplateTable({ groups, selectedId: null }));
      expect(screen.getByTestId('window-note')).toHaveTextContent('24 hours');
      unmount();
    }
  });

  it('⚠ a failed read is not an empty list', async () => {
    const { unmount } = render(await TemplateTable({ groups: null, selectedId: null }));
    expect(screen.getByTestId('templates-unavailable')).toBeInTheDocument();
    unmount();
    render(await TemplateTable({ groups: [], selectedId: null }));
    expect(screen.getByTestId('templates-empty')).toHaveTextContent('No templates yet.');
    expect(screen.queryByTestId('templates-unavailable')).toBeNull();
  });

  it('selectedGroup: the wanted id, in any language of the group, else the first', () => {
    const groups = templateGroups([
      template(),
      template({ id: 't1-he', language: 'he' }),
      template({ id: 't2', name: 'Order shipped' }),
    ]);
    expect(selectedGroup(groups, 't1-he')?.name).toBe('Back in stock');
    // A language that is not the group's first, in a group that is not first:
    // the fallback alone could not give this answer.
    const later = templateGroups([
      template({ id: 'x', name: 'Order shipped' }),
      template(),
      template({ id: 't1-he', language: 'he' }),
    ]);
    expect(selectedGroup(later, 't1-he')?.name).toBe('Back in stock');
    expect(selectedGroup(groups, 't2')?.name).toBe('Order shipped');
    expect(selectedGroup(groups, 'nope')?.name).toBe('Back in stock');
    expect(selectedGroup([], undefined)).toBeNull();
  });
});

describe('★★ the preview — the message as the customer sees it', () => {
  it('★ the bubble: variables highlighted by their sample, the real buttons under it', async () => {
    render(await TemplatePreview({ group: templateGroups([template()])[0]! }));
    const bubble = screen.getByTestId('template-bubble');
    const marks = [...bubble.querySelectorAll('mark')].map((m) => m.textContent);
    expect(marks).toEqual(['Dana', 'linen lamp']);
    expect(screen.getByTestId('template-preview')).toHaveTextContent('See it');
    expect(screen.getByTestId('template-preview')).toHaveTextContent('Not now');
  });

  it('the languages it exists in, by name', async () => {
    render(
      await TemplatePreview({
        group: templateGroups([template(), template({ id: 't1-he', language: 'he' })])[0]!,
      }),
    );
    expect(screen.getByTestId('template-languages')).toHaveTextContent('English, Hebrew');
  });

  it('★ the facts: filled in from the descriptions; who may send "—"; approved, unchanged', async () => {
    render(await TemplatePreview({ group: templateGroups([template()])[0]! }));
    const preview = screen.getByTestId('template-preview');
    expect(preview).toHaveTextContent('The customer and the product');
    expect(preview).toHaveTextContent('Who may send it—');
    expect(screen.getByTestId('template-approved')).toHaveTextContent('never changed since');
  });

  it('⚠ approved and since changed says so — no date is invented', async () => {
    render(await TemplatePreview({ group: templateGroups([template({ version: 3 })])[0]! }));
    expect(screen.getByTestId('template-approved')).toHaveTextContent('now version 3');
  });

  it('★ approved: "Use in a campaign" opens the draft drawer with it chosen; Duplicate is live', async () => {
    render(await TemplatePreview({ group: templateGroups([template()])[0]! }));
    expect(screen.getByTestId('template-use')).toHaveAttribute(
      'href',
      '/outreach?create=campaign&template=t1',
    );
    expect(screen.getByTestId('template-duplicate')).toHaveAttribute('data-id', 't1');
    // Not a draft: nothing to submit.
    expect(screen.queryByTestId('template-submit')).toBeNull();
  });

  it('★ a draft cannot be used yet; with no WhatsApp Business account, Submit is drawn with why', async () => {
    const draft = templateGroups([template({ status: 'DRAFT', channel: 'WHATSAPP' })])[0]!;
    const one = render(await TemplatePreview({ group: draft, waba: false }));
    expect(screen.getByTestId('template-use')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('template-use')).not.toHaveAttribute('href');
    expect(screen.getByTestId('template-submit')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('template-submit').getAttribute('title')).toMatch(
      /WhatsApp Business account/,
    );
    one.unmount();
    // Omer: with one, Submit is live.
    render(await TemplatePreview({ group: draft, waba: true }));
    expect(screen.queryByTestId('template-submit')).toBeNull();
    expect(screen.getByTestId(`submit-live-${'t1'}`)).toBeInTheDocument();
  });

  it('a template for every channel never goes to WhatsApp for review — said', async () => {
    const all = templateGroups([template({ status: 'DRAFT', channel: null })])[0]!;
    render(await TemplatePreview({ group: all, waba: true }));
    expect(screen.getByTestId('template-submit').getAttribute('title')).toMatch(
      /Only a WhatsApp template/,
    );
  });

  it('no template: the card keeps its place', async () => {
    render(await TemplatePreview({ group: null }));
    expect(screen.getByTestId('template-preview')).toHaveTextContent('—');
  });
});

describe('★ the rejection, and what is worth knowing', () => {
  it('★ the first rejected template, in WhatsApp’s own words', async () => {
    render(
      await RejectedCard({
        groups: templateGroups([
          template(),
          template({
            id: 't3',
            name: 'Autumn early access',
            status: 'REJECTED',
            rejectionReason: 'Promotional content in a utility template',
          }),
        ]),
      }),
    );
    const card = screen.getByTestId('template-rejected');
    expect(card).toHaveTextContent('Autumn early access was rejected');
    expect(card).toHaveTextContent('Promotional content in a utility template');
  });

  it('⚠ nothing rejected: no card — a pink card announcing nothing would alarm', async () => {
    const { container } = render(
      <>{await RejectedCard({ groups: templateGroups([template()]) })}</>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('"Worth knowing" keeps its place with nothing yet', async () => {
    render(await WorthKnowing());
    expect(screen.getByTestId('template-worth')).toHaveTextContent('Nothing yet.');
  });
});

describe('★★ switched off is not ready (measured: "Ready to send" on an inactive template)', () => {
  it('★★ approved and inactive says "Switched off" — the bot’s own gate is isActive AND APPROVED', async () => {
    render(
      await TemplateTable({
        groups: templateGroups([template({ isActive: false })]),
        selectedId: null,
      }),
    );
    const chip = screen.getByTestId('stance-t1');
    expect(chip).toHaveTextContent('Switched off');
    expect(chip).not.toHaveTextContent('Ready to send');
    expect(chip).toHaveAttribute('data-stance', 'off');
  });

  it('an inactive template on another channel is switched off too', async () => {
    render(
      await TemplateTable({
        groups: templateGroups([template({ channel: 'EMAIL', isActive: false })]),
        selectedId: null,
      }),
    );
    expect(screen.getByTestId('stance-t1')).toHaveTextContent('Switched off');
  });

  it('⚠ rejected and inactive keeps saying rejected — that is the reason it cannot send', async () => {
    render(
      await TemplateTable({
        groups: templateGroups([template({ status: 'REJECTED', isActive: false })]),
        selectedId: null,
      }),
    );
    expect(screen.getByTestId('stance-t1')).toHaveTextContent('Rejected');
  });

  it('the preview: approved, and switched off, so nothing sends it', async () => {
    render(await TemplatePreview({ group: templateGroups([template({ isActive: false })])[0]! }));
    expect(screen.getByTestId('template-approved')).toHaveTextContent('switched off');
    expect(screen.getByTestId('template-approved')).not.toHaveAttribute('data-ok');
  });
});

describe('★ "Filled in from" is one sentence', () => {
  it('lowercase after the first, no comma before "and"', async () => {
    render(
      await TemplatePreview({
        group: templateGroups([
          template({
            variables: [
              { key: '1', description: 'The customer' },
              { key: '2', description: 'The product' },
              { key: '3', description: 'When they asked' },
            ],
          }),
        ])[0]!,
      }),
    );
    expect(screen.getByTestId('template-filled-from')).toHaveTextContent(
      /^The customer, the product and when they asked$/,
    );
  });
});
