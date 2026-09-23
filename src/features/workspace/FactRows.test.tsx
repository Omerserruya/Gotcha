import { render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { workspaceSchema } from '@/api/contracts/workspace';
import messages from '@/i18n/messages/en/workspace.json';

import { FactRows } from './FactRows';

vi.mock('./actions', () => ({ saveWorkspace: vi.fn() }));

/**
 * The fact rows, against the design's list.
 *
 * The screen had `Currency & language` and `Time zone` as two rows; the
 * design has `Language` and `Currency & time zone` — the same two rows
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
    // The old split is gone: neither the combined currency+language row nor a
    // lone timezone row exists.
    expect(screen.queryByTestId('fact-currencyLanguage')).toBeNull();
    expect(screen.queryByTestId('fact-timezone')).toBeNull();
  });

  it('carries the website row the screen was missing', () => {
    renderRows();
    expect(screen.getByTestId('fact-value-website')).toHaveTextContent(
      'urban-supply-gotcha-demo.myshopify.com',
    );
  });
});

describe('★ the website row does not claim a page count', () => {
  it('shows the domain and no number', () => {
    /*
     * The design's value is "avivco.il · 42 pages read, 3 days ago". `reach`
     * comes back from POST /workspace/scan and is on no GET, so neither the
     * count nor the date reaches this screen on load.
     *
     * And it is the safe direction to be missing it: `pagesRead` is 17 on
     * this tenant against `distinctTextPages` of 1 — every path answering
     * with the same login page — so a count here would be the exact sentence
     * the crawler's own comment forbids.
     */
    renderRows();
    const value = screen.getByTestId('fact-value-website');
    expect(value).not.toHaveTextContent(/pages read/i);
    expect(value).not.toHaveTextContent(/\d+\s*pages/i);
  });

  it('offers no Edit, because PATCH would refuse it', () => {
    // `PATCH /workspace` has a closed allow-list and websiteDomain is not on
    // it: a control here would 422 with `unknown field "websiteDomain"`.
    renderRows();
    expect(screen.queryByTestId('fact-edit-website')).toBeNull();
    expect(screen.getByTestId('fact-caveat-website')).toHaveTextContent(/reconnect your store/i);
  });

  it('says why an absent website matters, rather than just "Not set"', () => {
    renderRows({ websiteDomain: null });
    expect(screen.getByTestId('fact-caveat-website')).toHaveTextContent(/nothing to scan/i);
  });
});

describe('★ the language row says which language does what', () => {
  it('separates how customers are answered from what GOTCHA runs in', () => {
    renderRows();
    const value = screen.getByTestId('fact-value-language');
    // The stored value does not decide replies; the conversation does.
    expect(value).toHaveTextContent(/customers are answered in their own language/i);
    expect(value).toHaveTextContent(/GOTCHA runs in/i);
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
    // The badge says "from your website". "You typed this" on every untouched
    // row would be noise; the provenance panel carries the full account.
    renderRows({ fieldSources: { businessDescription: 'human' } });
    expect(screen.queryByTestId('fact-origin-description')).toBeNull();
  });

  it('★ never badges Opening hours, which the design does', () => {
    /*
     * Business hours live in `TenantSetting` and are not in
     * `PROVENANCED_FIELDS`, so nothing records whether the scan or a person
     * wrote them. The design puts "From website" there and we cannot back it.
     */
    renderRows({ fieldSources: { businessDescription: 'scan', address: 'scan' } });
    expect(screen.queryByTestId('fact-origin-hours')).toBeNull();
  });

  it('never badges Currency & time zone, which is two fields', () => {
    // One provenanced (`currency`), one not. A single badge would claim a
    // source for both.
    renderRows({ fieldSources: { currency: 'scan' } });
    expect(screen.queryByTestId('fact-origin-currencyTimezone')).toBeNull();
  });
});

describe('the header the badges depend on', () => {
  it('names the domain rather than saying "your website"', () => {
    renderRows();
    const intro = screen.getByTestId('facts-intro');
    expect(intro).toHaveTextContent(/urban-supply-gotcha-demo\.myshopify\.com/);
    expect(intro).toHaveTextContent(/only updates fields marked/i);
  });

  it('drops the domain clause when there is no website', () => {
    renderRows({ websiteDomain: null });
    const intro = screen.getByTestId('facts-intro');
    expect(intro).toHaveTextContent(/filled in when you signed up/i);
    expect(intro).not.toHaveTextContent(/from\s+·/i);
  });
});
