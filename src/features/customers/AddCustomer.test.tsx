import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import messages from '@/i18n/messages/en/customers.json';

const push = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ push }) }));
const addCustomer = vi.hoisted(() => vi.fn());
vi.mock('./customer-actions', () => ({ addCustomer }));

import { AddCustomer } from './AddCustomer';

const show = () =>
  render(
    <NextIntlClientProvider locale="en" messages={{ customers: messages }}>
      <AddCustomer />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  addCustomer.mockReset();
  push.mockReset();
});

describe('★★ 04 — Add a customer', () => {
  it('a phone that does not parse is said, and Add stays off', async () => {
    show();
    await userEvent.click(screen.getByTestId('add-customer'));
    await userEvent.type(screen.getByTestId('add-name'), 'UI TEST');
    await userEvent.type(screen.getByTestId('add-phone'), '12345');
    expect(screen.getByTestId('add-phone-problem')).toHaveTextContent(
      "doesn't look like a phone number",
    );
    expect(screen.getByTestId('add-submit')).toBeDisabled();
  });

  it('added (or already here): the person opens', async () => {
    addCustomer.mockResolvedValue({ ok: true, id: 'k9', existed: true });
    show();
    await userEvent.click(screen.getByTestId('add-customer'));
    await userEvent.type(screen.getByTestId('add-name'), 'UI TEST');
    await userEvent.type(screen.getByTestId('add-phone'), '054-123 4567');
    await userEvent.click(screen.getByTestId('add-submit'));
    expect(addCustomer).toHaveBeenCalledWith({ name: 'UI TEST', phone: '054-123 4567', email: '' });
    expect(push).toHaveBeenCalledWith('/customers/k9');
  });

  it('a refusal is said; nothing opens', async () => {
    addCustomer.mockResolvedValue({ ok: false, reason: 'failed' });
    show();
    await userEvent.click(screen.getByTestId('add-customer'));
    await userEvent.type(screen.getByTestId('add-name'), 'A');
    await userEvent.type(screen.getByTestId('add-phone'), '0541234567');
    await userEvent.click(screen.getByTestId('add-submit'));
    expect(screen.getByTestId('add-problem')).toHaveTextContent("They weren't added");
    expect(push).not.toHaveBeenCalled();
  });
});
