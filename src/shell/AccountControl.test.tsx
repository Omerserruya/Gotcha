import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import navigation from '@/i18n/messages/en/navigation.json';

vi.mock('@/auth/sign-out', () => ({ signOut: vi.fn() }));
vi.mock('@/tenant/tenant-context', () => ({ useTenant: () => ({ tenantId: 't-1234' }) }));
vi.mock('./LocaleMenuItems', () => ({ LocaleMenuItems: () => null }));

import { AccountControl } from './AccountControl';

const show = (name: string | null, workspace: string | null) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ navigation }}>
      <AccountControl name={name} workspace={workspace} />
    </NextIntlClientProvider>,
  );

describe('★ the rail’s foot: the person and the business, as 02 shows them', () => {
  it('"Maya Levi / Aviv & Co.", with her initials', () => {
    show('Maya Levi', 'Aviv & Co.');
    const button = screen.getByRole('button');
    expect(button).toHaveTextContent('ML');
    expect(button).toHaveTextContent('Maya Levi');
    expect(button).toHaveTextContent('Aviv & Co.');
  });

  it('★ never the workspace’s id, and never "Choose a workspace" inside one (dev)', () => {
    show(null, null);
    const button = screen.getByRole('button');
    expect(button).not.toHaveTextContent('t-1234');
    expect(button).not.toHaveTextContent('Choose a workspace');
    expect(button).toHaveTextContent('Your workspace');
  });
});
