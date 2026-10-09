import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { languageShareSchema } from '@/api/contracts/language-share';
import { workspaceSchema } from '@/api/contracts/workspace';
import messages from '@/i18n/messages/en/workspace.json';

const { saveWorkspaceFacts } = vi.hoisted(() => ({ saveWorkspaceFacts: vi.fn() }));
vi.mock('./actions', () => ({ saveWorkspaceFacts }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: unknown; children: ReactNode }) => (
    <a href={typeof href === 'string' ? href : JSON.stringify(href)} {...rest}>
      {children}
    </a>
  ),
}));

import { BusinessDrawer } from './BusinessDrawer';
import { HoursDrawer } from './HoursDrawer';
import { LanguageDrawer } from './LanguageDrawer';

beforeEach(() => {
  saveWorkspaceFacts.mockReset();
  saveWorkspaceFacts.mockResolvedValue({ ok: true, data: {} });
});

const ws = (over: Record<string, unknown> = {}) =>
  workspaceSchema.parse({
    name: 'Urban Supply',
    description: 'Linen bedding',
    websiteDomain: 'https://www.urban-supply.com/',
    industry: 'Home textiles',
    country: null,
    address: null,
    languages: ['he'],
    hours: {
      enabled: true,
      aiOutsideHours: 'silent',
      outsideHoursHandoffMessage: 'Back at nine.',
      schedule: { sunday: { enabled: true, open: '09:00', close: '18:00' } },
    },
    ...over,
  });

const inIntl = (node: ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ workspace: messages }}>
      {node}
    </NextIntlClientProvider>,
  );

describe('★ 11b - the business form', () => {
  it('what PATCH cannot take is drawn, not live, and says why', () => {
    inIntl(<BusinessDrawer workspace={ws()} />);
    const site = screen.getByTestId('business-website');
    expect(site).toHaveTextContent('urban-supply.com');
    expect(site).toHaveAttribute('aria-disabled', 'true');
    expect(site).toHaveAttribute('title', expect.stringMatching(/\S/));
    expect(screen.getByText('Home textiles')).toHaveAttribute('aria-disabled', 'true');
  });

  it('★ no stored value as stored: a crawler code by name, "unknown" as "-"', () => {
    inIntl(<BusinessDrawer workspace={ws({ industry: 'ecommerce', country: 'unknown' })} />);
    expect(screen.getByText('E-commerce')).toBeInTheDocument();
    expect(screen.getByTestId('business-drawer')).not.toHaveTextContent(/ecommerce|unknown/);
  });

  it('a country code is a country', () => {
    inIntl(<BusinessDrawer workspace={ws({ country: 'IL' })} />);
    expect(screen.getByText('Israel')).toBeInTheDocument();
    expect(screen.getByTestId('business-note')).toHaveAttribute(
      'title',
      expect.stringMatching(/no field/i),
    );
  });

  it('saves exactly the three fields the route takes', async () => {
    inIntl(<BusinessDrawer workspace={ws()} />);
    await userEvent.clear(screen.getByTestId('business-address'));
    await userEvent.type(screen.getByTestId('business-address'), '14 Ha’arba’a');
    await userEvent.click(screen.getByTestId('drawer-save-business'));
    expect(saveWorkspaceFacts).toHaveBeenCalledWith(
      { name: 'Urban Supply', description: 'Linen bedding', address: '14 Ha’arba’a' },
      null,
    );
    expect(await screen.findByTestId('business-saved')).toBeInTheDocument();
  });
});

