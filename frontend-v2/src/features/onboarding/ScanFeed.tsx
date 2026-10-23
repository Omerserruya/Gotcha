'use client';

import { Check, CircleAlert, Info } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

import { siteHost } from '@/api/contracts/onboarding';
import type { JobEvent, JobFound } from '@/api/contracts/onboarding-v2';
import { plainDashes } from '@/lib/plain-dashes';

import styles from './Onboarding.module.css';

/**
 * Every feed key Backend has named (feat/onboarding-v2, checkpoints 1 and 2).
 * A key not here is dropped from the feed, never shown raw; the test renders
 * each of these in both languages, so a key added to Backend's list without
 * its line fails CI rather than going quietly missing.
 */
export const FEED_KEYS = [
  'job.started',
  'job.done',
  'job.failed',
  'job.retrying',
  'site.opening',
  'site.unreadable',
  'site.blocked',
  'platform.detected',
  'platform.none',
  'products.reading',
  'products.found',
  'products.feed_unavailable',
  'products.sampled',
  'sitemap.reading',
  'pages.planned',
  'pages.read',
  'pages.blocked',
  'page.reading',
  'tool.detected',
  'extract.reading',
  'extract.none',
  'extract.failed',
  'extract.empty',
  'policy.found',
  'faq.found',
  'profile.found',
  'brand.found',
  'knowledge.written',
  'knowledge.write_failed',
  'integrations.suggested',
] as const;
const KNOWN: ReadonlySet<string> = new Set(FEED_KEYS);

/** Names the scan reports by slug. One it does not know is shown as sent, never renamed. */
const NAMES: Readonly<Record<string, string>> = {
  shopify: 'Shopify',
  woocommerce: 'WooCommerce',
  wix: 'Wix',
  magento: 'Magento',
  bigcommerce: 'BigCommerce',
  wordpress: 'WordPress',
  squarespace: 'Squarespace',
  konimbo: 'Konimbo',
  returngo: 'ReturnGO',
  klaviyo: 'Klaviyo',
  google_analytics: 'Google Analytics',
  meta_pixel: 'Meta Pixel',
};
export const nameOf = (slug: string) => NAMES[slug] ?? slug;

const PAGE_KINDS = [
  'policy',
  'returns',
  'shipping',
  'faq',
  'about',
  'contact',
  'help',
  'page',
  'product',
  'other',
];
const POLICY_KINDS = [
  'returns',
  'exchange',
  'shipping',
  'refund',
  'warranty',
  'terms',
  'privacy',
  'other',
];
const EXTRACT_KINDS = ['policies', 'faq', 'profile', 'brand'];
const known = (list: readonly string[], value: unknown, fallback: string) =>
  typeof value === 'string' && list.includes(value) ? value : fallback;
/** A site's own text, shortened for one line. */
const TITLE_MAX = 60;

const tags = {
  ltr: (chunks: ReactNode) => <bdi dir="ltr">{chunks}</bdi>,
  user: (chunks: ReactNode) => <bdi dir="auto">{chunks}</bdi>,
};

/**
 * One feed line, in the screen's language, from a KEY and its params. Never
 * a raw URL: a page reading says what the page is ABOUT, not its path, and a
 * domain is shown as its host. `null`: a key this build does not know.
 */
export function useFeedLine(): (event: JobEvent) => ReactNode | null {
  const t = useTranslations('onboarding.scan');
  return (event) => {
    if (!KNOWN.has(event.key)) return null;
    const p = event.params;
    const kind = (group: 'page' | 'policy' | 'extract') =>
      t(
        `kinds.${group}.${
          group === 'page'
            ? known(PAGE_KINDS, p.kind, 'other')
            : group === 'policy'
              ? known(POLICY_KINDS, p.kind, 'other')
              : known(EXTRACT_KINDS, p.kind, 'policies')
        }`,
      );
    const num = (value: unknown) => (typeof value === 'number' ? value : Number(value) || 0);
    const values: Record<string, string | number> = {
      domain: siteHost(String(p.domain ?? '')) ?? '',
      platform: nameOf(String(p.platform ?? '')),
      tool: nameOf(String(p.slug ?? '')),
      count: num(p.count),
      blocked: num(p.blocked),
      of: num(p.of),
      more: String(p.more === true),
      fromSitemap: String(p.fromSitemap !== false),
      reason: String(p.reason ?? 'other'),
      code: String(p.code ?? 'other'),
      title: plainDashes(String(p.title ?? '')).slice(0, TITLE_MAX),
    };
    if (event.key === 'page.reading') values.kind = kind('page');
    else if (event.key === 'policy.found') values.kind = kind('policy');
    else if (event.key.startsWith('extract.')) values.kind = kind('extract');
    return t.rich(`feed.${event.key}`, { ...values, ...tags });
  };
}

