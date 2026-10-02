import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { customerRowSchema, type CustomerRow } from '@/api/contracts/customers';
import messages from '@/i18n/messages/en/customers.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'customers') =>
    createTranslator({ locale: 'en', messages: { customers: messages }, namespace }),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { Composition, CustomerList } from './CustomerList';

const row = (over: Record<string, unknown> = {}): CustomerRow =>
  customerRowSchema.parse({
    id: 'k1',
    displayName: 'Dana Cohen',
    channel: 'WHATSAPP',
    phone: '+972500000001',
    ...over,
  });

const show = async (rows: readonly CustomerRow[], truncated = false, total = rows.length) =>
  render(await CustomerList({ rows, total, truncated, searchedField: null, query: '' }));

describe('★★ 04’s list card', () => {
  it('★★ every person is a link to them, with their initials and channel badge', async () => {
    await show([row()]);
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/customers/k1');
    expect(link).toHaveTextContent('DC');
    expect(link).toHaveTextContent('Dana Cohen');
  });

  it('★ the line under the name is how to reach them — the handle and the channels', async () => {
    await show([row()]);
    expect(screen.getByTestId('customer-k1')).toHaveTextContent('+972500000001 · WhatsApp');
  });

  it('⚠ a row whose name IS its number does not repeat the number', async () => {
    await show([row({ displayName: null, externalId: '+972500000009', phone: '+972500000009' })]);
    expect(screen.getByTestId('customer-k1').textContent?.match(/\+972500000009/g)).toHaveLength(1);
  });

  it('★★ the footer counts PEOPLE when the list is whole', async () => {
    await show([row(), row({ id: 'k2', displayName: 'Yael' })]);
    expect(screen.getByTestId('customer-count')).toHaveTextContent('2 people');
  });

  it('⚠⚠ and RECORDS when it is cut — never a record count called people', async () => {
    await show([row()], true, 4180);
    expect(screen.getByTestId('customer-count')).toHaveTextContent(
      'Showing the first 1 of 4180 records',
    );
  });

  it('★★ the identity limit is one line, with the reason — specific — as its tooltip', async () => {
    await show([row()]);
    const limit = screen.getByTestId('identity-limit');
    expect(limit).toHaveTextContent(/appear twice/i);
    expect(limit.getAttribute('title')).toMatch(/same phone number/i);
    expect(limit.getAttribute('title')).toMatch(/instagram never provides one/i);
  });
});

describe('★ "Who your customers are" — only from a whole list', () => {
  it('counts people by the channel they write on', async () => {
    render(
      await Composition({
        rows: [
          row(),
          row({ id: 'k2', displayName: 'Y', channel: 'INSTAGRAM' }),
          row({ id: 'k3', displayName: 'Z' }),
        ],
        truncated: false,
      }),
    );
    expect(screen.getByTestId('composition-WHATSAPP')).toHaveTextContent('2');
    expect(screen.getByTestId('composition-INSTAGRAM')).toHaveTextContent('1');
  });

  it('⚠⚠ nothing from a truncated list — it would describe the first 500, not the business', async () => {
    expect(await Composition({ rows: [row()], truncated: true })).toBeNull();
  });
});
