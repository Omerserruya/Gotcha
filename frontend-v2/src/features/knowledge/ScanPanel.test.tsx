import { readFileSync } from 'node:fs';

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScanRun } from '@/api/contracts/workspace';

import messages from '@/i18n/messages/en/knowledge.json';

import { MAX_MISSED_READS, SCAN_POLL_MS, ScanPanel } from './ScanPanel';

/*
 * The SAME actions as on Workspace: the panel moved to Knowledge (Omer,
 * 2026-10-11), its writes did not. Mocked at the workspace module's path, so
 * a panel that called anything else would reach a real server action here.
 */
const { startWorkspaceScan, readWorkspaceScan, acceptScanFields } = vi.hoisted(() => ({
  startWorkspaceScan: vi.fn(),
  readWorkspaceScan: vi.fn(),
  acceptScanFields: vi.fn(),
}));
vi.mock('@/features/workspace/actions', () => ({
  startWorkspaceScan,
  readWorkspaceScan,
  acceptScanFields,
}));

/**
 * Screen 11b, on Studio · Knowledge.
 *
 * ★ The live path is NEVER exercised here. `startWorkspaceScan` re-crawls a
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
  startWorkspaceScan.mockReset();
  readWorkspaceScan.mockReset();
  acceptScanFields.mockReset();
});
afterEach(() => vi.useRealTimers());

const renderPanel = (
  domain: string | null = 'urban-supply.example',
  running: ScanRun | null = null,
) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ knowledge: messages }}>
      <ScanPanel domain={domain} running={running} />
    </NextIntlClientProvider>,
  );

/** A run as the server keeps it (auth 8d01252f). */
const run = (over: Partial<ScanRun> = {}): ScanRun => ({
  status: 'done',
  startedAt: '2026-10-14T10:00:00Z',
  finishedAt: '2026-10-14T10:00:26Z',
  reason: null,
  applied: [],
  offer: [],
  reach: null,
  knowledge: null,
  unchanged: false,
  ...over,
});
/** A start that comes back with the run already ended - the result views, without the wait. */
const started = (over: Partial<ScanRun> = {}) => ({ ok: true, run: run(over) });

