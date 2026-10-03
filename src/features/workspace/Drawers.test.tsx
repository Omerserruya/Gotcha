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
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
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

describe('★ 11b — the business form', () => {
  it('what PATCH cannot take is drawn, not live, and says why', () => {
    inIntl(<BusinessDrawer workspace={ws()} />);
    const site = screen.getByTestId('business-website');
    expect(site).toHaveTextContent('urban-supply.com');
    expect(site).toHaveAttribute('aria-disabled', 'true');
    expect(site).toHaveAttribute('title', expect.stringMatching(/\S/));
    expect(screen.getByText('Home textiles')).toHaveAttribute('aria-disabled', 'true');
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

describe('★ 11c — the week, and what it cannot hold', () => {
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

  it('copying Sunday saves nothing', async () => {
    inIntl(<HoursDrawer workspace={ws()} />);
    await userEvent.click(screen.getByTestId('hours-copy-sunday'));
    expect(screen.getByTestId('hours-copied')).toHaveTextContent(/copied to Monday/i);
    expect(saveWorkspaceFacts).not.toHaveBeenCalled();
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

describe('★ 11d — two cards, no paragraphs', () => {
  /** Dev's real mix: English 7, Hebrew 5 — too few for percentages. */
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
