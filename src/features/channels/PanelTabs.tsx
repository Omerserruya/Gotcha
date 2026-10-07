'use client';

import { useRef, type KeyboardEvent } from 'react';

import { Link, useRouter } from '@/i18n/navigation';

import styles from './Channels.module.css';
import { WHATSAPP_TABS, type WhatsAppTab } from './whatsapp-tabs';

const hrefOf = (tab: WhatsAppTab) => ({
  pathname: '/settings/channels',
  query: tab === 'numbers' ? { panel: 'whatsapp' } : { panel: 'whatsapp', tab },
});

/**
 * 13b's tabs, real (Omer, 2026-10-07: they were text that did nothing).
 * A tablist: each tab a link that REPLACES `?tab=` (Back is not a walk
 * through tabs); ←/→ move between them, Home and End to the ends, and the
 * one focused is the one opened - the WAI tabs pattern with automatic
 * activation, since each tab's content is already the page's.
 */
export function PanelTabs({
  current,
  labels,
  label,
}: {
  readonly current: WhatsAppTab;
  readonly labels: Readonly<Record<WhatsAppTab, string>>;
  readonly label: string;
}) {
  const router = useRouter();
  const list = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = WHATSAPP_TABS.indexOf(current);
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    const step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }[event.key];
    const to =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? WHATSAPP_TABS.length - 1
          : step === undefined
            ? null
            : (at + step + WHATSAPP_TABS.length) % WHATSAPP_TABS.length;
    if (to === null) return;
    event.preventDefault();
    const tab = WHATSAPP_TABS[to]!;
    router.replace(hrefOf(tab), { scroll: false });
    list.current?.querySelector<HTMLElement>(`[data-tab="${tab}"]`)?.focus();
  };

  return (
    <div
      ref={list}
      role="tablist"
      aria-label={label}
      className={styles.panelTabs}
      onKeyDown={onKeyDown}
      data-testid="whatsapp-tabs"
    >
      {WHATSAPP_TABS.map((tab) => (
        <Link
          key={tab}
          href={hrefOf(tab)}
          replace
          scroll={false}
          role="tab"
          id={`whatsapp-tab-${tab}`}
          aria-selected={tab === current}
          aria-controls="whatsapp-tabpanel"
          tabIndex={tab === current ? 0 : -1}
          className={styles.panelTab}
          data-tab={tab}
          data-testid={`whatsapp-tab-${tab}`}
        >
          {labels[tab]}
        </Link>
      ))}
    </div>
  );
}
