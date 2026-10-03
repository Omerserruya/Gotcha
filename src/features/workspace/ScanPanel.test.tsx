import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import messages from '@/i18n/messages/en/workspace.json';

import { ScanPanel } from './ScanPanel';

const { runWorkspaceScan, acceptScanFields } = vi.hoisted(() => ({
  runWorkspaceScan: vi.fn(),
  acceptScanFields: vi.fn(),
}));
vi.mock('./actions', () => ({ runWorkspaceScan, acceptScanFields }));

/**
 * Screen 11b.
 *
 * ★ The live path is NEVER exercised here. `runWorkspaceScan` re-crawls a
 * real website and `acceptScanFields` writes provenance; both are mocked.
 *
 * And the state that matters most to this screen is unreachable on this
 * tenant either way: a REAL scan producing a REAL proposal. Backend verified
 * the accept endpoint against a seeded proposal row, because a genuine rescan
 * dies at the model call on exhausted AI units. Storage and endpoint are
 * real; the scan that would produce the proposal is substituted. These tests
 * inherit that limit and do not paper over it.
 */

beforeEach(() => {
  runWorkspaceScan.mockReset();
  acceptScanFields.mockReset();
});

const renderPanel = (domain: string | null = 'urban-supply.example') =>
  render(
    <NextIntlClientProvider locale="en" messages={{ workspace: messages }}>
      <ScanPanel domain={domain} />
    </NextIntlClientProvider>,
  );

const offer = (over: Record<string, unknown> = {}) => ({
  field: 'businessDescription',
  current: 'Linen bedding',
  proposed: 'Linen bedding and bath textiles',
  because: 'source_unknown',
  ...over,
});

describe('★ what the scan will do is said before the button', () => {
  /*
   * S2 (2026-10-03): what a rescan will and will not touch is said ON the
   * control (02's banner has no paragraph), before it is pressed.
   */
  it('names the domain and what will and will not be touched — on Scan again', () => {
    renderPanel();
    const run = screen.getByTestId('scan-run');
    expect(run).toHaveAttribute('title', expect.stringMatching(/urban-supply\.example/));
    expect(run).toHaveAttribute('title', expect.stringMatching(/come back as suggestions/i));
    expect(run).toHaveAttribute(
      'title',
      expect.stringMatching(/only fields the website already owns/i),
    );
  });

  it('says nothing about a domain it does not have', () => {
    renderPanel(null);
    expect(screen.getByTestId('scan-run')).not.toHaveAttribute('title');
  });

  it('the banner names the domain rather than saying "your website"', () => {
    renderPanel();
    const intro = screen.getByTestId('facts-intro');
    expect(intro).toHaveTextContent(/urban-supply\.example/);
    expect(intro).toHaveTextContent(/only updates fields marked/i);
    // The legend is the chip's own words, so the sentence can point at it.
    expect(intro).toHaveTextContent('From your website');
  });

  it('drops the domain clause when there is no website', () => {
    renderPanel(null);
    const intro = screen.getByTestId('facts-intro');
    expect(intro).toHaveTextContent(/filled in when you signed up/i);
    expect(intro).not.toHaveTextContent(/from\s+·/i);
  });
});

describe('★ five refusals, five sentences', () => {
  it.each([
    ['no_domain', /does not have your website address/i],
    ['fetch_failed', /did not answer/i],
    ['scan_failed', /could not make sense of it/i],
    ['scan_in_progress', /already running/i],
    ['no_profile', /no business profile yet/i],
  ])('says the right thing for %s', async (reason, expected) => {
    /*
     * "You have not told us your website" and "the site did not answer" need
     * different actions from the reader. One "scan failed" would serve
     * neither.
     */
    runWorkspaceScan.mockResolvedValue({ ok: false, reason, reach: null });
    renderPanel();
    await userEvent.click(screen.getByTestId('scan-run'));
    expect(await screen.findByTestId('scan-refusal')).toHaveTextContent(expected);
  });
});

describe('★ the login-wall caveat appears because a measurement says so', () => {
  it('warns when every page the crawl read was the same one', async () => {
    /*
     * Measured on this tenant: 17 requested, 17 returned, 1 distinct. Anything
     * proposed from such a crawl was inferred from a login screen.
     */
    runWorkspaceScan.mockResolvedValue({
      ok: true,
      applied: [],
      offer: [offer()],
      reach: { requested: 17, pagesRead: 17, distinctTextPages: 1 },
      fieldSources: {},
    });
    renderPanel();
    await userEvent.click(screen.getByTestId('scan-run'));
    const caveat = await screen.findByTestId('scan-unreadable');
    expect(caveat).toHaveTextContent(/every page it returned was the same one/i);
    expect(caveat).toHaveTextContent(/inferred from that page/i);
  });

  it('says nothing when the site was genuinely readable', async () => {
    runWorkspaceScan.mockResolvedValue({
      ok: true,
      applied: [],
      offer: [offer()],
      reach: { requested: 12, pagesRead: 11, distinctTextPages: 9 },
      fieldSources: {},
    });
    renderPanel();
    await userEvent.click(screen.getByTestId('scan-run'));
    await screen.findByTestId('scan-result');
    expect(screen.queryByTestId('scan-unreadable')).toBeNull();
  });
});

