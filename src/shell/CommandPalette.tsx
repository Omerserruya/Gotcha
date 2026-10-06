'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { channelName } from '@/api/contracts/inbox';
import { useRouter } from '@/i18n/navigation';
import { usePermissions } from '@/permissions/permissions-context';

import styles from './CommandPalette.module.css';
import { destinations, matching } from './command-palette-model';
import {
  searchConversations,
  searchPeople,
  type ActionHit,
  type ConversationHit,
  type OrderMiss,
  type PersonHit,
} from './command-search';
import { ltr } from '@/lib/bidi';

/** The rail's ⌘K button opens the palette by this event - its look unchanged. */
export const OPEN_COMMAND_PALETTE = 'gotcha:command-palette';

type Item = {
  readonly key: string;
  readonly group: 'do' | 'go' | 'ask';
  readonly label: string;
  readonly meta?: string;
  /** Absent: drawn, not live. */
  readonly href?: string;
  readonly title?: string;
  /** DO THIS: the action's state, 02's chip ("Needs approval"). */
  readonly chip?: string;
  /** What tells it apart from its neighbours - their last word, and when. Theirs: isolated. */
  readonly detail?: string;
};

/** The store's own name for its slug; any other, as sent. */
const STORE_NAMES: Readonly<Record<string, string>> = {
  woocommerce: 'WooCommerce',
  shopify: 'Shopify',
};

/**
 * 19, measured: ⌘K - a 720 dialog over any screen, at the studio overlays'
 * 72% scrim. One input; DO THIS, GO TO, ASK; a foot of keys.
 *
 *   GO TO   real: customers (the contacts search, and an order number's
 *           customer), conversations by name or channel id, and the screens
 *           the person may see.
 *   DO THIS only what can be acted on: an approval PENDING for a customer
 *           found - opening Approvals, where it is decided. Nothing is
 *           invented from the words; with none, no section.
 *   ASK     goes to Home with the question in its box - FILLED, never sent:
 *           sending runs the assistant.
 *
 * Opens on ⌘K / Ctrl K anywhere, and from the rail's button; Esc closes.
 */
