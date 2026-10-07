import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { employeeSchema } from '@/api/contracts/employees';
import employees from '@/i18n/messages/en/employees.json';

vi.mock('@/i18n/navigation', () => ({
  Link: ({
    href,
    children,
    scroll: _scroll,
    ...rest
  }: {
    href: { pathname: string; query?: Record<string, string> };
    children: ReactNode;
    scroll?: boolean;
  }) => (
    <a href={`${href.pathname}?${new URLSearchParams(href.query)}`} {...rest}>
      {children}
    </a>
  ),
}));
// No test may write: anything that reaches the actions fails loudly.
vi.mock('../actions', () => ({
  setEmployeeStatus: () => {
    throw new Error('write');
  },
  deleteEmployee: () => {
    throw new Error('write');
  },
}));

import { EditSheet } from './EditSheet';

const employee = (over: Record<string, unknown> = {}) =>
  employeeSchema.parse({
    id: 'a',
    name: 'Maya',
    tone: 'friendly',
    languages: { english: true },
    identity: { responsibility: 'After-sale questions' },
    escalationRules: [{ label: 'Asks for a person', enabled: true }],
    openConversations: 3,
    ...over,
  });

const sheet = (over: Record<string, unknown> = {}, props: Record<string, unknown> = {}) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ employees }} timeZone="UTC">
      <EditSheet
        employee={employee(over)}
        tools={['Shopify']}
        mayDo={[
          { toolName: 'shopify.process_refund', label: 'Refund an order', stance: 'ask_first' },
        ]}
        {...props}
      />
    </NextIntlClientProvider>,
  );

