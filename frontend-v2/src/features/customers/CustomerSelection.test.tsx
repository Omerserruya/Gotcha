import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import customers from '@/i18n/messages/en/customers.json';

const refresh = vi.hoisted(() => vi.fn());
const tagCustomers = vi.hoisted(() => vi.fn());
/* Tagging writes to real contacts: the action is a spy, and nothing here reaches it. */
vi.mock('./tag-actions', () => ({ tagCustomers }));
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ refresh }),
  Link: ({ href, children, ...rest }: { href: unknown; children: ReactNode }) => (
    <a href={typeof href === 'string' ? href : JSON.stringify(href)} {...rest}>
      {children}
    </a>
  ),
}));

import { CustomerSelection } from './CustomerSelection';

beforeEach(() => {
  refresh.mockReset();
  tagCustomers.mockReset();
});

/* Two people, as CustomerList draws them: Dana has two identities. */
const list = () =>
  render(
    <NextIntlClientProvider locale="en" messages={{ customers }}>
      <CustomerSelection>
        <ul>
          <li data-person="p1" data-contacts="k1,k2" data-testid="row-p1">
            <a href="/customers/k1" data-testid="open-p1">
              Dana
            </a>
          </li>
          <li data-person="p2" data-contacts="k3" data-testid="row-p2">
            <a href="/customers/k3" data-testid="open-p2">
              Noa
            </a>
          </li>
        </ul>
        <div data-select-slot="" data-testid="foot">
          <span>Showing 2 of 2</span>
        </div>
      </CustomerSelection>
    </NextIntlClientProvider>,
  );

const href = () => JSON.parse(screen.getByTestId('select-message').getAttribute('href')!);

describe('★★ 04 - shift-click picks, a click still opens', () => {
  it('a plain click picks nobody', async () => {
    list();
    await userEvent.click(screen.getByTestId('open-p1'));
    expect(screen.queryByTestId('select-bar')).toBeNull();
    expect(screen.getByTestId('row-p1')).not.toHaveAttribute('data-selected');
  });

  it('shift and ⌘ pick; the bar counts people, Message carries every identity of them', async () => {
    const user = userEvent.setup();
    list();
    await user.keyboard('{Shift>}');
    await user.click(screen.getByTestId('open-p1'));
    await user.keyboard('{/Shift}{Meta>}');
    await user.click(screen.getByTestId('open-p2'));
    await user.keyboard('{/Meta}');
    expect(screen.getByTestId('select-bar')).toHaveTextContent('2 selected');
    expect(screen.getByTestId('row-p1')).toHaveAttribute('data-selected', 'yes');
    expect(href()).toEqual({
      pathname: '/outreach',
      query: { create: 'campaign', contacts: 'k1,k2,k3' },
    });
  });

  it('the bar stands in the foot’s place, inside the card - never over it (measured on dev)', async () => {
    const user = userEvent.setup();
    list();
    await user.keyboard('{Shift>}');
    await user.click(screen.getByTestId('open-p1'));
    await user.keyboard('{/Shift}');
    const foot = screen.getByTestId('foot');
    expect(foot).toContainElement(screen.getByTestId('select-bar'));
    expect(foot).toHaveAttribute('data-picking', 'yes');
    await user.click(screen.getByTestId('select-clear'));
    expect(foot).not.toHaveAttribute('data-picking');
  });

  it('★ Tag: a field and Add - one tag on every identity picked; done, the pick clears', async () => {
    const user = userEvent.setup();
    tagCustomers.mockResolvedValue({ ok: true, tagged: 3 });
    list();
    await user.keyboard('{Shift>}');
    await user.click(screen.getByTestId('open-p1'));
    await user.click(screen.getByTestId('open-p2'));
    await user.keyboard('{/Shift}');
    await user.click(screen.getByTestId('select-tag'));
    expect(screen.getByTestId('select-tag-add')).toBeDisabled();
    await user.type(screen.getByTestId('select-tag-name'), '  Wholesale ');
    expect(tagCustomers).not.toHaveBeenCalled();
    await user.click(screen.getByTestId('select-tag-add'));
    expect(tagCustomers).toHaveBeenCalledWith(['k1', 'k2', 'k3'], 'Wholesale');
    expect(refresh).toHaveBeenCalled();
    expect(screen.queryByTestId('select-bar')).toBeNull();
  });

  it('a refusal is said in the bar, and the pick stays', async () => {
    const user = userEvent.setup();
    tagCustomers.mockResolvedValue({ ok: false, reason: 'too_many_tags' });
    list();
    await user.keyboard('{Shift>}');
    await user.click(screen.getByTestId('open-p1'));
    await user.keyboard('{/Shift}');
    await user.click(screen.getByTestId('select-tag'));
    await user.type(screen.getByTestId('select-tag-name'), 'VIP{Enter}');
    expect(screen.getByTestId('select-tag-problem')).toHaveTextContent('too many tags');
    expect(screen.getByTestId('select-bar')).toBeInTheDocument();
  });

  it('shift-click again unpicks; Clear empties', async () => {
    const user = userEvent.setup();
    list();
    await user.keyboard('{Shift>}');
    await user.click(screen.getByTestId('open-p1'));
    await user.click(screen.getByTestId('open-p2'));
    await user.click(screen.getByTestId('open-p1'));
    await user.keyboard('{/Shift}');
    expect(screen.getByTestId('select-bar')).toHaveTextContent('1 selected');
    expect(screen.getByTestId('row-p1')).not.toHaveAttribute('data-selected');
    expect(href().query.contacts).toBe('k3');
    await user.click(screen.getByTestId('select-clear'));
    expect(screen.queryByTestId('select-bar')).toBeNull();
  });
});