type Offer = ScanRun['offer'][number];
const offer = (over: Partial<Offer> = {}): Offer => ({
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
  it('names the domain and what will and will not be touched - on Scan again', () => {
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

  it('the banner names the domain, and says what it refreshes - on Workspace, not here', () => {
    renderPanel();
    const intro = screen.getByTestId('scan-intro');
    expect(intro).toHaveTextContent(/urban-supply\.example/);
    // Names the marking, and where the marked details live.
    expect(intro).toHaveTextContent(/marked “From your website” in Settings · Workspace/);
    // ★ Since auth 8d01252f it refreshes the pages it made here too - and says so.
    expect(intro).toHaveTextContent(/refreshes the pages it made from your site/i);
    expect(intro).toHaveTextContent(/keeps any page you edited/i);
    expect(intro).not.toHaveTextContent(/does not change the pages/i);
  });

  it('drops the domain clause when there is no website', () => {
    renderPanel(null);
    const intro = screen.getByTestId('scan-intro');
    expect(intro).toHaveTextContent(/filled in when you signed up/i);
    expect(intro).not.toHaveTextContent(/from\s+·/i);
  });

  it('★ Scan again starts the workspace scan - once, in the reader’s language', async () => {
    startWorkspaceScan.mockResolvedValue(
      started({
        applied: [],
        offer: [],
        reach: null,
      }),
    );
    renderPanel();
    await userEvent.click(screen.getByTestId('scan-run'));
    await screen.findByTestId('scan-result');
    expect(startWorkspaceScan).toHaveBeenCalledTimes(1);
    // The reader's language, so the pages it writes are in it.
    expect(startWorkspaceScan).toHaveBeenCalledWith('en', false);
    expect(acceptScanFields).not.toHaveBeenCalled();
  });
});

describe('★ six failures, six sentences', () => {
  it.each([
    ['no_domain', /does not have your website address/i],
    ['fetch_failed', /did not answer/i],
    ['scan_failed', /could not make sense of it/i],
    ['no_profile', /no business profile yet/i],
    ['internal_error', /went wrong on our side/i],
    ['timed_out', /took too long/i],
    // One the screen does not know: still a sentence, never a blank.
    ['new_reason', /scan didn't run|could not run|did not run/i],
  ])('says the right thing for %s', async (reason, expected) => {
    /*
     * "You have not told us your website" and "the site did not answer" need
     * different actions from the reader. One "scan failed" would serve
     * neither.
     */
    startWorkspaceScan.mockResolvedValue(started({ status: 'failed', reason }));
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
    startWorkspaceScan.mockResolvedValue(
      started({
        applied: [],
        offer: [offer()],
        reach: { requested: 17, pagesRead: 17, distinctTextPages: 1 },
      }),
    );
    renderPanel();
    await userEvent.click(screen.getByTestId('scan-run'));
    const caveat = await screen.findByTestId('scan-unreadable');
    expect(caveat).toHaveTextContent(/every page it returned was the same one/i);
    expect(caveat).toHaveTextContent(/inferred from that page/i);
  });

  it('says nothing when the site was genuinely readable', async () => {
    startWorkspaceScan.mockResolvedValue(
      started({
        applied: [],
        offer: [offer()],
        reach: { requested: 12, pagesRead: 11, distinctTextPages: 9 },
      }),
    );
    renderPanel();
    await userEvent.click(screen.getByTestId('scan-run'));
    await screen.findByTestId('scan-result');
    expect(screen.queryByTestId('scan-unreadable')).toBeNull();
  });
});

describe('★ the two reasons a field was not taken are different admissions', () => {
  it('says the merchant edited it', async () => {
    startWorkspaceScan.mockResolvedValue(
      started({
        applied: [],
        offer: [offer({ because: 'human_edited' })],
        reach: null,
      }),
    );
    renderPanel();
    await userEvent.click(screen.getByTestId('scan-run'));
    expect(await screen.findByTestId('scan-offer-because')).toHaveTextContent(/you edited this/i);
  });

  it('says nobody recorded who wrote it - which is every field on this estate', async () => {
    startWorkspaceScan.mockResolvedValue(
      started({
        applied: [],
        offer: [offer()],
        reach: null,
      }),
    );
    renderPanel();
    await userEvent.click(screen.getByTestId('scan-run'));
    const because = await screen.findByTestId('scan-offer-because');
    expect(because).toHaveTextContent(/nobody recorded who wrote this/i);
    // Not the merchant's doing, so it must not read as though it were.
    expect(because).not.toHaveTextContent(/you edited/i);
  });

  it('shows both values, so the choice is visible', async () => {
    startWorkspaceScan.mockResolvedValue(
      started({
        applied: [],
        offer: [offer()],
        reach: null,
      }),
    );
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
    startWorkspaceScan.mockResolvedValue(
      started({
        applied: [],
        offer: [offer()],
        reach: null,
      }),
    );
    renderPanel();
    await userEvent.click(screen.getByTestId('scan-run'));
    expect(await screen.findByTestId('scan-offer-intro')).toHaveTextContent(
      /future scans will refresh it without asking/i,
    );
  });

  it('sends field NAMES only, never the value', async () => {
    // The body carries field names so a client cannot mark arbitrary text as
    // website-owned. Asserted, because the obvious shape is to send both.
    startWorkspaceScan.mockResolvedValue(
      started({
        applied: [],
        offer: [offer()],
        reach: null,
      }),
    );
    acceptScanFields.mockResolvedValue({ accepted: ['businessDescription'], skipped: [] });
    renderPanel();
    await userEvent.click(screen.getByTestId('scan-run'));
    await userEvent.click(await screen.findByTestId('scan-accept-businessDescription'));
    expect(acceptScanFields).toHaveBeenCalledWith(['businessDescription']);
  });

  it('reports a proposal that had gone stale rather than claiming success', async () => {
    startWorkspaceScan.mockResolvedValue(
      started({
        applied: [],
        offer: [offer()],
        reach: null,
      }),
    );
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
    startWorkspaceScan.mockResolvedValue(
      started({
        applied: [],
        offer: [offer()],
        reach: null,
      }),
    );
    renderPanel();
    await userEvent.click(screen.getByTestId('scan-run'));
    expect(await screen.findByTestId('scan-applied')).toHaveTextContent(
      /no field is marked as coming from your website yet/i,
    );
  });

  it('says the site agrees when there is nothing at all to do', async () => {
    startWorkspaceScan.mockResolvedValue(
      started({
        applied: [],
        offer: [],
        reach: null,
      }),
    );
    renderPanel();
    await userEvent.click(screen.getByTestId('scan-run'));
    expect(await screen.findByTestId('scan-no-changes')).toHaveTextContent(/says the same/i);
  });
});

describe('★ every class the panel names is defined in its stylesheet', () => {
  /*
   * `provenanceBasis` was used on four lines from 32c7df6a on and defined
   * nowhere - a CSS module answers an unknown name with `undefined`, so the
   * lines took whatever size they inherited and nothing said so.
   */
  const tsx = readFileSync('src/features/knowledge/ScanPanel.tsx', 'utf8');
  const css = readFileSync('src/features/knowledge/ScanPanel.module.css', 'utf8');
  const used = [...new Set([...tsx.matchAll(/styles\.([A-Za-z0-9_]+)/g)].map((m) => m[1]!))];

  it('reads the names it checks', () => {
    expect(used).toContain('provenanceBasis');
    expect(used.length).toBeGreaterThan(10);
  });

  it.each(used)('.%s', (name) => {
    expect(css).toMatch(new RegExp(`\\.${name}\\s*[{,:]`));
  });

  it('the basis is the quieter line under the lead it qualifies', () => {
    const rule = css.match(/\.provenanceBasis\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/font-size:\s*var\(--font-size-caption\)/);
    expect(rule).toMatch(/color:\s*var\(--text-subtle\)/);
  });
});

describe('★★ a rescan is a run: started, followed, ended (2026-10-14)', () => {
  it('★★ started: "running" while it runs, read every few seconds, then the result', async () => {
    vi.useFakeTimers();
    startWorkspaceScan.mockResolvedValue({ ok: true, run: run({ status: 'running' }) });
    readWorkspaceScan
      .mockResolvedValueOnce(run({ status: 'running' }))
      .mockResolvedValueOnce(run({ applied: ['industry'] }));
    renderPanel();
    await act(async () => screen.getByTestId('scan-run').click());
    expect(screen.getByTestId('scan-running')).toHaveTextContent(/usually takes under a minute/i);
    expect(screen.getByTestId('scan-run')).toBeDisabled();
    expect(readWorkspaceScan).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(SCAN_POLL_MS));
    expect(readWorkspaceScan).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('scan-running')).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTime(SCAN_POLL_MS));
    expect(readWorkspaceScan).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('scan-running')).toBeNull();
    expect(screen.getByTestId('scan-applied')).toHaveTextContent(/one field was refreshed/i);
    expect(screen.getByTestId('scan-run')).toBeEnabled();
    // Ended: never read again.
    await act(async () => vi.advanceTimersByTime(SCAN_POLL_MS * 4));
    expect(readWorkspaceScan).toHaveBeenCalledTimes(2);
  });

  it('★★ one already running when the page opens is followed from where it is', async () => {
    vi.useFakeTimers();
    readWorkspaceScan.mockResolvedValue(run({ status: 'failed', reason: 'timed_out' }));
    renderPanel('urban-supply.example', run({ status: 'running' }));
    expect(screen.getByTestId('scan-running')).toBeInTheDocument();
    expect(startWorkspaceScan).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(SCAN_POLL_MS));
    expect(screen.getByTestId('scan-refusal')).toHaveTextContent(/took too long/i);
  });

  it('★ a read that fails is tried again; three in a row and it says it lost track - never spins', async () => {
    vi.useFakeTimers();
    readWorkspaceScan.mockResolvedValue(undefined);
    renderPanel('urban-supply.example', run({ status: 'running' }));
    for (let i = 1; i < MAX_MISSED_READS; i += 1) {
      await act(async () => vi.advanceTimersByTime(SCAN_POLL_MS));
      expect(screen.getByTestId('scan-running')).toBeInTheDocument();
    }
    await act(async () => vi.advanceTimersByTime(SCAN_POLL_MS));
    expect(screen.getByTestId('scan-lost')).toHaveTextContent(/reload the page/i);
    expect(screen.queryByTestId('scan-running')).toBeNull();
    expect(screen.getByTestId('scan-run')).toBeEnabled();
    await act(async () => vi.advanceTimersByTime(SCAN_POLL_MS * 4));
    expect(readWorkspaceScan).toHaveBeenCalledTimes(MAX_MISSED_READS);
  });

  it('a start refused for permission says so; any other, that it did not run', async () => {
    startWorkspaceScan.mockResolvedValueOnce({ ok: false, reason: 'forbidden' });
    renderPanel();
    await userEvent.click(screen.getByTestId('scan-run'));
    expect(await screen.findByTestId('scan-failed')).toHaveTextContent(/permission/i);
    startWorkspaceScan.mockResolvedValueOnce({ ok: false, reason: 'failed' });
    await userEvent.click(screen.getByTestId('scan-run'));
    await waitFor(() =>
      expect(screen.getByTestId('scan-failed')).not.toHaveTextContent(/permission/i),
    );
  });
});

