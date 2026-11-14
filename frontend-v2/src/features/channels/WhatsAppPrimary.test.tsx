import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { accountLabel, byAccount, numbersResponseSchema } from '@/api/contracts/whatsapp-numbers';
import en from '@/i18n/messages/en/channels.json';
import he from '@/i18n/messages/he/channels.json';

/**
 * Two separate WhatsApp business accounts, and the primary number (Omer,
 * 2026-10-29; Backend feat/wa-primary-number): which account each number is
 * on, and which one sends what no number was chosen for.
 */

const { setPrimaryNumber } = vi.hoisted(() => ({
  setPrimaryNumber: vi.fn(async (_id: string): Promise<unknown> => ({ ok: true })),
}));
vi.mock('./number-actions', () => ({ setPrimaryNumber }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
let locale: 'en' | 'he' = 'en';
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'channels.whatsapp') =>
    createTranslator({
      locale,
      messages: { channels: locale === 'en' ? en : he },
      namespace,
    }),
  getLocale: async () => locale,
  getTimeZone: async () => 'Asia/Jerusalem',
}));

import { getTranslations } from 'next-intl/server';

import { PrimaryNumber } from './PrimaryNumber';
import { WhatsAppLine, WhatsAppNumbers } from './WhatsAppNumbers';

const profiled = (id: string, phone: string, extra: Record<string, unknown> = {}) => ({
  id,
  phoneNumber: phone,
  name: null,
  state: 'CONNECTED',
  channelAccountId: `ca-${id}`,
  health: { state: 'CONNECTED', receiving: true, sending: true },
  ...extra,
});
const unprofiled = (id: string, phone: string, extra: Record<string, unknown> = {}) => ({
  channelAccountId: `ca-${id}`,
  phoneNumberId: `pn-${id}`,
  phoneNumber: phone,
  connectionStatus: 'CONNECTED',
  ...extra,
});
const aviv = { wabaId: '1111222233334444', wabaName: 'Aviv & Co.' };
const second = { wabaId: '5555666677778888', wabaName: null, businessName: 'Aviv Outlet' };

const parse = (payload: Record<string, unknown>) => numbersResponseSchema.parse(payload);

async function renderList(payload: Record<string, unknown>) {
  const numbers = parse(payload);
  // The mocked server translator: the component's own type, in this test's locale.
  const t = await getTranslations('channels.whatsapp');
  return render(
    <NextIntlClientProvider locale={locale} messages={{ channels: locale === 'en' ? en : he }}>
      <p data-testid="line">
        <WhatsAppLine numbers={numbers} t={t} />
      </p>
      {await WhatsAppNumbers({ numbers })}
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  locale = 'en';
  setPrimaryNumber.mockReset();
});

describe('★ the contract - a backend without the fields reads as "not known", never as a failed list', () => {
  it('a payload from before feat/wa-primary-number parses: no primary, no account, nobody primary', () => {
    const read = parse({ data: [profiled('a', '+972 50 000 0001')] });
    expect(read.primary).toBeNull();
    expect(read.data[0]).toMatchObject({ wabaId: null, wabaName: null, isPrimary: false });
  });

  it('a broken value is dropped, not fatal', () => {
    const read = parse({
      data: [profiled('a', '+1', { wabaId: 7, isPrimary: 'yes' })],
      primary: { channelAccountId: 9, source: 'whatever' },
    });
    expect(read.data[0]).toMatchObject({ wabaId: null, isPrimary: false });
    expect(read.primary).toEqual({ channelAccountId: null, source: 'none' });
  });

  it.each([
    [
      { wabaId: 'w12345678', wabaName: 'Aviv', businessName: 'Biz' },
      { text: 'Aviv', unnamed: false },
    ],
    [
      { wabaId: 'w12345678', wabaName: null, businessName: 'Biz' },
      { text: 'Biz', unnamed: false },
    ],
    [
      { wabaId: 'w12345678', wabaName: '  ', businessName: null },
      { text: '…5678', unnamed: true },
    ],
    [{ wabaId: null, wabaName: null, businessName: null }, null],
  ])(
    'the account is named by its WABA, its business, or …last4 - never the full id: %o',
    (row, label) => {
      expect(accountLabel(row)).toEqual(label);
    },
  );

  it('rows group by account, each where its account is first seen; unknown last', () => {
    const rows = [
      { k: 1, wabaId: 'A' },
      { k: 2, wabaId: null },
      { k: 3, wabaId: 'B' },
      { k: 4, wabaId: 'A' },
    ];
    expect(byAccount(rows).map((r) => r.k)).toEqual([1, 4, 3, 2]);
  });
});