export function CommandPalette() {
  const t = useTranslations('navigation');
  const tp = useTranslations('navigation.palette');
  const tch = useTranslations('channels');
  const router = useRouter();
  const locale = useLocale();
  const { canSee } = usePermissions();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [hits, setHits] = useState<readonly ConversationHit[]>([]);
  const [people, setPeople] = useState<readonly PersonHit[]>([]);
  const [actions, setActions] = useState<readonly ActionHit[]>([]);
  const [orderMiss, setOrderMiss] = useState<OrderMiss | null>(null);
  const [searchFailed, setSearchFailed] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  /** Closing forgets the question: the next ⌘K starts empty. */
  function reset() {
    setQuery('');
    setHits([]);
    setPeople([]);
    setActions([]);
    setOrderMiss(null);
    setSearchFailed(false);
    setActive(0);
  }
  function close() {
    reset();
    setOpen(false);
  }

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((was) => {
          if (was) reset();
          return !was;
        });
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_COMMAND_PALETTE, onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_COMMAND_PALETTE, onOpen);
    };
  }, []);

  // Conversations, after a pause in typing; a stale answer is dropped.
  useEffect(() => {
    if (!open || query.trim().length < 2) return;
    let current = true;
    const timer = setTimeout(() => {
      void Promise.all([searchConversations(query), searchPeople(query)]).then(
        ([conversations, found]) => {
          if (!current) return;
          setSearchFailed(!conversations.ok && !found.ok);
          setHits(conversations.ok ? conversations.hits : []);
          setPeople(found.ok ? found.people : []);
          setActions(found.ok ? found.actions : []);
          setOrderMiss(found.ok ? (found.orderMiss ?? null) : null);
        },
      );
    }, 200);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [open, query]);

  const screens = useMemo(
    () =>
      destinations(canSee).map((d) => ({
        key: `screen-${d.id}`,
        href: d.href,
        label: d.labelKeys.map((k) => t(k as 'primary.home')).join(' · '),
      })),
    [canSee, t],
  );

  const items: readonly Item[] = useMemo(() => {
    const typed = query.trim();
    const searchable = typed.length >= 2;
    const go: Item[] = [
      ...(searchable ? people : []).map((person) => ({
        key: `customer-${person.id}`,
        group: 'go' as const,
        label: person.byOrder
          ? tp('order', { number: person.byOrder.replace(/^#/, '') })
          : (person.name ?? ltr(person.handle) ?? tp('someone')),
        // A handle is an LTR island: a phone in a Hebrew line lays out backwards otherwise.
        meta: person.byOrder
          ? (person.name ?? ltr(person.handle) ?? tp('customer'))
          : [tp('customer'), ltr(person.handle)].filter(Boolean).join(' · '),
        href: `/customers/${encodeURIComponent(person.id)}`,
      })),
      ...(searchable ? hits : []).map((hit) => ({
        key: `conversation-${hit.id}`,
        group: 'go' as const,
        label: hit.name ?? ltr(hit.handle) ?? tp('someone'),
        meta: [
          hit.channel ? (channelName(hit.channel, tch) ?? tch('name.other')) : null,
          tp('conversation'),
        ]
          .filter(Boolean)
          .join(' · '),
        href: `/inbox?c=${encodeURIComponent(hit.id)}`,
        detail:
          [hit.lastWord, hit.lastAt ? shortWhen(hit.lastAt, locale) : null]
            .filter(Boolean)
            .join(' · ') || undefined,
      })),
      ...matching(screens, typed)
        .slice(0, typed ? 6 : 8)
        .map((s) => ({ key: s.key, group: 'go' as const, label: s.label, href: s.href })),
    ];
    if (!typed) return go;
    return [
      ...(searchable ? actions : []).map((action) => ({
        key: `approval-${action.id}`,
        group: 'do' as const,
        label: action.summary,
        chip: tp('needsApproval'),
        href: '/approvals',
      })),
      ...go,
      {
        key: 'ask',
        group: 'ask',
        label: typed,
        meta: tp('askMeta'),
        href: `/home?ask=${encodeURIComponent(typed)}`,
      },
    ];
  }, [actions, hits, locale, people, query, screens, tch, tp]);

  if (!open) return null;

  const live = items.filter((item) => item.href);
  const run = (item: Item | undefined) => {
    if (!item?.href) return;
    close();
    router.push(item.href);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((i) => Math.min(i + 1, live.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(live[active]);
    }
  };
  const activeKey = live[Math.min(active, live.length - 1)]?.key;

  return (
    <div className={styles.layer} data-testid="command-palette">
      <button
        type="button"
        className={styles.scrim}
        aria-label={tp('close')}
        tabIndex={-1}
        onClick={close}
      />
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={t('commandPalette')}
      >
        <div className={styles.head}>
          <span className={styles.dot} aria-hidden="true" />
          <input
            ref={input}
            autoFocus
            className={styles.input}
            value={query}
            placeholder={t('commandPalette')}
            aria-label={t('commandPalette')}
            data-testid="command-input"
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
          <span className={styles.esc}>{tp('esc')}</span>
        </div>

        <div className={styles.body}>
          {(['do', 'go', 'ask'] as const).map((group) => {
            const list = items.filter((item) => item.group === group);
            if (list.length === 0) return null;
            return (
              <section key={group} className={styles.group} data-testid={`command-group-${group}`}>
                <h2 className={styles.groupTitle}>{tp(`group.${group}`)}</h2>
                <ul className={styles.list}>
                  {list.map((item) => (
                    <li key={item.key}>
                      {item.href ? (
                        <button
                          type="button"
                          className={styles.item}
                          data-active={item.key === activeKey ? 'yes' : 'no'}
                          data-testid={`command-item-${item.key}`}
                          onMouseEnter={() => setActive(live.indexOf(item))}
                          onClick={() => run(item)}
                        >
                          <span className={styles.label}>
                            {item.group === 'ask'
                              ? tp('ask', { question: item.label })
                              : item.label}
                          </span>
                          {item.meta ? <span className={styles.meta}>{item.meta}</span> : null}
                          {item.detail ? (
                            <bdi dir="auto" className={styles.detail}>
                              {item.detail}
                            </bdi>
                          ) : null}
                          {item.chip ? <span className={styles.chip}>{item.chip}</span> : null}
                        </button>
                      ) : (
                        <span
                          className={styles.item}
                          aria-disabled="true"
                          title={item.title}
                          data-testid={`command-item-${item.key}`}
                        >
                          <span className={styles.label}>{item.label}</span>
                          <span className={styles.meta}>{item.meta}</span>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
          {/* An order number that found nobody: the search ran, and says where. */}
          {orderMiss && query.trim().length >= 2 ? (
            <p className={styles.note} data-testid="command-order-miss">
              {orderMiss.kind === 'no_store'
                ? tp('orderNoStore')
                : tp('orderNoMatch', {
                    number: orderMiss.number,
                    store: STORE_NAMES[orderMiss.source] ?? orderMiss.source,
                  })}
            </p>
          ) : null}
          {searchFailed && query.trim().length >= 2 ? (
            <p className={styles.note} data-testid="command-search-failed">
              {tp('searchFailed')}
            </p>
          ) : null}
        </div>

        <div className={styles.foot}>
          <span>{tp('keys')}</span>
          <span>{tp('everywhere')}</span>
        </div>
      </div>
    </div>
  );
}

/** "14:05" today, else "3 Oct" - day first, 24-hour. */
function shortWhen(iso: string, locale: string): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  if (at.toDateString() === new Date().toDateString()) {
    return new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(at);
  }
  const part = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, o).format(at);
  return `${part({ day: 'numeric' })} ${part({ month: 'short' })}`;
}
