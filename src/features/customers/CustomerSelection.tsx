'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { Link } from '@/i18n/navigation';

import styles from './Customers.module.css';

/**
 * 04's "shift-click to pick several, then message or tag them". A plain click
 * still opens the person; shift, ⌘ or Ctrl picks them instead. With a pick,
 * a bar: Message makes a campaign draft for exactly those people (nothing is
 * sent from here); Tag is drawn — no route writes a contact's tags yet.
 */
export function CustomerSelection({ children }: { readonly children: ReactNode }) {
  const t = useTranslations('customers.select');
  const area = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState<ReadonlyMap<string, readonly string[]>>(new Map());

  /* The list's foot — the bar stands in its place, inside the card. */
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setSlot(area.current?.querySelector<HTMLElement>('[data-select-slot]') ?? null);
  }, []);

  // The rows are the server's; their picked state is drawn on them directly.
  useEffect(() => {
    for (const row of area.current?.querySelectorAll<HTMLElement>('[data-person]') ?? []) {
      if (picked.has(row.dataset.person!)) row.dataset.selected = 'yes';
      else delete row.dataset.selected;
    }
    const foot = area.current?.querySelector<HTMLElement>('[data-select-slot]');
    if (foot) {
      if (picked.size > 0) foot.dataset.picking = 'yes';
      else delete foot.dataset.picking;
    }
  }, [picked]);

  const onClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    if (!(event.shiftKey || event.metaKey || event.ctrlKey)) return;
    const row = (event.target as Element).closest<HTMLElement>('[data-person]');
    if (!row) return;
    event.preventDefault();
    event.stopPropagation();
    const key = row.dataset.person!;
    const ids = (row.dataset.contacts ?? '').split(',').filter(Boolean);
    setPicked((now) => {
      const next = new Map(now);
      if (next.has(key)) next.delete(key);
      else next.set(key, ids);
      return next;
    });
  };

  const contactIds = [...picked.values()].flat();
  const bar = (
    <div
      className={styles.selectBar}
      role="region"
      aria-label={t('label')}
      data-testid="select-bar"
    >
      <span>{t('count', { count: picked.size })}</span>
      <Link
        href={{
          pathname: '/outreach',
          query: { create: 'campaign', contacts: contactIds.join(',') },
        }}
        className={styles.selectPrimary}
        data-testid="select-message"
      >
        {t('message')}
      </Link>
      <span
        className={styles.selectDrawn}
        aria-disabled="true"
        title={t('tagNotYet')}
        data-testid="select-tag"
      >
        {t('tag')}
      </span>
      <button
        type="button"
        className={styles.selectClear}
        data-testid="select-clear"
        onClick={() => setPicked(new Map())}
      >
        {t('clear')}
      </button>
    </div>
  );
  return (
    <div ref={area} className={styles.selectArea} onClickCapture={onClickCapture}>
      {children}
      {picked.size > 0 ? (slot ? createPortal(bar, slot) : bar) : null}
    </div>
  );
}
