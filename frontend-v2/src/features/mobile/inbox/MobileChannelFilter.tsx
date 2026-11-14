'use client';

import { Check, ListFilter } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { ChannelPlate } from '@/design-system/brand/channel-plate';
import { Sheet, SheetContent, SheetTrigger } from '@/design-system/primitives/overlay/Dialog';
import type { FilterChip, QueueChannelFilter } from '@/features/inbox/inbox-views';
import { useRouter } from '@/i18n/navigation';

import ui from '../mobile-ui.module.css';
import styles from './mobile-inbox.module.css';
import { toggleChannel } from './channel-selection';

/**
 * The bar's filter: a sheet of the workspace's channels, as the design's
 * "סינון לפי ערוץ" - with a dot on the icon while any is in force.
 *
 * ★ SEVERAL, AS THE DESIGN TICKS THEM (2026-11-03). The route now takes a
 *   list (`channel=a,b`, conversation `lib/channel-filter.ts`), so a tick is
 *   a tick: rows toggle in the sheet, "הצג" applies them to the address and
 *   "נקה" clears the ticks (then "הצג" is every channel). Nothing changes
 *   under the sheet until "הצג": one read for one decision.
 */
export function MobileChannelFilter({
  chips,
  current,
  names,
  keep,
}: {
  readonly chips: readonly FilterChip[];
  readonly current: readonly QueueChannelFilter[];
  /** Each channel's name, already translated. */
  readonly names: Readonly<Partial<Record<QueueChannelFilter, string>>>;
  /** The view and search in force, carried into the new address. */
  readonly keep: Readonly<Record<string, string>>;
}) {
  const t = useTranslations('mobile.inbox.filter');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<readonly QueueChannelFilter[]>(current);
  const order = chips.map((chip) => chip.channel);

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        // Every opening starts from what the list shows, not from an unapplied tick.
        if (next) setPicked(current);
        setOpen(next);
      }}
    >
      <SheetTrigger asChild>
        <button
          type="button"
          className={styles.barIcon}
          aria-label={t('open')}
          data-testid="mobile-inbox-filter"
        >
          <ListFilter aria-hidden size={23} strokeWidth={2} />
          {current.length === 0 ? null : <span className={styles.barDot} aria-hidden="true" />}
        </button>
      </SheetTrigger>
      <SheetContent title={t('title')}>
        <ul className={styles.filterList}>
          {chips.map((chip) => {
            const on = picked.includes(chip.channel);
            const label = names[chip.channel] ?? chip.channel;
            return (
              <li key={chip.channel}>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  className={styles.filterRow}
                  data-testid={`mobile-filter-${chip.channel}`}
                  onClick={() => setPicked((was) => toggleChannel(was, chip.channel, order))}
                >
                  <span className={styles.filterMark}>
                    <ChannelPlate channel={chip.mark} label={label} size="lg" />
                  </span>
                  <span className={styles.filterName}>{label}</span>
                  <span className={styles.filterBox} aria-hidden="true">
                    {on ? <Check size={15} strokeWidth={3} /> : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className={styles.filterActions}>
          <button
            type="button"
            className={ui.secondary}
            disabled={picked.length === 0}
            data-testid="mobile-filter-clear"
            onClick={() => setPicked([])}
          >
            {t('clear')}
          </button>
          <button
            type="button"
            className={ui.primary}
            data-testid="mobile-filter-apply"
            onClick={() => {
              setOpen(false);
              router.replace({
                pathname: '/m/inbox',
                query: { ...keep, ...(picked.length === 0 ? {} : { channel: picked.join(',') }) },
              });
            }}
          >
            {t('apply')}
          </button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
