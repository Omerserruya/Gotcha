import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { workspaceSchema } from '@/api/contracts/workspace';
import messages from '@/i18n/messages/en/workspace.json';

vi.mock('@/i18n/navigation', () => ({
  Link: ({
    href,
    children,
    scroll: _scroll,
    ...rest
  }: {
    href: { pathname: string; query?: Record<string, string> };
    children: React.ReactNode;
    scroll?: boolean;
  }) => (
    <a href={`${href.pathname}?${new URLSearchParams(href.query)}`} {...rest}>
      {children}
    </a>
  ),
}));

import { FactRows } from './FactRows';

/*
 * `saveWorkspaceFacts` - the name the component imports.
 *
 * The first version of this mock exported `saveWorkspace`, which the module
 * does not have, so submitting threw inside FactRows and the run reported
 * "An error occurred in the <FactRows> component". That reads as a fault in
 * the subject and was a fault in the harness: the tests that already existed
 * passed because none of them ever submitted.
 */
const { saveWorkspaceFacts } = vi.hoisted(() => ({ saveWorkspaceFacts: vi.fn() }));
vi.mock('./actions', () => ({ saveWorkspaceFacts }));
const saveWorkspace = saveWorkspaceFacts;

/*
 * Reset here, NOT in the render helper.
 *
 * Without it the first test's call leaked into the next two and made
 * `not.toHaveBeenCalled()` fail against a call from a different test - which
 * reads as the component saving when it should not.
 *
 * In the helper it would be the opposite mistake: screen 12e wiped a resolved
 * value that had been set before rendering, so the action resolved undefined
 * and the component threw.
 */
beforeEach(() => {
  saveWorkspaceFacts.mockReset();
});

/**
 * The fact rows, against the design's list.
 *
 * The screen had `Currency & language` and `Time zone` as two rows; the
 * design has `Language` and `Currency & time zone` - the same two rows
 * recombined the other way. That is structural rather than cosmetic: 11d is a
 * dedicated Edit language panel, and a row that shares a label with Currency
 * has nothing to open it from.
 */

const ws = (over: Record<string, unknown> = {}) =>
  workspaceSchema.parse({
    name: 'Urban Supply',
    description: 'Linen bedding',
    websiteDomain: 'urban-supply-gotcha-demo.myshopify.com',
    address: null,
    currency: 'USD',
    timezone: 'Europe/London',
    languages: ['he'],
    hours: null,
    ...over,
  });

const renderRows = (over: Record<string, unknown> = {}) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ workspace: messages }}>
      <FactRows workspace={ws(over)} />
    </NextIntlClientProvider>,
  );

describe("the rows are the design's rows", () => {
  it('has Language and Currency & time zone as separate rows', () => {
    renderRows();
    expect(screen.getByTestId('fact-language')).toBeInTheDocument();
    expect(screen.getByTestId('fact-currencyTimezone')).toBeInTheDocument();
  });

  it('carries the website row, with no page count', () => {
    renderRows();
    const value = screen.getByTestId('fact-value-website');
    expect(value).toHaveTextContent('urban-supply-gotcha-demo.myshopify.com');
    expect(value).not.toHaveTextContent(/\d+\s*pages/i);
  });

  it('says why an absent website matters, rather than just "Not set"', () => {
    renderRows({ websiteDomain: null });
    expect(screen.getByTestId('fact-caveat-website')).toHaveTextContent(/nothing to scan/i);
  });
});

describe('★ 11c / 11d - hours and language open 02’s drawers', () => {
  it.each([
    ['hours', 'hours'],
    ['language', 'language'],
  ])('%s → ?panel=%s', (key, panel) => {
    renderRows();
    expect(screen.getByTestId(`fact-edit-${key}`)).toHaveAttribute(
      'href',
      `/settings/workspace?panel=${panel}`,
    );
  });

  it('★ the business rows open no drawer: they edit in place (BusinessFacts.test)', async () => {
    renderRows();
    for (const key of ['name', 'description', 'address']) {
      expect(screen.getByTestId(`fact-edit-${key}`).tagName).toBe('BUTTON');
    }
    await userEvent.click(screen.getByTestId('fact-edit-name'));
    expect(screen.getByTestId('fact-save-name')).toBeInTheDocument();
  });
});

describe('★ the language row is the business’s main language, by name', () => {
  it('"Hebrew", never "he", and claims nothing about replies or the system', () => {
    renderRows();
    const value = screen.getByTestId('fact-value-language');
    expect(value).toHaveTextContent(/^Hebrew$/);
  });

  it('falls back to Not set when no language is stored', () => {
    renderRows({ languages: [] });
    expect(screen.getByTestId('fact-value-language')).toHaveTextContent(/not set/i);
  });
});