describe('★ the two reasons a field was not taken are different admissions', () => {
  it('says the merchant edited it', async () => {
    runWorkspaceScan.mockResolvedValue({
      ok: true,
      applied: [],
      offer: [offer({ because: 'human_edited' })],
      reach: null,
      fieldSources: {},
    });
    renderPanel();
    await userEvent.click(screen.getByTestId('scan-run'));
    expect(await screen.findByTestId('scan-offer-because')).toHaveTextContent(/you edited this/i);
  });

  it('says nobody recorded who wrote it — which is every field on this estate', async () => {
    runWorkspaceScan.mockResolvedValue({
      ok: true,
      applied: [],
      offer: [offer()],
      reach: null,
      fieldSources: {},
    });
    renderPanel();
    await userEvent.click(screen.getByTestId('scan-run'));
    const because = await screen.findByTestId('scan-offer-because');
    expect(because).toHaveTextContent(/nobody recorded who wrote this/i);
    // Not the merchant's doing, so it must not read as though it were.
    expect(because).not.toHaveTextContent(/you edited/i);
  });

  it('shows both values, so the choice is visible', async () => {
    runWorkspaceScan.mockResolvedValue({
      ok: true,
      applied: [],
      offer: [offer()],
      reach: null,
      fieldSources: {},
    });
    renderPanel();
    await userEvent.click(screen.getByTestId('scan-run'));
    expect(await screen.findByTestId('scan-offer-current')).toHaveTextContent('Linen bedding');
    expect(screen.getByTestId('scan-offer-proposed')).toHaveTextContent(/bath textiles/);
  });
});

describe('★ accepting says what it means before the click', () => {
  it('states that future scans will refresh the field without asking', async () => {
    /*
     * The endpoint stamps `scan`, not `human`. That is the consent being
     * collected, and "use this value" would not have collected it.
     */
    runWorkspaceScan.mockResolvedValue({
      ok: true,
      applied: [],
      offer: [offer()],
      reach: null,
      fieldSources: {},
    });
    renderPanel();
    await userEvent.click(screen.getByTestId('scan-run'));
    expect(await screen.findByTestId('scan-offer-intro')).toHaveTextContent(
      /future scans will refresh it without asking/i,
    );
  });

  it('sends field NAMES only, never the value', async () => {
    // The body carries field names so a client cannot mark arbitrary text as
    // website-owned. Asserted, because the obvious shape is to send both.
    runWorkspaceScan.mockResolvedValue({
      ok: true,
      applied: [],
      offer: [offer()],
      reach: null,
      fieldSources: {},
    });
    acceptScanFields.mockResolvedValue({ accepted: ['businessDescription'], skipped: [] });
    renderPanel();
    await userEvent.click(screen.getByTestId('scan-run'));
    await userEvent.click(await screen.findByTestId('scan-accept-businessDescription'));
    expect(acceptScanFields).toHaveBeenCalledWith(['businessDescription']);
  });

  it('reports a proposal that had gone stale rather than claiming success', async () => {
    runWorkspaceScan.mockResolvedValue({
      ok: true,
      applied: [],
      offer: [offer()],
      reach: null,
      fieldSources: {},
    });
    acceptScanFields.mockResolvedValue({
      accepted: [],
      skipped: [{ field: 'businessDescription', reason: 'not_proposed' }],
    });
    renderPanel();
    await userEvent.click(screen.getByTestId('scan-run'));
    await userEvent.click(await screen.findByTestId('scan-accept-businessDescription'));
    expect(await screen.findByTestId('scan-taken')).toHaveTextContent(/out of date/i);
  });
});

describe('nothing marked means nothing refreshed, and it says so', () => {
  it('reports an empty apply set as the estate-wide state it is', async () => {
    runWorkspaceScan.mockResolvedValue({
      ok: true,
      applied: [],
      offer: [offer()],
      reach: null,
      fieldSources: {},
    });
    renderPanel();
    await userEvent.click(screen.getByTestId('scan-run'));
    expect(await screen.findByTestId('scan-applied')).toHaveTextContent(
      /no field is marked as coming from your website yet/i,
    );
  });

  it('says the site agrees when there is nothing at all to do', async () => {
    runWorkspaceScan.mockResolvedValue({
      ok: true,
      applied: [],
      offer: [],
      reach: null,
      fieldSources: {},
    });
    renderPanel();
    await userEvent.click(screen.getByTestId('scan-run'));
    expect(await screen.findByTestId('scan-no-changes')).toHaveTextContent(/says the same/i);
  });
});
