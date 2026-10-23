import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';

import { ONBOARDING_STEPS } from '@/api/contracts/onboarding';
import { jobEventSchema, jobFoundSchema } from '@/api/contracts/onboarding-v2';
import onboardingEn from '@/i18n/messages/en/onboarding.json';
import onboardingHe from '@/i18n/messages/he/onboarding.json';

import { FEED_KEYS, FEED_SHOWN, ScanChips, ScanFeed } from './ScanFeed';

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

  it('★ the feed shows the newest lines only, newest first', () => {
    const events = Array.from({ length: FEED_SHOWN + 3 }, (_, i) =>
      jobEventSchema.parse({
        seq: i + 1,
        at: '',
        stage: null,
        kind: 'progress',
        key: 'pages.read',
        params: { count: i + 1 },
      }),
    );
    render(
      <NextIntlClientProvider locale="en" messages={{ onboarding: onboardingEn }}>
        <ScanFeed events={events} />
      </NextIntlClientProvider>,
    );
    const shown = screen.getAllByTestId('scan-line');
    expect(shown).toHaveLength(FEED_SHOWN);
    expect(shown[0]).toHaveTextContent(`Read ${FEED_SHOWN + 3} pages`);
  });
});

describe('★★ the step column: one sentence per step, never an object', () => {
  // reading.lead was an object of states while the shell rendered it as one
  // string: the column showed next-intl's fallback on every read (fixed 2026-10-23).
  it.each(
    ONBOARDING_STEPS.flatMap((step) => (['en', 'he'] as const).map((l) => [step, l] as const)),
  )('%s in %s: headline, lead and foot are strings', (step, locale) => {
    const catalogue = (locale === 'he' ? onboardingHe : onboardingEn) as unknown as Record<
      string,
      Record<string, unknown>
    >;
    for (const field of ['headline', 'lead', 'foot']) {
      expect(typeof catalogue[step]?.[field]).toBe('string');
    }
  });
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
