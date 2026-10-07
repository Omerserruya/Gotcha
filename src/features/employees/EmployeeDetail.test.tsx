import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { capabilitySchema } from '@/api/contracts/capabilities';
import { employeeSchema } from '@/api/contracts/employees';
import { integrationSchema } from '@/api/contracts/integrations';
import channels from '@/i18n/messages/en/channels.json';
import employees from '@/i18n/messages/en/employees.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'employees') =>
    createTranslator({ locale: 'en', messages: { employees, channels }, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en' }),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({
    href,
    children,
    scroll: _scroll,
    ...rest
  }: {
    href: string | { pathname: string; query?: Record<string, string> };
    children: React.ReactNode;
    scroll?: boolean;
  }) => (
    <a
      href={typeof href === 'string' ? href : `${href.pathname}?${new URLSearchParams(href.query)}`}
      {...rest}
    >
      {children}
    </a>
  ),
}));
vi.mock('./PauseEmployee', () => ({ PauseEmployee: () => <button type="button">Pause</button> }));
vi.mock('./DeleteEmployee', () => ({ DeleteEmployee: () => null }));

import { EmployeeDetail } from './EmployeeDetail';

const employee = (over: Record<string, unknown> = {}) =>
  employeeSchema.parse({ id: 'a', name: 'Customer Support', role: 'customer_support', ...over });

const show = async (
  over: Record<string, unknown> = {},
  extra: { capabilities?: unknown[] | null; integrations?: unknown[] | null } = {},
) =>
  render(
    await EmployeeDetail({
      employee: employee(over),
      capabilities:
        extra.capabilities === null
          ? null
          : (extra.capabilities ?? []).map((c) => capabilitySchema.parse(c)),
      integrations:
        extra.integrations === null
          ? null
          : (extra.integrations ?? []).map((i) => integrationSchema.parse(i)),
    }),
  );