describe('★ the From website badge is inline, and only where it is true', () => {
  it('marks a scan-owned field on its own row', () => {
    renderRows({ fieldSources: { businessDescription: 'scan' } });
    const row = screen.getByTestId('fact-description');
    expect(within(row).getByTestId('fact-origin-description')).toHaveTextContent(
      /from your website/i,
    );
  });

  it('marks nothing when provenance is empty, which is every tenant today', () => {
    renderRows();
    expect(screen.queryByTestId('fact-origin-description')).toBeNull();
    expect(screen.queryByTestId('fact-origin-name')).toBeNull();
  });

  it('does NOT badge a human-edited field', () => {
    renderRows({ fieldSources: { businessDescription: 'human' } });
    expect(screen.queryByTestId('fact-origin-description')).toBeNull();
  });

  it('★ never badges Opening hours: nothing records who wrote them', () => {
    renderRows({ fieldSources: { businessDescription: 'scan', address: 'scan' } });
    expect(screen.queryByTestId('fact-origin-hours')).toBeNull();
  });

  it('never badges Currency & time zone, which is two fields', () => {
    renderRows({ fieldSources: { currency: 'scan' } });
    expect(screen.queryByTestId('fact-origin-currencyTimezone')).toBeNull();
  });
});

describe('★ 11e · the single value edits in place, with the keyboard', () => {
  it('Enter with nothing changed closes and sends nothing - never a zone nobody chose', async () => {
    saveWorkspace.mockResolvedValue({ ok: true, data: {} });
    renderRows();
    await userEvent.click(screen.getByTestId('fact-edit-currencyTimezone'));
    await userEvent.type(screen.getByTestId('timezone-select'), '{Enter}');
    expect(saveWorkspace).not.toHaveBeenCalled();
    expect(screen.queryByTestId('fact-save-currencyTimezone')).toBeNull();
  });

  it('cancels on Escape without saving', async () => {
    renderRows();
    await userEvent.click(screen.getByTestId('fact-edit-currencyTimezone'));
    expect(screen.getByTestId('fact-save-currencyTimezone')).toBeInTheDocument();
    await userEvent.type(screen.getByTestId('timezone-select'), '{Escape}');
    expect(screen.queryByTestId('fact-save-currencyTimezone')).toBeNull();
    expect(saveWorkspace).not.toHaveBeenCalled();
  });
});

