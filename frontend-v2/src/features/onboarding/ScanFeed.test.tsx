import { act, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  jobEventSchema,
  jobFoundSchema,
  SHELL_STEPS,
  type JobEvent,
} from '@/api/contracts/onboarding-v2';
import onboardingEn from '@/i18n/messages/en/onboarding.json';
import onboardingHe from '@/i18n/messages/he/onboarding.json';

import {
  collapseFeed,
  FEED_KEYS,
  REVEAL_BACKLOG,
  REVEAL_FAST_MS,
  REVEAL_MS,
  ScanChips,
  ScanFeed,
} from './ScanFeed';

/* By code point: a literal here is the character the guard forbids. */
const DASHES = [String.fromCharCode(0x2013), String.fromCharCode(0x2014)];

/** Every param any key can carry, with values that look like the real ones. */
const PARAMS = {
  domain: 'https://avivco.il',
  platform: 'shopify',
  slug: 'returngo',
  count: 3,
  more: true,
  reason: 'disabled',
  fromSitemap: false,
  path: 'https://avivco.il/pages/returns-policy',
  kind: 'returns',
  pages: 4,
  blocked: 3,
  of: 40,
  code: 'site_unreachable',
  key: 'policy:returns',
  title: 'Returns policy',
  status: 500,
  slugs: 'shopify,returngo',
  contact: true,
  hours: false,
  scope: 'home',
};

const feedOf = (locale: 'en' | 'he', key: string, params = PARAMS) =>
  render(
    <NextIntlClientProvider
      locale={locale}
      messages={{ onboarding: locale === 'he' ? onboardingHe : onboardingEn }}
    >
      <ScanFeed
        events={[
          jobEventSchema.parse({ seq: 1, at: '', stage: null, kind: 'progress', key, params }),
        ]}
      />
    </NextIntlClientProvider>,
  );

