import { act, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import messages from '@/i18n/messages/en/roles.json';

import { RemovePermission } from './RemovePermission';

/**
 * Taking a permission away — the path that is not a toggle.
 *
 * Adding and removing have **opposite visibility**. An addition shows the
 * moment it is used. A removal is invisible everywhere except the person
 * panel: the role says they can refund, they are listed under that role,
 * they cannot refund, and nothing explains why.
 */

const { remove } = vi.hoisted(() => ({ remove: vi.fn() }));
vi.mock('./actions', () => ({ removePermission: remove }));

beforeEach(() => {
  // Reset HERE, not inside `renderRemove` — a test that sets a resolved
  // value before rendering would otherwise have it wiped by the render, and
  // the action would resolve `undefined`. That is what produced two
  // unhandled rejections and a failure that looked like the component's.
  remove.mockReset();
  remove.mockResolvedValue({ ok: true });
});

function renderRemove() {
  return render(
    <NextIntlClientProvider locale="en" messages={{ roles: messages }}>
      <RemovePermission
        userId="u1"
        personName="Tomer"
        feature="billing:refund:create"
        featureName="Issue a refund"
      />
    </NextIntlClientProvider>,
  );
}

const open = async () =>
  act(async () => screen.getByTestId('remove-start-billing:refund:create').click());

const type = async (value: string) => {
  const input = screen.getByTestId('remove-reason-billing:refund:create') as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('the confirmation says where this will be visible afterwards', () => {
  it('names this panel and the override count, and says nowhere else', async () => {
    /*
     * The one fact an admin cannot work out from the screen. They are about
     * to create something only they will be able to find, and they are
     * entitled to be told so.
     */
    renderRemove();
    await open();
    const where = screen.getByTestId('remove-where-billing:refund:create');
    expect(where).toHaveTextContent(/nothing else in GOTCHA will show that it was taken away/i);
    expect(where).toHaveTextContent(/override count on Roles/i);
    expect(where).toHaveTextContent(/nowhere else/i);
  });
});

describe('the reason is required, though the endpoint allows it empty', () => {
  it('will not submit without one', async () => {
    // An unexplained addition is a puzzle. An unexplained removal is a person
    // who cannot do their job and nobody who can say why.
    renderRemove();
    await open();
    expect(screen.getByTestId('remove-go-billing:refund:create')).toBeDisabled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('submits once a reason is given, and passes it through', async () => {
    remove.mockResolvedValue({ ok: true });
    renderRemove();
    await open();
    await type('pending a review');
    await act(async () => screen.getByTestId('remove-go-billing:refund:create').click());
    expect(remove).toHaveBeenCalledWith('u1', 'billing:refund:create', 'pending a review');
  });

  it('refuses whitespace, which is not an explanation', async () => {
    renderRemove();
    await open();
    await type('   ');
    expect(screen.getByTestId('remove-go-billing:refund:create')).toBeDisabled();
  });
});

describe('it is not a toggle', () => {
  it('opens a confirmation rather than acting on the first click', async () => {
    renderRemove();
    await open();
    expect(remove).not.toHaveBeenCalled();
    expect(screen.getByTestId('remove-confirm-billing:refund:create')).toBeInTheDocument();
  });

  it('can be backed out of without writing anything', async () => {
    renderRemove();
    await open();
    await type('changed my mind');
    await act(async () => screen.getByTestId('remove-back-billing:refund:create').click());
    expect(remove).not.toHaveBeenCalled();
    expect(screen.queryByTestId('remove-confirm-billing:refund:create')).toBeNull();
  });

  it('keeps the dialog open and says why when the write fails', async () => {
    remove.mockResolvedValue({ ok: false, reason: 'forbidden' });
    renderRemove();
    await open();
    await type('pending a review');
    await act(async () => screen.getByTestId('remove-go-billing:refund:create').click());
    expect(screen.getByTestId('remove-error-billing:refund:create')).toHaveTextContent(
      /don't have permission/i,
    );
    expect(screen.getByTestId('remove-confirm-billing:refund:create')).toBeInTheDocument();
  });
});