describe('★★ what it did to the pages it made, in counts', () => {
  it('each count that is not zero, in words; the zeros left out', async () => {
    startWorkspaceScan.mockResolvedValue(
      started({
        knowledge: { created: 0, updated: 2, unchanged: 0, preserved: 1, removed: 0, failed: 0 },
      }),
    );
    renderPanel();
    await userEvent.click(screen.getByTestId('scan-run'));
    expect(await screen.findByTestId('scan-knowledge')).toHaveTextContent(
      /^2 pages updated, 1 page kept because you edited it\.$/,
    );
    // Pages changed: "the site says the same" would be false.
    expect(screen.queryByTestId('scan-no-changes')).toBeNull();
  });

  it('nothing counted: no line at all', async () => {
    startWorkspaceScan.mockResolvedValue(
      started({
        knowledge: { created: 0, updated: 0, unchanged: 0, preserved: 0, removed: 0, failed: 0 },
      }),
    );
    renderPanel();
    await userEvent.click(screen.getByTestId('scan-run'));
    await screen.findByTestId('scan-result');
    expect(screen.queryByTestId('scan-knowledge')).toBeNull();
    expect(screen.getByTestId('scan-no-changes')).toBeInTheDocument();
  });
});

describe('★ the site read the same as last time (auth 9544af08)', () => {
  it('said - nothing to update - with a small way to scan anyway, which sends force', async () => {
    startWorkspaceScan.mockResolvedValue(started({ unchanged: true }));
    renderPanel();
    await userEvent.click(screen.getByTestId('scan-run'));
    expect(await screen.findByTestId('scan-unchanged')).toHaveTextContent(
      "Your site hasn't changed since the last scan. There's nothing to update.",
    );
    expect(screen.queryByTestId('scan-result')).toBeNull();
    startWorkspaceScan.mockResolvedValue(started({ unchanged: false }));
    await userEvent.click(screen.getByTestId('scan-force'));
    expect(startWorkspaceScan).toHaveBeenLastCalledWith('en', true);
    expect(await screen.findByTestId('scan-result')).toBeInTheDocument();
    expect(screen.queryByTestId('scan-unchanged')).toBeNull();
  });
});
