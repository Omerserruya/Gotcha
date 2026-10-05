import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import customers from '@/i18n/messages/en/customers.json';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: unknown; children: ReactNode }) => (
    <a href={typeof href === 'string' ? href : JSON.stringify(href)} {...rest}>
      {children}
    </a>
  ),
}));

import { CustomerSelection } from './CustomerSelection';

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
      </CustomerSelection>
    </NextIntlClientProvider>,
  );

const href = () => JSON.parse(screen.getByTestId('select-message').getAttribute('href')!);

describe('★★ 04 — shift-click picks, a click still opens', () => {
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

  it('shift-click again unpicks; Clear empties; Tag is drawn with its reason', async () => {
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
    const tag = screen.getByTestId('select-tag');
    expect(tag).toHaveAttribute('aria-disabled', 'true');
    expect(tag.getAttribute('title')).toBeTruthy();
    await user.click(screen.getByTestId('select-clear'));
    expect(screen.queryByTestId('select-bar')).toBeNull();
  });
});