describe('★ 11c - the week, and what it cannot hold', () => {
  it('+ Split and the holidays are drawn, not live, with why on their titles', () => {
    inIntl(<HoursDrawer workspace={ws()} />);
    expect(screen.getByTestId('hours-one-range')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('hours-one-range')).toHaveAttribute(
      'title',
      expect.stringMatching(/split shift/i),
    );
    expect(screen.getByTestId('hours-no-holidays')).toHaveAttribute(
      'title',
      expect.stringMatching(/no holiday calendar.*one-off closure/i),
    );
  });

  it('★ a stored week switched off is SHOWN, under "Use these hours" off', async () => {
    inIntl(
      <HoursDrawer
        workspace={ws({
          hours: {
            enabled: false,
            schedule: { sunday: { enabled: true, open: '09:00', close: '18:00' } },
          },
        })}
      />,
    );
    expect(screen.getByTestId('hours-use')).not.toBeChecked();
    expect(screen.getByTestId('hours-day-sunday')).toHaveAttribute('data-open', 'yes');
    await userEvent.click(screen.getByTestId('drawer-save-hours'));
    expect(saveWorkspaceFacts.mock.calls[0]![0].hours).toMatchObject({ enabled: false });
  });

  it('★ nothing stored is not "Closed": empty rows, switches off, under "Use these hours" off', () => {
    inIntl(<HoursDrawer workspace={ws({ hours: { enabled: false } })} />);
    expect(screen.getByTestId('hours-use')).not.toBeChecked();
    expect(screen.getByTestId('hours-day-monday')).not.toHaveTextContent(/closed/i);
    expect(screen.getByTestId('hours-unset-monday')).toHaveTextContent('- - -');
  });

  it('a day stored as closed IS "Closed"', () => {
    inIntl(
      <HoursDrawer
        workspace={ws({
          hours: {
            enabled: true,
            schedule: {
              sunday: { enabled: true, open: '09:00', close: '18:00' },
              saturday: { enabled: false },
            },
          },
        })}
      />,
    );
    expect(screen.getByTestId('hours-day-saturday')).toHaveTextContent('Closed');
  });

  it('copying Sunday saves nothing', async () => {
    inIntl(<HoursDrawer workspace={ws()} />);
    await userEvent.click(screen.getByTestId('hours-copy-sunday'));
    expect(screen.getByTestId('hours-copied')).toHaveTextContent(/copied to Monday/i);
    expect(saveWorkspaceFacts).not.toHaveBeenCalled();
  });

  it('★ the clock is typed 24-hour: "1730" is 17:30, a miss puts the last good time back', async () => {
    inIntl(<HoursDrawer workspace={ws()} />);
    const [opens, closes] = screen.getAllByRole('textbox', { name: /^Sunday - / });
    const before = (opens as HTMLInputElement).value;
    await userEvent.clear(closes!);
    await userEvent.type(closes!, '1730');
    await userEvent.clear(opens!);
    await userEvent.type(opens!, '9pm');
    await userEvent.tab();
    expect(closes).toHaveValue('17:30');
    expect(opens).toHaveValue(before);
    expect(saveWorkspaceFacts).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('drawer-save-hours'));
    const [patch] = saveWorkspaceFacts.mock.calls[0]!;
    expect(JSON.stringify(patch.hours)).toContain('"17:30"');
  });

  it('★ every save carries the outside-hours pair, so a silenced AI stays silent', async () => {
    inIntl(<HoursDrawer workspace={ws()} />);
    await userEvent.click(screen.getByTestId('drawer-save-hours'));
    const [patch] = saveWorkspaceFacts.mock.calls[0]!;
    expect(patch.hours).toMatchObject({
      aiOutsideHours: 'silent',
      outsideHoursHandoffMessage: 'Back at nine.',
    });
  });
});

describe('★ 11d - two cards, no paragraphs', () => {
  /** Dev's real mix: English 7, Hebrew 5 - too few for percentages. */
  const share = languageShareSchema.parse({
    windowDays: 30,
    total: 12,
    rows: [
      { locale: 'en', conversations: 7, share: 58.3 },
      { locale: 'he', conversations: 5, share: 41.7 },
    ],
  });
  const drawer = () =>
    inIntl(
      <LanguageDrawer
        storedLanguage="he"
        share={share}
        systemLocale="he"
        myLocale="en"
        updatedAt={null}
      />,
    );

  it('the main language by name; also-answers from what customers wrote', () => {
    drawer();
    const main = screen.getByTestId('language-main') as HTMLSelectElement;
    expect(main.value).toBe('he');
    expect(main.selectedOptions[0]).toHaveTextContent('Hebrew');
    expect(screen.getByTestId('language-also')).toHaveTextContent(/^English/);
  });

  it('a thin sample is a count, never a percentage', () => {
    drawer();
    expect(screen.getByTestId('language-hint')).toHaveTextContent(
      "7 of the last 30 days' 12 conversations were in English.",
    );
  });

  it('what has no store is drawn and not live', () => {
    drawer();
    expect(screen.getByTestId('language-other')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('language-drawer')).not.toHaveTextContent(/\bhe\b/);
  });

  it('saves the one language the route stores', async () => {
    drawer();
    await userEvent.selectOptions(screen.getByTestId('language-main'), 'en');
    await userEvent.click(screen.getByTestId('drawer-save-language'));
    expect(saveWorkspaceFacts).toHaveBeenCalledWith({ languages: ['en'] }, null);
  });
});

describe('★ 11b - the website: what the scan read, what else it found, and Scan again', () => {
  it('"42 pages read" with when and its topics; "Also found" as chips; Scan again leads to the scan', () => {
    inIntl(
      <BusinessDrawer
        workspace={ws()}
        scan={{
          pagesRead: 42,
          daysAgo: 3,
          topics: ['products', 'shipping'],
          alsoFound: [
            { kind: 'store', name: 'Shopify' },
            { kind: 'channel', name: 'Instagram' },
          ],
        }}
      />,
    );
    expect(screen.getByTestId('business-scan-line')).toHaveTextContent(
      '42 pages read 3 days ago · products, shipping',
    );
    expect(screen.getByTestId('business-also-found')).toHaveTextContent(
      'Also foundShopify storeInstagram',
    );
    expect(screen.getByTestId('business-scan-again').getAttribute('href')).toContain('scan');
  });

  it('nothing read: no line and no chips - never "0 pages read"', () => {
    inIntl(<BusinessDrawer workspace={ws()} scan={null} />);
    expect(screen.queryByTestId('business-scan-line')).toBeNull();
    expect(screen.queryByTestId('business-also-found')).toBeNull();
  });
});
