import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { discoverJobSchema, type DiscoverJob } from '@/api/contracts/onboarding-v2';
import onboardingEn from '@/i18n/messages/en/onboarding.json';

/** 00e on the site job. Mocked: nothing is read, nothing is started. */
const { scan, router } = vi.hoisted(() => ({
  scan: { readScan: vi.fn(), retryScan: vi.fn(), startScan: vi.fn() },
  router: { push: vi.fn(), replace: vi.fn() },
}));
vi.mock('./scan-actions', () => scan);
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => router,
  Link: ({ href, children, ...rest }: { href: unknown; children: ReactNode }) => (
    <a href={String(href)} {...rest}>
      {children}
    </a>
  ),
}));

import { ADVANCE_MS, mergeEvents, nextStep, POLL_MS, ReadingStep } from './ReadingStep';

const event = (seq: number, key: string, params = {}, kind = 'progress') => ({
  seq,
  at: '',
  stage: 'read_pages',
  kind,
  key,
  params,
});
const job = (over: Record<string, unknown> = {}): DiscoverJob =>
  discoverJobSchema.parse({
    jobId: 'j1',
    domain: 'https://avivco.il',
    status: 'RUNNING',
    stage: 'read_pages',
    events: [event(1, 'platform.detected', { platform: 'shopify' }, 'found')],
    counts: { pagesPlanned: 40, pagesRead: 12, pagesBlocked: 0 },
    found: { platform: 'shopify', productCount: 34, policies: ['returns'] },
    ...over,
  });
const show = (initial: DiscoverJob | null, preview = false) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ onboarding: onboardingEn }}>
      <ReadingStep initial={initial} preview={preview} />
    </NextIntlClientProvider>,
  );
const tick = async (ms = POLL_MS) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const lines = () => screen.queryAllByTestId('scan-line').map((li) => li.textContent);

