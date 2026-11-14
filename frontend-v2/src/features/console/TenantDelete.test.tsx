import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import consoleEn from '@/i18n/messages/en/console.json';
import consoleHe from '@/i18n/messages/he/console.json';

/** Deleting a tenant, and its outcome on the list. Mocked: nothing is deleted. */
const { edit, router } = vi.hoisted(() => ({
  edit: { deleteTenant: vi.fn() },
  router: { refresh: vi.fn(), push: vi.fn() },
}));
vi.mock('./edit-actions', () => edit);
vi.mock('@/i18n/navigation', () => ({ useRouter: () => router }));

import { DeletedNotice } from './DeletedNotice';
import { TenantDelete } from './TenantDelete';

const KEY = 'console.deletedTenant';
const wrap = (node: React.ReactNode, locale: 'en' | 'he' = 'en') =>
  render(
    <NextIntlClientProvider
      locale={locale}
      messages={{ console: locale === 'he' ? consoleHe : consoleEn }}
    >
      {node}
    </NextIntlClientProvider>,
  );
const show = (slug = 'acme-ltd') =>
  wrap(<TenantDelete tenantId="t1" name="Acme Ltd" slug={slug} />);
const open = () => fireEvent.click(screen.getByTestId('tenant-delete-submit-open'));
const yes = () => screen.getByTestId('tenant-delete-submit-yes');
const type = (slug: string, reason = 'closed the account') => {
  fireEvent.change(screen.getByLabelText('Type acme-ltd to confirm'), { target: { value: slug } });
  fireEvent.change(screen.getByLabelText(consoleEn.edit.reason), { target: { value: reason } });
};

beforeEach(() => {
  edit.deleteTenant.mockReset();
  edit.deleteTenant.mockResolvedValue({
    ok: true,
    deleted: { providerLeftovers: [], uploadsRemoved: true },
  });
  router.push.mockClear();
  router.refresh.mockClear();
  sessionStorage.clear();
});