describe('★★ the feed catalogue: every key Backend named, in both languages', () => {
  it.each(
    FEED_KEYS.flatMap((key) => (['he', 'en'] as const).map((locale) => [key, locale] as const)),
  )('%s renders in %s: a line, no raw URL, no wide dash', (key, locale) => {
    const { unmount } = feedOf(locale, key);
    const line = screen.getByTestId('scan-line').textContent ?? '';
    expect(line.trim().length).toBeGreaterThan(0);
    expect(line).not.toMatch(/https?:|\/\/|\/pages\//);
    for (const dash of DASHES) expect(line).not.toContain(dash);
    unmount();
  });

  it('★★ no wide dash anywhere in the scan catalogue, either language', () => {
    for (const catalogue of [onboardingEn.scan, onboardingHe.scan]) {
      const text = JSON.stringify(catalogue);
      for (const dash of DASHES) expect(text).not.toContain(dash);
    }
  });

  it('★ every scan key exists in Hebrew too', () => {
    const keys = (value: unknown, at = ''): string[] =>
      typeof value === 'object' && value !== null
        ? Object.entries(value).flatMap(([key, inner]) => keys(inner, `${at}.${key}`))
        : [at];
    expect(keys(onboardingHe.scan)).toEqual(keys(onboardingEn.scan));
  });

  it('★★ a page line says what the page is ABOUT, never its path', () => {
    feedOf('en', 'page.reading', { ...PARAMS, kind: 'returns' });
    expect(screen.getByTestId('scan-line')).toHaveTextContent('Reading a page about returns');
  });

  it('a page of a kind it does not know reads as the site', () => {
    feedOf('he', 'page.reading', { ...PARAMS, kind: 'mystery' });
    expect(screen.getByTestId('scan-line')).toHaveTextContent('קוראים עמוד על האתר');
  });

  it('★ a key this build does not know is dropped, never shown raw', () => {
    feedOf('en', 'teleport.started');
    expect(screen.queryByTestId('scan-line')).toBeNull();
  });

  it('★ a site’s own title is isolated, and shown with plain hyphens', () => {
    const dashed = `Returns ${DASHES[1]} 30 days`;
    feedOf('he', 'knowledge.written', { ...PARAMS, title: dashed });
    const line = screen.getByTestId('scan-line');
    expect(line.querySelector('bdi[dir="auto"]')).toHaveTextContent('Returns - 30 days');
  });

  it('platform and tool names: by name where known, as sent otherwise; Latin isolated', () => {
    const { unmount } = feedOf('he', 'platform.detected');
    expect(screen.getByTestId('scan-line').querySelector('bdi[dir="ltr"]')).toHaveTextContent(
      'Shopify',
    );
    unmount();
    feedOf('en', 'tool.detected', { ...PARAMS, slug: 'brand_new_tool' });
    expect(screen.getByTestId('scan-line')).toHaveTextContent('Saw brand_new_tool on the site');
  });
});

const ev = (seq: number, key: string, params: Record<string, unknown> = {}, kind = 'progress') =>
  jobEventSchema.parse({ seq, at: '', stage: null, kind, key, params });
const Stream = ({ events, live = true }: { events: JobEvent[]; live?: boolean }) => (
  <NextIntlClientProvider locale="en" messages={{ onboarding: onboardingEn }}>
    <ScanFeed events={events} live={live} />
  </NextIntlClientProvider>
);
const lines = () => screen.queryAllByTestId('scan-line').map((li) => li.textContent);
const tick = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe('★★ the stream: in time order, one line at a time, no repeats', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('★★ oldest at the top, newest at the bottom, every line kept: never reordered', () => {
    render(
      <Stream
        events={[
          ev(3, 'pages.planned', { count: 40 }),
          ev(1, 'site.opening', { domain: 'https://avivco.il' }),
          ev(2, 'platform.detected', { platform: 'shopify' }, 'found'),
        ]}
      />,
    );
    expect(lines()).toEqual(['Opening avivco.il', 'Found Shopify', '40 pages to read']);
  });

  it('★★ only the newest line is happening now; a progress line before it shows as done', () => {
    render(
      <Stream
        events={[
          ev(1, 'sitemap.reading'),
          ev(2, 'platform.detected', { platform: 'shopify' }, 'found'),
          ev(3, 'page.reading', { kind: 'returns' }),
        ]}
      />,
    );
    const rows = screen.getAllByTestId('scan-line');
    expect(rows.map((row) => row.getAttribute('data-state'))).toEqual(['done', 'done', 'now']);
    expect(rows.filter((row) => row.hasAttribute('data-going'))).toEqual([rows[2]]);
    // The finished progress step carries a check, not the breathing dot.
    expect(rows[0]!.querySelector('svg')).not.toBeNull();
    expect(rows[2]!.querySelector('svg')).toBeNull();
  });

  it('★ a job that stopped has nothing in progress: its last line is done too', () => {
    render(
      <Stream
        live={false}
        events={[ev(1, 'sitemap.reading'), ev(2, 'pages.read', { count: 3 })]}
      />,
    );
    const rows = screen.getAllByTestId('scan-line');
    expect(rows.at(-1)).toHaveAttribute('data-state', 'now');
    expect(rows.some((row) => row.hasAttribute('data-going'))).toBe(false);
  });

  it("★★ two events that say the same line are one line, in the first one's place", () => {
    render(
      <Stream
        events={[
          ev(1, 'page.reading', { kind: 'returns', path: 'https://avivco.il/a' }),
          ev(2, 'platform.detected', { platform: 'shopify' }, 'found'),
          ev(3, 'page.reading', { kind: 'returns', path: 'https://avivco.il/b' }),
          ev(4, 'page.reading', { kind: 'shipping' }),
        ]}
      />,
    );
    expect(lines()).toEqual([
      'Reading a page about returns',
      'Found Shopify',
      'Reading a page about shipping',
    ]);
  });

  it('★ the same seq twice is drawn once; lines that differ in words are kept', () => {
    render(
      <Stream
        events={[
          ev(1, 'pages.read', { count: 3 }),
          ev(1, 'pages.read', { count: 3 }),
          ev(2, 'pages.read', { count: 4 }),
        ]}
      />,
    );
    expect(lines()).toEqual(['Read 3 pages', 'Read 4 pages']);
  });

  it('★★ a repeat that arrives later never pulls the focus back up the stream', async () => {
    const first = [
      ev(1, 'page.reading', { kind: 'returns' }),
      ev(2, 'faq.found', { count: 2 }, 'found'),
    ];
    const { rerender } = render(<Stream events={first} />);
    rerender(<Stream events={[...first, ev(3, 'page.reading', { kind: 'returns' })]} />);
    await tick(REVEAL_MS * 3);
    expect(lines()).toEqual(['Reading a page about returns', 'Found 2 FAQs']);
    expect(screen.getAllByTestId('scan-line')[1]).toHaveAttribute('data-state', 'now');
  });

  it('collapseFeed: sorted by seq, first of each wording kept', () => {
    const row = (seq: number, says: string) => ({ event: ev(seq, 'pages.read'), says });
    expect(
      collapseFeed([row(4, 'c'), row(2, 'b'), row(1, 'a'), row(3, 'a'), row(2, 'x')]).map(
        (r) => `${r.event.seq}${r.says}`,
      ),
    ).toEqual(['1a', '2b', '4c']);
  });

  it('★★ the first render draws the history whole; what arrives after enters one line at a time', async () => {
    const first = [ev(1, 'site.opening', { domain: 'https://avivco.il' })];
    const { rerender } = render(<Stream events={first} />);
    expect(lines()).toHaveLength(1);
    rerender(
      <Stream
        events={[
          ...first,
          ev(2, 'platform.detected', { platform: 'shopify' }, 'found'),
          ev(3, 'sitemap.reading'),
          ev(4, 'pages.planned', { count: 40 }),
        ]}
      />,
    );
    // Three arrived in one poll: none is drawn at once.
    expect(lines()).toHaveLength(1);
    await tick(REVEAL_MS);
    expect(lines()).toEqual(['Opening avivco.il', 'Found Shopify']);
    await tick(REVEAL_MS);
    expect(lines()).toHaveLength(3);
    await tick(REVEAL_MS);
    expect(lines()).toHaveLength(4);
    expect(screen.getAllByTestId('scan-line')[3]).toHaveAttribute('data-state', 'now');
  });

  it('★ a long backlog enters faster, so the stream never lags far behind the job', async () => {
    const first = [ev(1, 'site.opening', { domain: 'https://avivco.il' })];
    const { rerender } = render(<Stream events={first} />);
    const more = Array.from({ length: REVEAL_BACKLOG + 3 }, (_, i) =>
      ev(i + 2, 'pages.read', { count: i + 1 }),
    );
    rerender(<Stream events={[...first, ...more]} />);
    await tick(REVEAL_FAST_MS);
    expect(lines()).toHaveLength(2);
  });

  it('★ the job stopped: everything waiting is drawn at once, "done" never waits on the stream', () => {
    const first = [ev(1, 'site.opening', { domain: 'https://avivco.il' })];
    const { rerender } = render(<Stream events={first} />);
    const all = [...first, ev(2, 'sitemap.reading'), ev(3, 'job.done')];
    rerender(<Stream events={all} live={false} />);
    expect(lines()).toHaveLength(3);
  });
});