describe('★★ which business account', () => {
  it('one account: the panel line names it, and no row repeats it', async () => {
    await renderList({
      data: [profiled('a', '+972 50 000 0001', aviv), profiled('b', '+972 50 000 0002', aviv)],
    });
    expect(screen.getByTestId('line')).toHaveTextContent(
      'Aviv & Co. WhatsApp Business account · 2 numbers',
    );
    expect(screen.queryByTestId('whatsapp-account')).toBeNull();
  });

  it('two accounts: the line counts them, every row says its own, grouped by account', async () => {
    await renderList({
      data: [profiled('a', '+972 50 000 0001', aviv), profiled('b', '+972 50 000 0002', second)],
      unprofiled: [unprofiled('c', '+972 50 000 0003', aviv)],
    });
    expect(screen.getByTestId('line')).toHaveTextContent(
      '2 WhatsApp Business accounts · 3 numbers',
    );
    const list = screen.getByTestId('whatsapp-numbers');
    const accounts = within(list)
      .getAllByTestId('whatsapp-account')
      .map((el) => el.textContent);
    // Aviv's two (one of them unprofiled) together, then the second account by its business name.
    expect(accounts).toEqual(['Aviv & Co. account', 'Aviv & Co. account', 'Aviv Outlet account']);
  });

  it('no name from Meta: …last4, never the raw id', async () => {
    await renderList({
      data: [
        profiled('a', '+1', { wabaId: '1111222233334444' }),
        profiled('b', '+2', { wabaId: '5555666677778888' }),
      ],
    });
    const text = screen.getByTestId('whatsapp-numbers').textContent ?? '';
    expect(text).toContain('…4444 account');
    expect(text).not.toContain('1111222233334444');
  });

  it.each(['en', 'he'] as const)(
    '%s: the …last4 stand-in is drawn left to right - never "4444…" in a Hebrew line',
    async (lang) => {
      locale = lang;
      await renderList({
        data: [profiled('a', '+1', { wabaId: '1111222233334444' })],
      });
      const unnamed = screen.getByTestId('line').querySelector('bdi');
      expect(unnamed).toHaveTextContent(/^…4444$/);
      expect(unnamed).toHaveAttribute('dir', 'ltr');
      await renderList({
        data: [
          profiled('b', '+2', { wabaId: '1111222233334444' }),
          profiled('c', '+3', { wabaId: '5555666677778888', wabaName: 'Aviv & Co.' }),
        ],
      });
      const rows = screen.getAllByTestId('whatsapp-account').map((el) => el.querySelector('bdi'));
      expect(rows.map((b) => [b?.textContent, b?.getAttribute('dir')])).toEqual([
        ['…4444', 'ltr'],
        ['Aviv & Co.', 'auto'],
      ]);
    },
  );

  it('no account known at all: the line is as before', async () => {
    await renderList({ data: [profiled('a', '+1')] });
    expect(screen.getByTestId('line')).toHaveTextContent('WhatsApp Business account · one number');
  });

  it.each(['panelLine', 'panelLineAccounts', 'panelLineAccount'] as const)(
    'Hebrew %s: a Latin run never swallows the count - "Business" is followed by an RLM',
    (key) => {
      // Without it "WhatsApp Business · 3" is one LTR run: the 3 lands beside
      // "חשבונות" and "מספרים" at the far end (seen in Chromium, 2026-10-29).
      expect(he.whatsapp[key]).toMatch(/Business ?\u200f/);
    },
  );

  it('Hebrew: "חשבון WhatsApp Business" then the name in its own bdi, after an RLM', async () => {
    locale = 'he';
    await renderList({ data: [profiled('a', '+1', aviv), profiled('b', '+2', aviv)] });
    const line = screen.getByTestId('line');
    expect(line.textContent).toBe('חשבון WhatsApp Business ‏Aviv & Co. · 2 מספרים');
    expect(line.querySelector('bdi')).toHaveTextContent(/^Aviv & Co\.$/);
  });
});

