'use client';

import { Phone, Search, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import type { Catalog, CatalogItem } from '@/api/contracts/automations';
import { Dialog, DialogContent } from '@/design-system/primitives/overlay/Dialog';
import { channelMark } from '@/features/inbox/channel-marks';

import styles from './StepSheet.module.css';

/** The catalogue's group order, as the design draws its four columns. */
const GROUPS = ['trigger', 'logic', 'send', 'do'] as const;

/** A node's key in our catalogue: `trigger:x` lives at `nodes.trigger.x`. */
export function nodeKey(type: string): string {
  return type.replace(':', '.');
}

/**
 * Search matches what people say - our name and line for the step, and the
 * route's synonyms ("buttons", "pdf", "wait") - never the node's id.
 */
export function matches(item: CatalogItem, words: readonly string[], query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  return [...words, ...item.synonyms].some((w) => w.toLowerCase().includes(q));
}

/**
 * 09e - Add a step (design 6): every node in one sheet, four columns -
 * Triggers, Logic, Send, Do. What cannot run on this path is dimmed and
 * says why (the route decides, path-aware: first step only, the channel,
 * no customer, the 24-hour window, no event source, not connected, coming
 * later). Each step shows where it works.
 */
export function StepSheet({
  catalog,
  context,
  onPick,
  onClose,
}: {
  /** `null`: unread. */
  readonly catalog: Catalog | null;
  /** "After 'Wait for reply' · this path is on WhatsApp", or the first step's line. */
  readonly context: string;
  readonly onPick: (item: CatalogItem) => void;
  readonly onClose: () => void;
}) {
  const t = useTranslations('automations');
  const [query, setQuery] = useState('');

  const groups = GROUPS.map((key) => ({
    key,
    items: catalog?.groups.find((g) => g.key === key)?.items ?? [],
  }));

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent
        title={t('sheet.title')}
        hideTitle
        aria-describedby="step-sheet-context"
        className={styles.sheet}
        data-testid="step-sheet"
      >
        <header className={styles.head}>
          <span className={styles.titles}>
            <span className={styles.title}>{t('sheet.title')}</span>
            <span className={styles.context} id="step-sheet-context">
              {context}
            </span>
          </span>
          <label className={styles.search}>
            <Search size={14} aria-hidden="true" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('sheet.search')}
              aria-label={t('sheet.searchLabel')}
              data-testid="step-search"
            />
          </label>
          <button
            type="button"
            className={styles.close}
            onClick={onClose}
            aria-label={t('sheet.close')}
            data-testid="step-sheet-close"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        {catalog === null ? (
          <p className={styles.unread} role="status" data-testid="step-sheet-unread">
            {t('sheet.unread')}
          </p>
        ) : (
          <div className={styles.columns}>
            {groups.map((group) => (
              <section
                key={group.key}
                className={styles.group}
                aria-labelledby={`group-${group.key}`}
              >
                <h3 className={styles.groupTitle} data-group={group.key} id={`group-${group.key}`}>
                  {t(`groups.${group.key}`)}
                  {group.key === 'trigger' ? (
                    <span className={styles.groupNote}>{t('sheet.firstStepOnly')}</span>
                  ) : null}
                </h3>
                <ul className={styles.items}>
                  {group.items
                    .filter((item) => {
                      const key = nodeKey(item.type);
                      return matches(
                        item,
                        [
                          t(`nodes.${key}` as 'nodes.wait'),
                          t(`lines.${key}` as 'lines.wait'),
                          item.label,
                          item.description,
                        ],
                        query,
                      );
                    })
                    .map((item) => {
                      const key = nodeKey(item.type);
                      const why = item.available
                        ? undefined
                        : t(`reasons.${item.reason ?? 'coming_later'}`);
                      return (
                        <li key={item.type}>
                          <button
                            type="button"
                            className={styles.item}
                            disabled={!item.available}
                            title={why}
                            onClick={() => onPick(item)}
                            data-testid={`step-${item.type}`}
                          >
                            <span className={styles.itemText}>
                              <span className={styles.itemName}>
                                {t(`nodes.${key}` as 'nodes.wait')}
                              </span>
                              <span className={styles.itemLine}>
                                {/* "First step only" is the column's own note; any other reason is the line. */}
                                {why && item.reason !== 'first_step_only'
                                  ? why
                                  : t(`lines.${key}` as 'lines.wait')}
                              </span>
                            </span>
                            <Channels channels={item.channels} />
                          </button>
                        </li>
                      );
                    })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Where a step works: the channels' marks, said in words for a screen reader. */
function Channels({ channels }: { readonly channels: readonly string[] }) {
  const t = useTranslations('automations');
  if (channels.length === 0) return null;
  const shown = [...new Set(channels.map((c) => (c === 'GMAIL' || c === 'OUTLOOK' ? 'EMAIL' : c)))];
  return (
    <span
      className={styles.channels}
      role="img"
      aria-label={shown.map((c) => t(`channels.${c}` as 'channels.WHATSAPP')).join(', ')}
    >
      {shown.slice(0, 5).map((channel) => {
        if (channel === 'VOICE') return <Phone key={channel} size={11} aria-hidden="true" />;
        const { Icon } = channelMark(channel);
        return <Icon key={channel} size={11} strokeWidth={1.75} />;
      })}
    </span>
  );
}