describe('★★ 07’s detail - what it is, from what the route already sends', () => {
  it('★ the line under the name is its responsibility, else its goal, else its role', async () => {
    const { unmount } = await show({ identity: { responsibility: 'Anything after the sale.' } });
    expect(screen.getByTestId('detail-line')).toHaveTextContent('Anything after the sale.');
    unmount();
    const goal = await show({ goal: 'Resolve without a person.' });
    expect(screen.getByTestId('detail-line')).toHaveTextContent('Resolve without a person.');
    goal.unmount();
    await show({ role: '' });
    expect(screen.getByTestId('detail-line')).toHaveTextContent(
      'Nobody has said what this one is for.',
    );
  });

  it('★★ the strip: all-time handled, the alone rate, and "-" for what nothing records', async () => {
    await show({ handledConversations: 40, resolvedAlone: 30 });
    const strip = screen.getByTestId('detail-strip');
    expect(strip).toHaveTextContent('Handled in all40');
    expect(strip).toHaveTextContent('Resolved alone75%');
    expect(strip).toHaveTextContent('Passed to a person-');
    expect(strip).toHaveTextContent('Customer rating-');
    expect(strip).not.toHaveTextContent(/today/i);
  });

  it('★ nothing routed yet: the alone rate is "-", never 0%', async () => {
    await show({ handledConversations: 0, resolvedAlone: 0 });
    expect(screen.getByTestId('detail-strip')).toHaveTextContent('Resolved alone-');
  });

  it('★★ "Answers on" says where it is decided, with the way there - never "nothing reaches it"', async () => {
    // The field the route still sends is read by nothing at runtime (Backend, 2026-10-07).
    await show({ channels: ['whatsapp'] });
    const card = screen.getByTestId('card-answers-on');
    expect(card).not.toHaveTextContent('WhatsApp');
    expect(card).not.toHaveTextContent(/nothing reaches it/i);
    expect(card).toHaveTextContent('set in Studio · Automations and the playbook');
    expect(card.querySelector('a')).toHaveAttribute('href', '/studio/automations');
  });

  it('how it answers: the tone and the languages it is switched on for', async () => {
    await show({ tone: 'friendly', languages: { hebrew: true, english: true, arabic: false } });
    const card = screen.getByTestId('card-how');
    expect(card).toHaveTextContent('Friendly');
    expect(card).toHaveTextContent('Hebrew · English');
    expect(card).not.toHaveTextContent('Arabic');
  });

  it('★★ what it may do: the tenant’s stance per action, and that it is everyone’s', async () => {
    await show(
      {},
      {
        capabilities: [
          { toolName: 'shopify.lookup_order', kind: 'action', enabled: true },
          { toolName: 'shopify.refund', kind: 'action', enabled: true, requiresApproval: true },
          { toolName: 'crm.update', kind: 'action', enabled: false },
        ],
      },
    );
    expect(screen.getByTestId('may-shopify.lookup_order')).toHaveTextContent('Allowed');
    expect(screen.getByTestId('may-shopify.refund')).toHaveTextContent('Ask first');
    expect(screen.getByTestId('may-crm.update')).toHaveTextContent('Never');
    expect(screen.getByTestId('card-may-do')).toHaveTextContent('The same for every AI employee');
  });

  it('⚠ a failed permissions read is said, not drawn as "nothing it can do"', async () => {
    await show({}, { capabilities: null });
    expect(screen.getByTestId('card-may-do')).toHaveTextContent("We couldn't read");
  });

  it('★★ what it knows: each source, and a switched-off one said out loud', async () => {
    await show({
      knowledgeSources: [
        { id: 'k1', name: 'Shipping', isActive: true },
        { id: 'faq_old', name: '', isActive: false },
      ],
    });
    const card = screen.getByTestId('card-knows');
    expect(card).toHaveTextContent('ShippingReads it');
    // A source with no name falls back to its id, humanised.
    expect(card).toHaveTextContent('FAQ old');
    expect(card).toHaveTextContent('Switched off');
  });

  it('connected tools are the connected systems only', async () => {
    await show(
      {},
      {
        integrations: [
          {
            id: 'i1',
            slug: 'shopify',
            name: 'Shopify',
            tenantConnection: { id: 'c1', status: 'ACTIVE' },
          },
          { id: 'i2', slug: 'hubspot', name: 'HubSpot' },
        ],
      },
    );
    const card = screen.getByTestId('card-tools');
    expect(card).toHaveTextContent('Shopify');
    expect(card).not.toHaveTextContent('HubSpot');
  });

  it('★ hands over on the rules that are ON and say something', async () => {
    await show({
      escalationRules: [
        { label: 'Asks for a person', enabled: true },
        { label: 'Order over ₪1,000', enabled: false },
        { label: '  ', enabled: true },
      ],
    });
    const card = screen.getByTestId('card-handover');
    expect(card).toHaveTextContent('Asks for a person');
    expect(card).not.toHaveTextContent('Order over');
  });

  it('★★ a malformed field cannot reject the employee - it reads as empty', () => {
    const parsed = employeeSchema.parse({
      id: 'a',
      name: 'X',
      tone: 42,
      languages: 'hebrew',
      escalationRules: 'none',
      identity: 'oops',
    });
    expect(parsed).toMatchObject({ tone: '', languages: {}, escalationRules: [], identity: null });
  });

  it('drawn in their shape: what it handles, a reply from today, worth changing', async () => {
    await show();
    expect(screen.getByTestId('card-handles')).toHaveTextContent("aren't grouped by topic yet");
    expect(screen.getByTestId('card-how')).toHaveTextContent('No reply is picked out yet.');
    expect(screen.getByTestId('card-worth')).toHaveTextContent('Nothing to suggest yet.');
  });

  it('★ 07f - Edit opens the sheet over this employee', async () => {
    await show();
    const edit = screen.getByTestId('edit');
    expect(edit).not.toHaveAttribute('aria-disabled');
    expect(edit).toHaveAttribute('href', '/studio/employees?employee=a&edit=1');
  });
});