const MARK = {
  found: <Check size={13} aria-hidden="true" className={styles.feedCheck} />,
  warn: <Info size={13} aria-hidden="true" className={styles.feedGap} />,
  error: <CircleAlert size={13} aria-hidden="true" className={styles.feedGap} />,
  progress: <span aria-hidden="true" className={styles.feedDot} />,
} as const;

/** How many lines the feed shows: the newest, the rest fade out. */
export const FEED_SHOWN = 8;

/** The rolling feed: newest first, each line what is really happening. */
export function ScanFeed({ events }: { readonly events: readonly JobEvent[] }) {
  const t = useTranslations('onboarding.scan');
  const line = useFeedLine();
  const rows = [...events]
    .sort((a, b) => b.seq - a.seq)
    .flatMap((event) => {
      const text = line(event);
      return text === null ? [] : [{ event, text }];
    })
    .slice(0, FEED_SHOWN);

  return (
    <section className={styles.feed} aria-label={t('feedLabel')} data-testid="scan-feed">
      <ul className={styles.feedRows} aria-live="polite">
        {rows.map(({ event, text }, index) => (
          <li
            key={event.seq}
            className={styles.feedRow}
            data-kind={event.kind}
            data-age={index}
            data-testid="scan-line"
          >
            <span className={styles.feedMark}>{MARK[event.kind]}</span>
            <span className={styles.feedText}>{text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** "Found so far": drawn from the job's cumulative `found`, so a reload redraws them all. */
export function ScanChips({ found }: { readonly found: JobFound }) {
  const t = useTranslations('onboarding.scan');
  const chips: { readonly key: string; readonly text: ReactNode }[] = [
    ...(found.platform
      ? [{ key: 'platform', text: <bdi dir="ltr">{nameOf(found.platform)}</bdi> }]
      : []),
    ...(found.productCount > 0
      ? [{ key: 'products', text: t('chips.products', { count: found.productCount }) }]
      : found.productsSampled > 0
        ? [{ key: 'sampled', text: t('chips.productsSampled', { count: found.productsSampled }) }]
        : []),
    ...found.policies.map((kind) => ({
      key: `policy-${kind}`,
      text: t(`chips.policy.${known(POLICY_KINDS, kind, 'other')}`),
    })),
    ...(found.faqCount > 0
      ? [{ key: 'faq', text: t('chips.faq', { count: found.faqCount }) }]
      : []),
    ...(found.contact ? [{ key: 'contact', text: t('chips.contact') }] : []),
    ...(found.hours ? [{ key: 'hours', text: t('chips.hours') }] : []),
    ...(found.brand ? [{ key: 'brand', text: t('chips.brand') }] : []),
    ...found.tools.map((slug) => ({
      key: `tool-${slug}`,
      text: <bdi dir="ltr">{nameOf(slug)}</bdi>,
    })),
  ];

  return (
    <section className={styles.found} aria-label={t('found')} data-testid="scan-found">
      <span className={styles.feedHead}>{t('found')}</span>
      {chips.length === 0 ? (
        <p className={styles.feedQuiet}>{t('foundNothingYet')}</p>
      ) : (
        <ul className={styles.chips}>
          {chips.map((chip) => (
            <li key={chip.key} className={styles.chip} data-testid={`scan-chip-${chip.key}`}>
              {chip.text}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
