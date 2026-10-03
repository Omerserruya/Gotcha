import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { workspaceSchema } from '@/api/contracts/workspace';
import messages from '@/i18n/messages/en/workspace.json';

import { FactRows } from './FactRows';

/*
 * `saveWorkspaceFacts` — the name the component imports.
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
 * `not.toHaveBeenCalled()` fail against a call from a different test — which
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

describe('★ 11c · the week, and what cannot be stored beside it', () => {
  const openHours = async () => {
    renderRows();
    await userEvent.click(screen.getByTestId('fact-edit-hours'));
  };

  it('names the split shift it cannot save', async () => {
    /*
     * `dayScheduleSchema` is `{ enabled, open?, close? }` — one range per
     * day. The design draws "+ Split" on every row. A merchant who closes
     * for lunch needs to know GOTCHA cannot be told that, rather than
     * hunting for the control.
     */
    await openHours();
    expect(screen.getByTestId('hours-one-range')).toHaveTextContent(/split shift/i);
    expect(screen.getByTestId('hours-one-range')).toHaveTextContent(/nowhere to be stored/i);
  });

  it('names the holiday calendar it does not have', async () => {
    await openHours();
    const note = screen.getByTestId('hours-no-holidays');
    expect(note).toHaveTextContent(/no holiday calendar/i);
    // Including the one-off closure, which is the part people actually need.
    expect(note).toHaveTextContent(/one-off closure/i);
  });

  it('copies Sunday across the working week without saving anything', async () => {
    await openHours();
    await userEvent.click(screen.getByTestId('hours-copy-sunday'));
    expect(screen.getByTestId('hours-copied')).toHaveTextContent(/copied to Monday/i);
    // Local only: nothing is written until Save, so the action is safe to undo
    // by cancelling.
    expect(saveWorkspace).not.toHaveBeenCalled();
  });

  it('★ offers the outside-hours message the design sends to Studio', async () => {
    /*
     * The design says it is set in Studio. The line a customer actually
     * receives comes from THIS setting: `ai-bot.service.ts:868` reads
     * `biz.cfg?.outsideHoursHandoffMessage`, and `biz.cfg` is
     * `parseBusinessHours` of the businessHours setting this form writes.
     */
    await openHours();
    expect(screen.getByLabelText(/what customers are told/i)).toBeInTheDocument();
    expect(screen.getByTestId('hours-ai-outside')).toBeInTheDocument();
  });

  it('says what happens when the message is left empty', async () => {
    // GOTCHA computes the next opening from the week above rather than
    // sending nothing, and that is worth knowing before you leave it blank.
    await openHours();
    expect(screen.getByText(/says when you next open/i)).toBeInTheDocument();
  });
});

describe('★ 11e · single values edit in place, with the keyboard', () => {
  it('saves on Enter', async () => {
    /*
     * "Enter saves, Esc cancels." There was no keyboard handling at all —
     * every row had to be finished with the mouse.
     */
    saveWorkspace.mockResolvedValue({ ok: true, data: {} });
    renderRows();
    await userEvent.click(screen.getByTestId('fact-edit-name'));
    await userEvent.type(screen.getByDisplayValue('Urban Supply'), ' Ltd{Enter}');
    expect(saveWorkspace).toHaveBeenCalled();
  });

  it('cancels on Escape without saving', async () => {
    renderRows();
    await userEvent.click(screen.getByTestId('fact-edit-name'));
    expect(screen.getByTestId('fact-save-name')).toBeInTheDocument();

    // From inside the field, which is where a person's hands are. Pressing it
    // with focus on `body` would test the document, not the row.
    await userEvent.type(screen.getByDisplayValue('Urban Supply'), '{Escape}');
    expect(screen.queryByTestId('fact-save-name')).toBeNull();
    expect(saveWorkspace).not.toHaveBeenCalled();
  });

  it('★ does NOT save the hours grid on Enter', async () => {
    /*
     * Seven days of time inputs. Enter while one has focus would commit a
     * half-entered week, and the grid is the one place where "move to the
     * next field" is far likelier to be what was meant.
     */
    renderRows();
    await userEvent.click(screen.getByTestId('fact-edit-hours'));
    await userEvent.type(screen.getAllByRole('checkbox')[0]!, '{Enter}');
    expect(saveWorkspace).not.toHaveBeenCalled();
    // And it stays open, rather than silently closing.
    expect(screen.getByTestId('fact-save-hours')).toBeInTheDocument();
  });

  it('still cancels the hours grid on Escape', async () => {
    // Esc has no destructive reading, so it works everywhere.
    renderRows();
    await userEvent.click(screen.getByTestId('fact-edit-hours'));
    await userEvent.type(screen.getAllByRole('checkbox')[0]!, '{Escape}');
    expect(screen.queryByTestId('fact-save-hours')).toBeNull();
  });
});

