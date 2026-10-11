import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { languageShareSchema } from '@/api/contracts/language-share';
import { workspaceSchema } from '@/api/contracts/workspace';
import messages from '@/i18n/messages/en/workspace.json';

const { saveWorkspaceFacts, saveSystemLanguage } = vi.hoisted(() => ({
  saveWorkspaceFacts: vi.fn(),
  saveSystemLanguage: vi.fn(),
}));
vi.mock('./actions', () => ({ saveWorkspaceFacts, saveSystemLanguage }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: unknown; children: ReactNode }) => (
    <a href={typeof href === 'string' ? href : JSON.stringify(href)} {...rest}>
      {children}
    </a>
  ),
}));

import { HoursDrawer } from './HoursDrawer';
import { LanguageDrawer } from './LanguageDrawer';

beforeEach(() => {
  saveWorkspaceFacts.mockReset();
  saveWorkspaceFacts.mockResolvedValue({ ok: true, data: {} });
  saveSystemLanguage.mockReset();
  saveSystemLanguage.mockResolvedValue({ ok: true });
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
    inIntl(<LanguageDrawer storedLanguage="he" share={share} systemLocale="he" updatedAt={null} />);

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
    // The system language did not change: not written.
    expect(saveSystemLanguage).not.toHaveBeenCalled();
  });

  it('★★ the system language changes here now, and saves with the drawer (Omer, 2026-10-11)', async () => {
    drawer();
    const system = screen.getByTestId('language-system-select') as HTMLSelectElement;
    expect(system.value).toBe('he');
    expect(system).not.toBeDisabled();
    await userEvent.selectOptions(system, 'en');
    await userEvent.click(screen.getByTestId('drawer-save-language'));
    expect(saveSystemLanguage).toHaveBeenCalledWith('en');
    expect(await screen.findByTestId('language-saved')).toBeInTheDocument();
  });

  it('⚠ refused (no permission): said in words, and not "saved"', async () => {
    saveSystemLanguage.mockResolvedValueOnce({ ok: false, reason: 'forbidden' });
    drawer();
    await userEvent.selectOptions(screen.getByTestId('language-system-select'), 'en');
    await userEvent.click(screen.getByTestId('drawer-save-language'));
    expect(
      await screen.findByText("You don't have permission to change the workspace's language."),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('language-saved')).toBeNull();
  });

  it('★★ the interface language is not here: it is personal (Omer, 2026-10-11)', () => {
    drawer();
    const card = screen.getByTestId('language-system');
    // One select in the card - the system language - and nothing else to choose.
    const selects = card.querySelectorAll('select');
    expect(selects).toHaveLength(1);
    expect(selects[0]).toHaveAttribute('data-testid', 'language-system-select');
    expect(screen.queryByTestId('language-mine')).toBeNull();
    expect(screen.queryByText('Your interface language')).toBeNull();
    // Where it lives now: a line, not a control.
    const where = screen.getByTestId('language-mine-where');
    expect(where.tagName).toBe('P');
    expect(where).toHaveTextContent(
      'Your own interface language is in your menu, at the bottom of the side bar.',
    );
    expect(where.querySelector('a, button, select, input')).toBeNull();
  });
});
