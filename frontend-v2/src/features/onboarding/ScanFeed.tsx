'use client';

import { Check, CircleAlert, Info } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

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

/** The same tags as plain text: a line's words, for telling two lines apart. */
const plainTags = { ltr: (chunks: string) => chunks, user: (chunks: string) => chunks };

/** A line, and what it says in words: two events that say the same are one line. */
export type FeedLine = { readonly text: ReactNode; readonly says: string };

/**
 * One feed line, in the screen's language, from a KEY and its params. Never
 * a raw URL: a page reading says what the page is ABOUT, not its path, and a
 * domain is shown as its host. `null`: a key this build does not know.
 */
export function useFeedLine(): (event: JobEvent) => FeedLine | null {
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
    return {
      text: t.rich(`feed.${event.key}`, { ...values, ...tags }),
      says: `${event.kind} ${t.markup(`feed.${event.key}`, { ...values, ...plainTags })}`,
    };
  };
}

/**
 * ★ The feed's order and its duplicates (Omer, 2026-10-24: "no jumping").
 * Lines in time order, by `seq`; an event already drawn (the same seq twice)
 * or one that says what an earlier line already says ("Reading a page about
 * returns", for the second returns page) is collapsed into that line. It
 * keeps the FIRST line's place: a repeat never moves a line, and never
 * pulls the focus back up the stream.
 */
export function collapseFeed<Row extends { readonly event: JobEvent; readonly says: string }>(
  rows: readonly Row[],
): Row[] {
  const seqs = new Set<number>();
  const said = new Set<string>();
  return [...rows]
    .sort((a, b) => a.event.seq - b.event.seq)
    .filter(({ event, says }) => {
      if (seqs.has(event.seq) || said.has(says)) return false;
      seqs.add(event.seq);
      said.add(says);
      return true;
    });
}

const MARK = {
  found: <Check size={13} aria-hidden="true" className={styles.feedCheck} />,
  warn: <Info size={13} aria-hidden="true" className={styles.feedGap} />,
  error: <CircleAlert size={13} aria-hidden="true" className={styles.feedGap} />,
  progress: <span aria-hidden="true" className={styles.feedDot} />,
  /* A step that is over: done, not still going. */
  passed: <Check size={13} aria-hidden="true" className={styles.feedPassed} />,
} as const;

/**
 * ★ One line at a time (Omer, 2026-10-24: "it jumps from item to item"). A
 * poll can bring several events at once; they wait their turn and enter one
 * every REVEAL_MS, so the stream moves at a reading pace, never in a jump.
 */
export const REVEAL_MS = 600;
/** More than this many waiting: they enter faster, so the feed never lags far behind the job. */
export const REVEAL_BACKLOG = 4;
export const REVEAL_FAST_MS = 250;

const reducedMotion = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * 00e's feed (Omer, 2026-10-24: "think Claude thinking mode"): a stream in
 * time order, oldest at the top. The newest line is the one happening NOW:
 * it is held in the middle of a fixed window, in focus, and the lines above
 * it are done and fade as they climb toward the edge.
 *
 * ★ Only the newest line can be in progress. Every line before it shows as
 *   over (its check or its info mark), so a finished step and the current
 *   one never read as both current. A job that is no longer `live` has no
 *   current step at all: its last line keeps the middle, but is done too.
 * ★ The first render (a reload) draws the whole history at once, already
 *   centred on its last line: no replay. A job that stops (`live` false)
 *   flushes what is waiting at once, so "done" never waits on the stream.
 * ★ aria-live on the list announces each line as it enters, and only that.
 * ★ Repeats are collapsed into the first line that said it (collapseFeed).
 */
export function ScanFeed({
  events,
  live = true,
}: {
  readonly events: readonly JobEvent[];
  /** The job is still going: the newest line is in progress, and new lines pace in. */
  readonly live?: boolean;
}) {
  const t = useTranslations('onboarding.scan');
  const line = useFeedLine();
  const rows = collapseFeed(
    events.flatMap((event) => {
      const said = line(event);
      return said === null ? [] : [{ event, ...said }];
    }),
  );

  // How many lines have entered. The first render: all of them.
  const [entered, setEntered] = useState(rows.length);
  // A job that stopped shows everything; a retry after it never takes lines back.
  if (!live && entered < rows.length) setEntered(rows.length);
  const shown = live ? Math.min(entered, rows.length) : rows.length;
  const waiting = rows.length - shown;
  useEffect(() => {
    if (waiting <= 0) return;
    const timer = setTimeout(
      () => setEntered(shown + 1),
      waiting > REVEAL_BACKLOG ? REVEAL_FAST_MS : REVEAL_MS,
    );
    return () => clearTimeout(timer);
  }, [shown, waiting]);

  // Hold the newest line in the middle of the window.
  const view = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  useLayoutEffect(() => {
    const box = view.current;
    const now = box?.querySelector<HTMLElement>('[data-state="now"]');
    if (!box || !now) return;
    const top = now.offsetTop + now.offsetHeight / 2 - box.clientHeight / 2;
    const instant = first.current || reducedMotion();
    first.current = false;
    if (typeof box.scrollTo === 'function') {
      box.scrollTo({ top: Math.max(0, top), behavior: instant ? 'auto' : 'smooth' });
    } else box.scrollTop = Math.max(0, top);
  }, [shown]);

  return (
    <section className={styles.feed} aria-label={t('feedLabel')} data-testid="scan-feed">
      <span className={styles.feedHead}>{t('feedLabel')}</span>
      <div className={styles.feedView} ref={view} data-testid="scan-view">
        <ul className={styles.feedRows} aria-live="polite" aria-relevant="additions">
          {rows.slice(0, shown).map(({ event, text }, index) => {
            const now = index === shown - 1;
            const mark =
              now && live
                ? MARK[event.kind]
                : event.kind === 'progress'
                  ? MARK.passed
                  : MARK[event.kind];
            return (
              <li
                key={event.seq}
                className={styles.feedRow}
                data-kind={event.kind}
                data-state={now ? 'now' : 'done'}
                data-going={now && live && event.kind === 'progress' ? '' : undefined}
                data-testid="scan-line"
              >
                <span className={styles.feedMark}>{mark}</span>
                <span className={styles.feedText}>{text}</span>
              </li>
            );
          })}
        </ul>
      </div>
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