describe('★ 11e · the time zone picker is searchable', () => {
  it('offers the IANA zones, which carry the city in the name', async () => {
    // "Pickers are searchable (time zone by city)" — typing "Jer" finds
    // Asia/Jerusalem, because the zone name contains the city.
    renderRows();
    await userEvent.click(screen.getByTestId('fact-edit-currencyTimezone'));
    const list = screen.getByTestId('timezone-options');
    expect(list.querySelectorAll('option').length).toBeGreaterThan(100);
    expect(list.querySelector('option[value="Asia/Jerusalem"]')).not.toBeNull();
  });

  it('leaves the field free text, so an unlisted zone can still be saved', async () => {
    /*
     * The server stores a string. A tenant on a zone this browser's ICU does
     * not list must not be locked out of saving their own value — the
     * datalist is autocomplete, not a whitelist.
     */
    renderRows();
    await userEvent.click(screen.getByTestId('fact-edit-currencyTimezone'));
    const input = screen.getByDisplayValue('Europe/London');
    expect(input).toHaveAttribute('list', 'timezone-options');
    expect(input.tagName).toBe('INPUT');
  });
});

describe('★ a missing key renders as NOTHING in production, not as a key', () => {
  /*
   * `src/i18n/request.ts:51`:
   *
   *     getMessageFallback: NODE_ENV === 'production' ? '' : `⟪ns.key⟫`
   *
   * The capture runs `next start` — the production build — so a broken
   * message key does not shout, it disappears. The e2e guard written for
   * 11d's defect asserted the ABSENCE of a dotted path and of next-intl's
   * error text, and neither is producible here: an empty label contains
   * neither, so the guard passed by absence.
   *
   * These pin the mechanism, so the reasoning behind the e2e assertion is
   * checked by something that runs rather than by a comment.
   */
  const renderWithProdFallback = (messages: Record<string, unknown>) =>
    render(
      <NextIntlClientProvider
        locale="en"
        messages={{ workspace: messages }}
        getMessageFallback={() => ''}
      >
        <FactRows workspace={ws()} />
      </NextIntlClientProvider>,
    );

  it('renders an EMPTY label when the key is gone', async () => {
    const broken = JSON.parse(JSON.stringify(messages));
    delete broken.fact.language;

    renderWithProdFallback(broken);
    await userEvent.click(screen.getByTestId('fact-edit-language'));

    // The failure mode, demonstrated: no error text, no dotted path, nothing.
    const row = screen.getByTestId('fact-language');
    expect(row.textContent).not.toMatch(/IntlError|MISSING_MESSAGE|INSUFFICIENT_PATH/);
    expect(row.textContent).not.toMatch(/\bfact\.language\b/);
  });

  it('★ a POSITIVE assertion catches it and a negative one does not', async () => {
    const broken = JSON.parse(JSON.stringify(messages));
    delete broken.languageNote;

    renderWithProdFallback(broken);
    await userEvent.click(screen.getByTestId('fact-edit-language'));
    const row = screen.getByTestId('fact-language');

    // What the first guard did — satisfied by absence, therefore useless.
    expect(row.textContent).not.toMatch(/⟪|⟫/);

    // What the guard does now — fails, because the sentence is not there.
    expect(row.textContent).not.toMatch(/One language is stored/);
  });

  it('and the real catalogue renders the sentence the guard looks for', async () => {
    renderRows();
    await userEvent.click(screen.getByTestId('fact-edit-language'));
    expect(screen.getByTestId('fact-language')).toHaveTextContent(/One language is stored/);
    expect(screen.getByLabelText('Language')).toBeInTheDocument();
  });
});