describe('★★ the primary number', () => {
  const two = (primary: unknown = { channelAccountId: 'ca-b', source: 'chosen' }) => ({
    data: [
      profiled('a', '+972 50 000 0001', aviv),
      profiled('b', '+972 50 000 0002', { ...aviv, isPrimary: true }),
    ],
    primary,
  });

  it('two numbers: "Primary" on the primary only, its row says "This number", the other can be set', async () => {
    await renderList(two());
    expect(screen.getAllByTestId('whatsapp-primary-chip')).toHaveLength(1);
    const cards = screen.getAllByTestId('whatsapp-number');
    expect(within(cards[1]!).getByTestId('whatsapp-primary-chip')).toHaveTextContent('Primary');
    expect(within(cards[1]!).getByTestId('whatsapp-primary-this')).toHaveTextContent('This number');
    expect(within(cards[0]!).getByTestId('whatsapp-primary-set')).toHaveTextContent(
      'Set as primary',
    );
    expect(within(cards[0]!).queryByTestId('whatsapp-primary-chip')).toBeNull();
    expect(screen.getByTestId('whatsapp-primary-note')).toHaveTextContent(
      "Anything that isn't sent from a particular number goes from the primary one.",
    );
  });

  it.each([
    [
      'one number - nothing to choose',
      {
        data: [profiled('a', '+1', { isPrimary: true })],
        primary: { channelAccountId: 'ca-a', source: 'default' },
      },
    ],
    ['a backend with no primary', { data: [profiled('a', '+1'), profiled('b', '+2')] }],
  ])('%s: no chip, no row, no note', async (_name, payload) => {
    await renderList(payload);
    expect(screen.queryByTestId('whatsapp-primary-chip')).toBeNull();
    expect(screen.queryByTestId('whatsapp-primary-row')).toBeNull();
    expect(screen.queryByTestId('whatsapp-primary-note')).toBeNull();
  });

  it('an unprofiled number is offered too, by its channel account', async () => {
    await renderList({
      data: [profiled('a', '+1', { isPrimary: true })],
      unprofiled: [unprofiled('c', '+3')],
      primary: { channelAccountId: 'ca-a', source: 'default' },
    });
    const card = screen.getByTestId('whatsapp-unprofiled');
    await userEvent.click(within(card).getByTestId('whatsapp-primary-set'));
    expect(setPrimaryNumber).toHaveBeenCalledWith('ca-c');
  });

  it('Hebrew: ראשי, הגדרה כראשי', async () => {
    locale = 'he';
    await renderList(two());
    expect(screen.getByTestId('whatsapp-primary-chip')).toHaveTextContent('ראשי');
    expect(screen.getByTestId('whatsapp-primary-set')).toHaveTextContent('הגדרה כראשי');
  });
});

describe('★★ Set as primary - one press, said after', () => {
  const wrap = (node: ReactNode) => (
    <NextIntlClientProvider locale="en" messages={{ channels: en }}>
      {node}
    </NextIntlClientProvider>
  );

  it('success: the row that became primary says so, with the number', async () => {
    let finish: (v: unknown) => void = () => {};
    setPrimaryNumber.mockReturnValue(new Promise((r) => (finish = r)));
    const props = {
      channelAccountId: 'ca-a',
      phone: '+972 50 000 0001',
      current: '+972 50 000 0002',
    };
    const { rerender } = render(wrap(<PrimaryNumber {...props} isPrimary={false} />));
    await userEvent.click(screen.getByTestId('whatsapp-primary-set'));
    expect(screen.getByTestId('whatsapp-primary-set')).toHaveTextContent('Setting…');
    expect(screen.getByTestId('whatsapp-primary-set')).toBeDisabled();
    expect(setPrimaryNumber).toHaveBeenCalledWith('ca-a');
    // The refresh the action causes: this row is the primary now.
    rerender(wrap(<PrimaryNumber {...props} isPrimary />));
    await act(async () =>
      finish({ ok: true, primary: { channelAccountId: 'ca-a', source: 'chosen' } }),
    );
    expect(screen.getByTestId('whatsapp-primary-this')).toHaveTextContent('This number');
    const done = screen.getByTestId('whatsapp-primary-done');
    expect(done).toHaveTextContent('+972 50 000 0001 is now the primary number.');
    expect(done.querySelector('bdi')).toHaveAttribute('dir', 'ltr');
  });

  it.each([
    ['failed', 'Not changed - +972 50 000 0002 is still the primary number. Try again.'],
    [
      'not_active',
      "Not changed - this number isn't active, so it can't send. +972 50 000 0002 is still the primary number.",
    ],
    ['not_found', "Not changed - that number isn't connected here any more. Reload the page."],
    ['forbidden', "Not changed - your role can't change the primary number."],
  ])('%s: says nothing changed, and which number still is', async (reason, words) => {
    setPrimaryNumber.mockResolvedValue({ ok: false, reason });
    render(
      wrap(
        <PrimaryNumber
          channelAccountId="ca-a"
          isPrimary={false}
          phone="+972 50 000 0001"
          current="+972 50 000 0002"
        />,
      ),
    );
    await userEvent.click(screen.getByTestId('whatsapp-primary-set'));
    expect(await screen.findByTestId('whatsapp-primary-failed')).toHaveTextContent(words);
    expect(screen.queryByTestId('whatsapp-primary-done')).toBeNull();
  });

  it('no primary known: the failure says only that nothing changed', async () => {
    setPrimaryNumber.mockResolvedValue({ ok: false, reason: 'failed' });
    render(
      wrap(<PrimaryNumber channelAccountId="ca-a" isPrimary={false} phone="+1" current={null} />),
    );
    await userEvent.click(screen.getByTestId('whatsapp-primary-set'));
    expect(await screen.findByTestId('whatsapp-primary-failed')).toHaveTextContent(
      /^Not changed\. Try again\.$/,
    );
  });

  it('a number with no channel here cannot be set', () => {
    render(
      wrap(<PrimaryNumber channelAccountId={null} isPrimary={false} phone="+1" current="+2" />),
    );
    expect(screen.queryByTestId('whatsapp-primary-set')).toBeNull();
  });
});