beforeEach(() => {
  vi.useFakeTimers();
  for (const each of [...Object.values(scan), ...Object.values(router)]) each.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('★★ reading the site, as it really goes', () => {
  it('★★ the stage in words, the pages, the feed and the chips; no percentage anywhere', () => {
    show(job());
    expect(screen.getByTestId('reading-title')).toHaveTextContent('Reading avivco.il');
    expect(screen.getByTestId('reading-stage')).toHaveTextContent('Reading the pages');
    expect(screen.getByTestId('reading-counts')).toHaveTextContent('12 of 40 pages read');
    expect(lines()).toEqual(['Found Shopify']);
    expect(screen.getByTestId('scan-chip-products')).toHaveTextContent('34 products');
    expect(screen.getByTestId('scan-chip-policy-returns')).toHaveTextContent('Returns policy');
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByTestId('reading').textContent).not.toMatch(/%/);
  });

  it('★★ polls every second with `since` the last seq; new lines on top, none drawn twice', async () => {
    scan.readScan.mockResolvedValue({
      ok: true,
      job: job({
        events: [
          event(1, 'platform.detected', { platform: 'shopify' }, 'found'),
          event(2, 'pages.planned', { count: 40, fromSitemap: true }),
        ],
      }),
    });
    show(job());
    await tick();
    expect(scan.readScan).toHaveBeenLastCalledWith(1);
    expect(lines()).toEqual(['40 pages to read', 'Found Shopify']);
    await tick();
    expect(scan.readScan).toHaveBeenLastCalledWith(2);
    expect(lines()).toHaveLength(2);
  });

  it('★ a newer job (another address) starts the feed over', async () => {
    scan.readScan.mockResolvedValue({
      ok: true,
      job: job({
        jobId: 'j2',
        events: [event(1, 'site.opening', { domain: 'https://other.co.il' })],
      }),
    });
    show(job());
    await tick();
    expect(lines()).toEqual(['Opening other.co.il']);
  });

  it('★ a look that failed is said, and the next one tries again', async () => {
    scan.readScan.mockResolvedValueOnce({ ok: false, reason: 'unread' });
    scan.readScan.mockResolvedValueOnce({ ok: true, job: job() });
    show(job());
    await tick();
    expect(screen.getByTestId('reading-missed')).toBeInTheDocument();
    await tick();
    expect(screen.queryByTestId('reading-missed')).toBeNull();
  });

  it('★ the first look failed: still reads, never "not started"', async () => {
    scan.readScan.mockResolvedValue({ ok: true, job: job() });
    show(null);
    expect(screen.getByTestId('reading-missed')).toBeInTheDocument();
    await tick();
    expect(screen.getByTestId('reading-stage')).toHaveTextContent('Reading the pages');
  });

  it('no job at all: back to the address', async () => {
    scan.readScan.mockResolvedValue({ ok: false, reason: 'none' });
    show(null);
    await tick();
    expect(router.replace).toHaveBeenCalledWith('/onboarding/website');
  });

  it('★★ finished: "Done", Continue, and it moves on by itself after a beat', async () => {
    show(job({ status: 'COMPLETE', stage: 'done' }));
    expect(screen.getByTestId('reading-stage')).toHaveTextContent('Done. Here is what we learned.');
    expect(screen.getByTestId('reading-next')).toHaveAttribute('href', nextStep(false));
    expect(router.push).not.toHaveBeenCalled();
    await tick(ADVANCE_MS);
    expect(router.push).toHaveBeenCalledWith(nextStep(false));
    expect(scan.readScan).not.toHaveBeenCalled();
  });

  it.each([
    ['site_unreachable', "We couldn't reach the site."],
    ['stage_failed', 'A step failed.'],
    ['nothing_learned', "We couldn't learn anything from the site."],
    ['a_new_code', 'Reading stopped.'],
  ])('★★ FAILED with %s: the real reason, carry on, or another address', (code, text) => {
    show(job({ status: 'FAILED', error: { code, stage: 'read_pages' } }));
    const stopped = screen.getByTestId('reading-stopped');
    expect(stopped).toHaveTextContent(text);
    expect(screen.getByTestId('reading-retry')).toBeEnabled();
    expect(screen.getByTestId('reading-change')).toHaveAttribute('href', '/onboarding/website');
  });

  it('★★ STALLED: said as stopped answering; Retry resumes it and polling starts again', async () => {
    scan.retryScan.mockResolvedValue(true);
    scan.readScan.mockResolvedValue({ ok: true, job: job() });
    show(job({ status: 'STALLED' }));
    expect(screen.getByTestId('reading-stopped')).toHaveTextContent('Reading stopped responding.');
    await act(async () => fireEvent.click(screen.getByTestId('reading-retry')));
    expect(scan.retryScan).toHaveBeenCalledTimes(1);
    await tick();
    expect(scan.readScan).toHaveBeenCalled();
    expect(screen.queryByTestId('reading-stopped')).toBeNull();
  });

  it('★ a retry that fails is said, and the way back stays', async () => {
    scan.retryScan.mockResolvedValue(false);
    show(job({ status: 'FAILED', error: { code: 'stage_failed', stage: 'extract' } }));
    await act(async () => fireEvent.click(screen.getByTestId('reading-retry')));
    expect(screen.getByTestId('reading-retry-failed')).toBeInTheDocument();
    expect(scan.readScan).not.toHaveBeenCalled();
  });

  it('★★ a site that refuses automatic reading: said, with what comes next', () => {
    show(
      job({
        found: { blocked: true },
        counts: { pagesPlanned: 40, pagesRead: 30, pagesBlocked: 10 },
      }),
    );
    expect(screen.getByTestId('reading-blocked')).toHaveTextContent(
      'The site refuses automatic reading.',
    );
    expect(screen.getByTestId('reading-counts')).toHaveTextContent(
      '10 pages refused automatic reading',
    );
  });

  it('in preview, a finished read never moves on by itself', async () => {
    show(job({ status: 'COMPLETE' }), true);
    await tick(ADVANCE_MS * 2);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('mergeEvents keeps one line per seq, in arrival order', () => {
    const a = event(1, 'job.started', { domain: 'https://a.co' });
    const b = event(2, 'sitemap.reading');
    expect(mergeEvents([a] as never, [a, b] as never).map((e) => e.seq)).toEqual([1, 2]);
  });
});
