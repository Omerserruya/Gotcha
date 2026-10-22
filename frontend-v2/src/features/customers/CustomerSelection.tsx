'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, useTransition, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { FACTS_BATCH, TAG_MAX } from '@/api/contracts/customer-facts';
import { Link, useRouter } from '@/i18n/navigation';
import { typedDir } from '@/lib/typed-dir';

import { tagCustomers, type TagResult } from './tag-actions';

import styles from './Customers.module.css';

/**
 * 04's "shift-click to pick several, then message or tag them". A plain click
 * still opens the person; shift, ⌘ or Ctrl picks them instead. With a pick,
 * a bar: Message makes a campaign draft for exactly those people (nothing is
 * sent from here); Tag adds one tag to all of them (backend 01bb7b6e).
 */
export function CustomerSelection({ children }: { readonly children: ReactNode }) {
  const t = useTranslations('customers.select');
  const area = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState<ReadonlyMap<string, readonly string[]>>(new Map());

  /* The list's foot - the bar stands in its place, inside the card. */
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
      <TagPicked contactIds={contactIds} onDone={() => setPicked(new Map())} />
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

/** "Tag": a small field and Add - one tag on everyone picked, all or nothing. */
function TagPicked({
  contactIds,
  onDone,
}: {
  readonly contactIds: readonly string[];
  readonly onDone: () => void;
}) {
  const t = useTranslations('customers.select');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [tag, setTag] = useState('');
  const [result, setResult] = useState<TagResult | null>(null);
  const [isPending, startTransition] = useTransition();
  const tooMany = new Set(contactIds).size > FACTS_BATCH;

  if (!open) {
    return (
      <button
        type="button"
        className={styles.selectSecondary}
        disabled={tooMany}
        title={tooMany ? t('tagTooMany', { max: FACTS_BATCH }) : undefined}
        data-testid="select-tag"
        onClick={() => {
          setResult(null);
          setOpen(true);
        }}
      >
        {t('tag')}
      </button>
    );
  }
  const name = tag.trim();
  return (
    <form
      className={styles.selectTag}
      data-testid="select-tag-form"
      onSubmit={(event) => {
        event.preventDefault();
        startTransition(async () => {
          const done = await tagCustomers(contactIds, name);
          setResult(done);
          if (done.ok) {
            setTag('');
            setOpen(false);
            onDone();
            router.refresh();
          }
        });
      }}
    >
      <label className="srOnly" htmlFor="select-tag-name">
        {t('tagLabel')}
      </label>
      <input
        id="select-tag-name"
        className={styles.selectTagInput}
        value={tag}
        maxLength={TAG_MAX}
        autoFocus
        dir={typedDir(tag)}
        placeholder={t('tagPlaceholder')}
        data-testid="select-tag-name"
        onChange={(event) => setTag(event.target.value)}
      />
      <button
        type="submit"
        className={styles.selectPrimary}
        disabled={isPending || name.length === 0}
        data-testid="select-tag-add"
      >
        {isPending ? t('tagAdding') : t('tagAdd')}
      </button>
      <button type="button" className={styles.selectClear} onClick={() => setOpen(false)}>
        {t('tagCancel')}
      </button>
      {result && !result.ok ? (
        <span role="alert" data-testid="select-tag-problem">
          {t(`tagRefused.${result.reason}`, { max: FACTS_BATCH })}
        </span>
      ) : null}
    </form>
  );
}