describe('★★ deleting a tenant', () => {
  it('★★ the confirm says plainly what goes for good, and that nothing is disconnected', () => {
    show();
    open();
    const group = screen.getByRole('group');
    expect(group).toHaveTextContent(
      'Acme Ltd and everything in it is deleted for good: its users, conversations, customers, channels, knowledge, files and settings.',
    );
    expect(group).toHaveTextContent("This can't be undone.");
    expect(group).toHaveTextContent('nothing is disconnected on WhatsApp, Meta or Shopify');
    expect(yes().className).toMatch(/danger/);
  });

  it('★★ Yes waits for the slug typed EXACTLY and a reason', () => {
    show();
    open();
    type('acme', 'r');
    expect(yes()).toBeDisabled();
    type('ACME-LTD', 'r');
    expect(yes()).toBeDisabled();
    type('acme-ltd', ' ');
    expect(yes()).toBeDisabled();
    type('acme-ltd', 'r');
    expect(yes()).toBeEnabled();
  });

  it('★★ done: to the tenants list, the outcome handed over in storage, not the address', async () => {
    edit.deleteTenant.mockResolvedValue({
      ok: true,
      deleted: {
        counts: { users: 1, conversations: 2, messages: 3, channelAccounts: 1, contacts: 4 },
        identitiesDeleted: 1,
        uploadFiles: 0,
        providerLeftovers: ['WHATSAPP:Acme WA (pn): number stays registered'],
        uploadsRemoved: false,
        uploadsLeftBehind: [],
      },
    });
    show();
    open();
    type('acme-ltd');
    await act(async () => fireEvent.click(yes()));
    expect(edit.deleteTenant).toHaveBeenCalledWith('t1', 'acme-ltd', 'closed the account');
    expect(router.push).toHaveBeenCalledWith('/system/tenants');
    expect(router.refresh).not.toHaveBeenCalled();
    expect(JSON.parse(sessionStorage.getItem(KEY)!)).toEqual({
      name: 'Acme Ltd',
      counts: { users: 1, conversations: 2, messages: 3, channelAccounts: 1, contacts: 4 },
      identitiesDeleted: 1,
      uploadFiles: 0,
      providerLeftovers: ['WHATSAPP:Acme WA (pn): number stays registered'],
      uploadsRemoved: false,
      uploadsLeftBehind: [],
    });
  });

  it('★★ refused: said here, nothing kept, no navigation', async () => {
    edit.deleteTenant.mockResolvedValue({ ok: false, reason: 'paid_subscription' });
    show();
    open();
    type('acme-ltd');
    await act(async () => fireEvent.click(yes()));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This organization has a paid plan that can still charge.',
    );
    expect(router.push).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it.each([
    ['slug_mismatch', "The slug typed doesn't match this organization."],
    ['system_tenant', "The System organization can't be deleted."],
    ['own_tenant', "You can't delete the organization you are signed in to."],
    [
      'paid_subscription',
      'This organization has a paid plan that can still charge. Cancel or end the plan first.',
    ],
    [
      'open_checkout',
      'This organization has a payment the customer could still complete. Wait for it to expire, or cancel it first.',
    ],
    [
      'shopify_billed',
      'Shopify bills this organization. The merchant must uninstall the app in Shopify first.',
    ],
  ])('★★ refused %s: said as what to do, and nothing else happens', async (reason, sentence) => {
    edit.deleteTenant.mockResolvedValue({ ok: false, reason });
    show();
    open();
    type('acme-ltd');
    await act(async () => fireEvent.click(yes()));
    expect(screen.getByRole('alert')).toHaveTextContent(sentence);
    expect(router.push).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('★ every refusal has its Hebrew sentence, and no copy here has an em or en dash', () => {
    const keys = [
      'slug_mismatch',
      'system_tenant',
      'own_tenant',
      'paid_subscription',
      'open_checkout',
      'shopify_billed',
    ] as const;
    for (const key of keys) {
      expect(consoleHe.edit.refusal[key]).toMatch(/[\u0590-\u05FF]/);
      expect(consoleEn.edit.refusal[key]).not.toMatch(/[\u2013\u2014]/);
      expect(consoleHe.edit.refusal[key]).not.toMatch(/[\u2013\u2014]/);
    }
    for (const copy of [consoleEn.edit.delete, consoleHe.edit.delete]) {
      expect(JSON.stringify(copy)).not.toMatch(/[\u2013\u2014]/);
    }
  });

  it('★★ the System tenant: the card says why, and offers no delete', () => {
    show('system');
    expect(screen.getByTestId('tenant-delete-system')).toHaveTextContent(
      "The System organization can't be deleted.",
    );
    expect(screen.queryByTestId('tenant-delete-submit-open')).toBeNull();
  });
});

describe('★★ the deleted tenant’s outcome, on the list', () => {
  it('nothing kept: nothing said', () => {
    wrap(<DeletedNotice />);
    expect(screen.queryByTestId('tenant-deleted')).toBeNull();
  });

  it('★★ done, with what is still connected on the provider side, and files left behind', () => {
    sessionStorage.setItem(
      KEY,
      JSON.stringify({
        name: 'Acme Ltd',
        providerLeftovers: ['WHATSAPP:Acme WA (pn): number stays registered', 42],
        uploadsRemoved: false,
      }),
    );
    wrap(<DeletedNotice />);
    const notice = screen.getByTestId('tenant-deleted');
    expect(notice).toHaveTextContent('Acme Ltd was deleted.');
    expect(notice).toHaveTextContent('Still connected on the provider side:');
    expect(notice.querySelectorAll('li')).toHaveLength(1);
    expect(notice).toHaveTextContent("Some of its files couldn't be removed from storage.");
  });

  it('★★ done: what was removed, counted, and the files left behind by name', () => {
    sessionStorage.setItem(
      KEY,
      JSON.stringify({
        name: 'Acme Ltd',
        counts: { users: 2, conversations: 1400, messages: 0, channelAccounts: 1, contacts: 9 },
        identitiesDeleted: 2,
        uploadFiles: 3,
        providerLeftovers: [],
        uploadsRemoved: false,
        uploadsLeftBehind: ['5f0c.png'],
      }),
    );
    wrap(<DeletedNotice />);
    const counts = screen.getByTestId('tenant-deleted-counts');
    const said = [...counts.querySelectorAll('dt')].map((dt) => [
      dt.textContent,
      dt.nextElementSibling?.textContent,
    ]);
    expect(said).toEqual([
      ['Users', '2'],
      ['Conversations', '1,400'],
      ['Messages', '0'],
      ['Channels', '1'],
      ['Customers', '9'],
      ['Sign-in accounts', '2'],
      ['Files', '3'],
    ]);
    expect(screen.getByTestId('tenant-deleted')).toHaveTextContent('What was removed:');
    expect(screen.getByTestId('tenant-deleted-uploads')).toHaveTextContent('5f0c.png');
  });

  it('★ a count that was not read is not said, never as 0', () => {
    sessionStorage.setItem(
      KEY,
      JSON.stringify({
        name: 'Acme Ltd',
        counts: { users: 2, conversations: null },
        providerLeftovers: [],
      }),
    );
    wrap(<DeletedNotice />);
    const said = [...screen.getByTestId('tenant-deleted-counts').querySelectorAll('dt')].map(
      (dt) => dt.textContent,
    );
    expect(said).toEqual(['Users']);
  });

  it('★ an outcome kept before counts existed: no counts block at all', () => {
    sessionStorage.setItem(KEY, JSON.stringify({ name: 'Acme Ltd', providerLeftovers: [] }));
    wrap(<DeletedNotice />);
    expect(screen.queryByTestId('tenant-deleted-counts')).toBeNull();
  });

  it('★ Hebrew: the counts in Hebrew', () => {
    sessionStorage.setItem(
      KEY,
      JSON.stringify({
        name: 'Acme Ltd',
        counts: { users: 2, channelAccounts: 1 },
        providerLeftovers: [],
      }),
    );
    wrap(<DeletedNotice />, 'he');
    const notice = screen.getByTestId('tenant-deleted');
    expect(notice).toHaveTextContent('מה נמחק:');
    expect(notice).toHaveTextContent('משתמשים');
    expect(notice).toHaveTextContent('ערוצים');
  });

  it('★ no leftovers and files removed: only the done sentence', () => {
    sessionStorage.setItem(
      KEY,
      JSON.stringify({ name: 'Acme Ltd', providerLeftovers: [], uploadsRemoved: true }),
    );
    wrap(<DeletedNotice />);
    expect(screen.getByTestId('tenant-deleted')).not.toHaveTextContent('Still connected');
    expect(screen.getByTestId('tenant-deleted')).not.toHaveTextContent('files');
  });

  it('★ shown until dismissed; dismissing clears it for good', () => {
    sessionStorage.setItem(KEY, JSON.stringify({ name: 'Acme Ltd', providerLeftovers: [] }));
    wrap(<DeletedNotice />);
    fireEvent.click(screen.getByTestId('tenant-deleted-dismiss'));
    expect(screen.queryByTestId('tenant-deleted')).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('★ storage refusing the removal still dismisses it', () => {
    sessionStorage.setItem(KEY, JSON.stringify({ name: 'Acme Ltd', providerLeftovers: [] }));
    const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    wrap(<DeletedNotice />);
    fireEvent.click(screen.getByTestId('tenant-deleted-dismiss'));
    expect(screen.queryByTestId('tenant-deleted')).toBeNull();
    remove.mockRestore();
  });

  it('a kept value that is not ours is ignored, not drawn', () => {
    sessionStorage.setItem(KEY, '{not json');
    wrap(<DeletedNotice />);
    expect(screen.queryByTestId('tenant-deleted')).toBeNull();
  });
});
