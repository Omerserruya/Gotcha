'use client';

import { Check, ListFilter } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { ChannelPlate } from '@/design-system/brand/channel-plate';
import { Sheet, SheetContent, SheetTrigger } from '@/design-system/primitives/overlay/Dialog';
import type { FilterChip, QueueChannelFilter } from '@/features/inbox/inbox-views';
import { Link } from '@/i18n/navigation';

import styles from './mobile-inbox.module.css';

/**
 * The bar's filter: a sheet of the workspace's channels, as the design's
 * "סינון לפי ערוץ" - with a dot on the icon while one is in force.
 *
 * ★ ONE CHANNEL, NOT A SET. The design ticks several; the route matches one
 *   exact `channel` (`inbox-views.ts`), so the sheet is a choice of one and
 *   "All". Ticking three and getting one would be worse than choosing one.
 */
export function MobileChannelFilter({
  chips,
  current,
  names,
  keep,
}: {
  readonly chips: readonly FilterChip[];
  readonly current: QueueChannelFilter | null;
  /** Each channel's name, already translated. */
  readonly names: Readonly<Partial<Record<QueueChannelFilter, string>>>;
  /** The view and search in force, carried into the new address. */
  readonly keep: Readonly<Record<string, string>>;
}) {
  const t = useTranslations('mobile.inbox.filter');
  const [open, setOpen] = useState(false);

  const option = (channel: QueueChannelFilter | null, label: string, mark: string | null) => (
    <li key={channel ?? 'all'}>
      <Link
        href={{ pathname: '/m/inbox', query: { ...keep, ...(channel === null ? {} : { channel }) } }}
        replace
        className={styles.filterRow}
        aria-current={channel === current ? 'true' : undefined}
        data-testid={`mobile-filter-${channel ?? 'all'}`}
        onClick={() => setOpen(false)}
      >
        <span className={styles.filterMark}>
          {mark === null ? null : <ChannelPlate channel={mark} label={label} size="lg" />}
        </span>
        <span className={styles.filterName}>{label}</span>
        <span className={styles.filterBox} aria-hidden="true">
          {channel === current ? <Check size={15} strokeWidth={3} /> : null}
        </span>
      </Link>
    </li>
  );

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          className={styles.barIcon}
          aria-label={t('open')}
          data-testid="mobile-inbox-filter"
        >
          <ListFilter aria-hidden size={23} strokeWidth={2} />
          {current === null ? null : <span className={styles.barDot} aria-hidden="true" />}
        </button>
      </SheetTrigger>
      <SheetContent title={t('title')}>
        <ul className={styles.filterList}>
          {option(null, t('all'), null)}
          {chips.map((chip) => option(chip.channel, names[chip.channel] ?? chip.channel, chip.mark))}
        </ul>
      </SheetContent>
    </Sheet>
  );
}