describe('★★ the step column: one sentence per step, never an object', () => {
  // reading.lead was an object of states while the shell rendered it as one
  // string: the column showed next-intl's fallback on every read (fixed 2026-10-23).
  it.each(SHELL_STEPS.flatMap((step) => (['en', 'he'] as const).map((l) => [step, l] as const)))(
    '%s in %s: headline, lead and foot are strings',
    (step, locale) => {
      const catalogue = (locale === 'he' ? onboardingHe : onboardingEn) as unknown as Record<
        string,
        Record<string, unknown>
      >;
      for (const field of ['headline', 'lead', 'foot']) {
        expect(typeof catalogue[step]?.[field]).toBe('string');
      }
    },
  );
});

describe('★★ found so far', () => {
  const chips = (found: object, locale: 'en' | 'he' = 'en') =>
    render(
      <NextIntlClientProvider
        locale={locale}
        messages={{ onboarding: locale === 'he' ? onboardingHe : onboardingEn }}
      >
        <ScanChips found={jobFoundSchema.parse(found)} />
      </NextIntlClientProvider>,
    );

  it('every chip from `found`, in order', () => {
    chips({
      platform: 'shopify',
      productCount: 34,
      policies: ['returns', 'shipping'],
      faqCount: 6,
      contact: true,
      hours: true,
      brand: true,
      tools: ['returngo'],
    });
    expect(screen.getAllByRole('listitem').map((li) => li.getAttribute('data-testid'))).toEqual([
      'scan-chip-platform',
      'scan-chip-products',
      'scan-chip-policy-returns',
      'scan-chip-policy-shipping',
      'scan-chip-faq',
      'scan-chip-contact',
      'scan-chip-hours',
      'scan-chip-brand',
      'scan-chip-tool-returngo',
    ]);
  });

  it('★★ sampled products say "sampled", never a catalogue size', () => {
    chips({ productCount: 0, productsSampled: 6 });
    expect(screen.getByTestId('scan-chip-sampled')).toHaveTextContent('6 products sampled');
    expect(screen.queryByTestId('scan-chip-products')).toBeNull();
  });

  it('nothing yet: said, not an empty row', () => {
    chips({});
    expect(screen.getByTestId('scan-found')).toHaveTextContent('Nothing found yet.');
  });

  it('Hebrew', () => {
    chips({ productCount: 1, faqCount: 2 }, 'he');
    expect(screen.getByTestId('scan-chip-products')).toHaveTextContent('מוצר אחד');
    expect(screen.getByTestId('scan-chip-faq')).toHaveTextContent('2 שאלות נפוצות');
  });
});