describe('★★ 07f - the profile’s sentences, editable; Save drawn, not live', () => {
  it('the head names it and says the truth about open conversations', () => {
    sheet();
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Edit Maya');
    // The runtime reads the employee per reply: open conversations take the change.
    expect(screen.getByTestId('edit-line')).toHaveTextContent(
      'Changes apply from its next reply - in its 3 open conversations too',
    );
    expect(screen.getByTestId('edit-line')).not.toHaveTextContent(/finish under the current/);
  });

  it('no open conversation: no count of nothing', () => {
    sheet({ openConversations: 0 });
    expect(screen.getByTestId('edit-line')).toHaveTextContent(
      /^Changes apply from its next reply$/,
    );
  });

  it('starts with no changes; each edit counts once, and undoing it uncounts', async () => {
    sheet();
    const changes = screen.getByTestId('edit-changes');
    expect(changes).toHaveTextContent('No changes');
    await userEvent.click(screen.getByTestId('edit-tone-formal'));
    expect(screen.getByTestId('edit-tone-formal')).toHaveAttribute('aria-checked', 'true');
    expect(changes).toHaveTextContent('1 change');
    await userEvent.click(screen.getByTestId('edit-language-hebrew'));
    await userEvent.click(screen.getByTestId('edit-rule-0'));
    expect(changes).toHaveTextContent('3 changes');
    await userEvent.click(screen.getByTestId('edit-tone-friendly'));
    expect(changes).toHaveTextContent('2 changes');
  });

  it('★ Save is drawn, not live, and says why', async () => {
    sheet();
    await userEvent.click(screen.getByTestId('edit-tone-formal'));
    const save = screen.getByTestId('edit-save');
    expect(save).toHaveAttribute('aria-disabled', 'true');
    expect(save).toHaveAttribute('title', expect.stringMatching(/waiting for approval/));
    await userEvent.click(save);
  });

  it('what it may do is the business’s: the current stance marked, none of them a control', () => {
    sheet();
    const card = screen.getByTestId('edit-may-do');
    expect(within(card).getByText('Refund an order')).toBeInTheDocument();
    const ask = screen.getByTestId('edit-may-shopify.process_refund-ask_first');
    expect(ask).toHaveAttribute('data-current', 'yes');
    expect(screen.getByTestId('edit-may-shopify.process_refund-on_its_own')).toHaveAttribute(
      'data-current',
      'no',
    );
    expect(ask).toHaveAttribute('aria-disabled', 'true');
    expect(ask).toHaveAttribute('title', expect.stringMatching(/every AI employee/));
  });

  it('drawn in their shape, each with its reason: topics, sign-off, disclosure, target, preview', () => {
    sheet();
    expect(within(screen.getByTestId('edit-handles')).getByText('-')).toHaveAttribute(
      'title',
      expect.stringMatching(/grouped by topic/),
    );
    expect(screen.getByTitle(/No sign-off is stored/)).toHaveTextContent('-');
    expect(screen.getByTitle(/No disclosure rule/)).toHaveTextContent('-');
    expect(screen.getByTitle(/No handover target/)).toHaveTextContent('-');
    expect(screen.getByTestId('edit-preview')).toHaveTextContent('-');
  });

  it('where it answers and what is connected are read, and say where they are set', () => {
    sheet();
    // Not a channel list: where it answers is the playbook's and automations'.
    expect(screen.getByTestId('edit-channels')).not.toHaveTextContent('WhatsApp');
    expect(screen.getByTestId('edit-channels')).toHaveTextContent('set in Studio · Automations');
    expect(screen.getByTestId('edit-tools')).toHaveTextContent('Shopify');
  });

  it('a failed read is "-" with its reason, never an empty list', () => {
    sheet({}, { tools: null, mayDo: null });
    expect(within(screen.getByTestId('edit-tools')).getByText('-')).toHaveAttribute(
      'title',
      expect.stringMatching(/couldn't read/),
    );
    expect(within(screen.getByTestId('edit-may-do')).getByText('-')).toHaveAttribute(
      'title',
      expect.stringMatching(/couldn't read/),
    );
  });

  it('an empty responsibility shows what belongs there, not a blank box', () => {
    sheet({ identity: null });
    expect(screen.getByTestId('edit-responsibility')).toHaveValue('');
    expect(screen.getByTestId('edit-responsibility')).toHaveAttribute(
      'placeholder',
      expect.stringMatching(/^What this employee is responsible for/),
    );
  });

  it('Cancel and ✕ go back to the employee', () => {
    sheet();
    expect(screen.getByText('Cancel')).toHaveAttribute('href', '/studio/employees?employee=a');
  });
});

describe('★★ 07f - the business systems it may use (Backend 00c6c229; ruling (b))', () => {
  const ACCESS = {
    allowed: ['shopify'],
    choices: [
      { key: 'shopify', kind: 'integration', name: 'Shopify', status: 'ERROR' },
      { key: 'woocommerce', kind: 'integration', name: 'WooCommerce', status: 'CONNECTED' },
      { key: 'custom:t1', kind: 'custom_api', name: 'Stock lookup', status: 'INACTIVE' },
    ],
  };

  it('each system the workspace has, On or Off for this employee, its connection in words', () => {
    sheet({}, { access: ACCESS });
    expect(screen.getByTestId('edit-system-shopify')).toHaveTextContent('Shopify');
    expect(screen.getByTestId('edit-system-shopify')).toHaveTextContent('Connected, but failing');
    expect(screen.getByTestId('edit-system-shopify-on')).toHaveTextContent(/^On$/);
    expect(screen.getByTestId('edit-system-woocommerce')).toHaveTextContent('Connected');
    expect(screen.getByTestId('edit-system-woocommerce-on')).toHaveTextContent(/^Off$/);
    expect(screen.getByTestId('edit-system-custom:t1')).toHaveTextContent('Switched off');
  });

  it('★ a status, not a switch: nothing to press until saving a working employee is approved', () => {
    sheet({}, { access: ACCESS });
    const card = screen.getByTestId('edit-systems');
    expect(card.querySelector('input, button')).toBeNull();
    expect(screen.getByTestId('edit-system-shopify-on')).toHaveAttribute('aria-disabled', 'true');
  });

  it('★ the rule for systems connected later is said', () => {
    sheet({}, { access: ACCESS });
    expect(screen.getByTestId('edit-systems-later')).toHaveTextContent(
      'A system you connect later is off for every employee until you turn it on here.',
    );
  });

  it('unread: "-", never every system shown Off', () => {
    sheet({}, { access: null });
    expect(screen.getByTestId('edit-systems-unread')).toBeInTheDocument();
    expect(screen.queryByTestId('edit-systems-rows')).toBeNull();
  });
});
