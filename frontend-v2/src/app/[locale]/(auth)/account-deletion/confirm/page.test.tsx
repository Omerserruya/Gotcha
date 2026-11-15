import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import auth from '@/i18n/messages/en/auth.json';

/** The page reads the token and hands it on; it sends nothing itself. */
const { action, seen } = vi.hoisted(() => ({
  action: { requestAccountDeletion: vi.fn(), confirmAccountDeletion: vi.fn() },
  seen: { props: null as null | Record<string, unknown> },
}));
vi.mock('@/features/account-deletion/actions', () => action);
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'auth') =>
    createTranslator({ locale: 'en', messages: { auth }, namespace }),
}));
vi.mock('./DeletionConfirmPanel', () => ({
  DeletionConfirmPanel: (props: Record<string, unknown>) => {
    seen.props = props;
    return <div data-testid="panel" />;
  },
}));

const { default: Page } = await import('./page');

const open = async (token?: string | string[]) =>
  render(
    await Page({
      params: Promise.resolve({ locale: 'he' }),
      searchParams: Promise.resolve(token === undefined ? {} : { token }),
    }),
  );

describe('★★ /account-deletion/confirm, the page', () => {
  it('★★★ the token goes to the panel; the page itself confirms nothing', async () => {
    await open(' tok-1 ');
    expect(screen.getByTestId('panel')).toBeInTheDocument();
    expect(seen.props).toMatchObject({
      token: 'tok-1',
      requestHref: expect.stringContaining('/he/account-deletion'),
      signInHref: expect.stringContaining('/he/sign-in'),
    });
    expect(action.confirmAccountDeletion).not.toHaveBeenCalled();
  });

  it.each([undefined, '', '   ', ['a', 'b']])('no usable token (%j): null', async (token) => {
    await open(token as never);
    expect(seen.props!.token).toBeNull();
  });
});