describe('★★ 11e · the time zone is a list that opens (Omer, 2026-10-11)', () => {
  it('a real select - not an <input list>, which a browser does not open on a click', async () => {
    renderRows();
    await userEvent.click(screen.getByTestId('fact-edit-currencyTimezone'));
    const zone = screen.getByTestId('timezone-select');
    expect(zone.tagName).toBe('SELECT');
    expect(zone.querySelectorAll('option').length).toBeGreaterThan(100);
    expect(document.querySelector('datalist')).toBeNull();
  });

  it('offers each zone by its city and offset, valued as the IANA id', async () => {
    renderRows();
    await userEvent.click(screen.getByTestId('fact-edit-currencyTimezone'));
    const options = [...screen.getByTestId('timezone-select').querySelectorAll('option')];
    const jerusalem = options.find((o) => o.value === 'Asia/Jerusalem');
    expect(jerusalem?.textContent).toMatch(/^Jerusalem \(GMT/);
  });

  it('★★ the common ones first - Jerusalem, the stored zone, London, New York, Paris, UTC (Omer, 2026-10-11)', async () => {
    renderRows({ timezone: 'Asia/Tokyo' });
    await userEvent.click(screen.getByTestId('fact-edit-currencyTimezone'));
    const common = [...screen.getByTestId('timezone-common').querySelectorAll('option')].map(
      (o) => o.value,
    );
    expect(common).toEqual([
      'Asia/Jerusalem',
      'Asia/Tokyo',
      'Europe/London',
      'America/New_York',
      'Europe/Paris',
      'UTC',
    ]);
    // …and none of them again below.
    const all = [...screen.getByTestId('timezone-all').querySelectorAll('option')].map(
      (o) => o.value,
    );
    for (const zone of common) expect(all).not.toContain(zone);
  });

  it('opens on the stored zone, and the currency beside it', async () => {
    renderRows();
    await userEvent.click(screen.getByTestId('fact-edit-currencyTimezone'));
    expect(screen.getByTestId('timezone-select')).toHaveValue('Europe/London');
    expect(screen.getByTestId('currency-select')).toHaveDisplayValue('$ USD');
  });

  it('★ picking a zone saves its IANA id - and only what changed', async () => {
    saveWorkspace.mockResolvedValue({ ok: true, data: {} });
    renderRows();
    await userEvent.click(screen.getByTestId('fact-edit-currencyTimezone'));
    await userEvent.selectOptions(screen.getByTestId('timezone-select'), 'Asia/Jerusalem');
    await userEvent.click(screen.getByTestId('fact-save-currencyTimezone'));
    expect(saveWorkspace).toHaveBeenCalledWith({ timezone: 'Asia/Jerusalem' }, null);
  });

  it('⚠ a stored zone this browser does not list is still shown, and kept', async () => {
    renderRows({ timezone: 'Mars/Olympus_Mons' });
    await userEvent.click(screen.getByTestId('fact-edit-currencyTimezone'));
    expect(screen.getByTestId('timezone-select')).toHaveValue('Mars/Olympus_Mons');
  });

  it('the read row says it the same way', () => {
    renderRows();
    expect(screen.getByTestId('fact-value-currencyTimezone')).toHaveTextContent(
      /^\$ USD · London \(GMT/,
    );
  });
});

describe('★ a missing key renders as NOTHING in production, not as a key', () => {
  /*
   * `getMessageFallback` is `''` in production - the capture build - so a
   * broken key does not shout, it disappears. Only a POSITIVE assertion sees
   * it; these pin the mechanism.
   */
  const renderWithProdFallback = (catalogue: Record<string, unknown>) =>
    render(
      <NextIntlClientProvider
        locale="en"
        messages={{ workspace: catalogue }}
        getMessageFallback={() => ''}
      >
        <FactRows workspace={ws()} />
      </NextIntlClientProvider>,
    );

  it('★ a POSITIVE assertion catches a lost label and a negative one does not', () => {
    const broken = JSON.parse(JSON.stringify(messages));
    delete broken.fact.language;
    renderWithProdFallback(broken);
    const row = screen.getByTestId('fact-language');
    // Satisfied by absence, therefore useless:
    expect(row.textContent).not.toMatch(/⟪|⟫|IntlError|fact\.language/);
    // Fails, because the label is not there:
    expect(row.textContent).not.toMatch(/^Language/);
  });

  it('and the real catalogue renders the label the guard looks for', () => {
    renderRows();
    expect(screen.getByTestId('fact-language')).toHaveTextContent(/^Language/);
  });
});

describe('★ the hours row says "Set" only when there is a week', () => {
  it('{ enabled: false } with no schedule - dev’s - is "Not set"', () => {
    renderRows({ hours: { enabled: false } });
    expect(screen.getByTestId('fact-value-hours')).toHaveTextContent(/not set/i);
  });

  it('a stored week switched off is "switched off"', () => {
    renderRows({
      hours: {
        enabled: false,
        schedule: { sunday: { enabled: true, open: '09:00', close: '18:00' } },
      },
    });
    expect(screen.getByTestId('fact-value-hours')).toHaveTextContent(/switched off/i);
  });
});

describe('★★ the time zone in the reader’s words, and only ever the one chosen (14" sweep, A9)', () => {
  it('Hebrew: the zone’s Hebrew name and its offset - never "London"', async () => {
    const he = (await import('@/i18n/messages/he/workspace.json')).default;
    render(
      <NextIntlClientProvider locale="he" messages={{ workspace: he }}>
        <FactRows workspace={ws()} />
      </NextIntlClientProvider>,
    );
    const row = screen.getByTestId('fact-value-currencyTimezone');
    expect(row).toHaveTextContent('שעון בריטניה (GMT');
    expect(row).not.toHaveTextContent('London');
  });

  it('none stored: the platform’s default is said as the default', () => {
    renderRows({ timezone: null });
    expect(screen.getByTestId('fact-value-currencyTimezone')).toHaveTextContent(
      /Jerusalem \(GMT.*\) \(default\)/,
    );
  });

  it('none stored: changing the currency sends the currency alone - no zone', async () => {
    saveWorkspace.mockResolvedValue({ ok: true, data: {} });
    renderRows({ timezone: null });
    await userEvent.click(screen.getByTestId('fact-edit-currencyTimezone'));
    expect(screen.getByTestId('timezone-select')).toHaveValue('');
    await userEvent.selectOptions(screen.getByTestId('currency-select'), 'ILS');
    await userEvent.click(screen.getByTestId('fact-save-currencyTimezone'));
    expect(saveWorkspace).toHaveBeenCalledWith({ currency: 'ILS' }, null);
  });
});
