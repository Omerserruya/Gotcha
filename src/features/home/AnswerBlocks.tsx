'use client';

import { useState, useTransition, type ReactNode } from 'react';

import { isApiError } from '@/api/client/api-error';
import { browserApi } from '@/api/client/browser-api';
import {
  sourceRecordsSchema,
  type AnswerBlock,
  type AnswerSource,
  type RecordItem,
} from '@/api/contracts/assistant-threads';
import { assistantEndpoints } from '@/api/endpoints/registry';
import { Link } from '@/i18n/navigation';
import { safeInternalPath } from '@/lib/safe-url';
import { logger } from '@/observability/logger';

import styles from './HomeConversation.module.css';
import { useTurnFormatter, useTurnTranslations } from './turn-words';

type Chart = Extract<AnswerBlock, { type: 'chart' }>;
type Breakdown = Extract<AnswerBlock, { type: 'breakdown' }>;
type RecordList = Extract<AnswerBlock, { type: 'record_list' }>;
type Record_ = Extract<AnswerBlock, { type: 'record' }>;

/** Where a block, a row or a source leads: the server's in-app path, or nothing. */
function InAppLink({
  path,
  className,
  children,
  testid,
}: {
  readonly path: string | null;
  readonly className?: string;
  readonly children: ReactNode;
  readonly testid?: string;
}) {
  const safe = safeInternalPath(path);
  if (!safe)
    return (
      <span className={className} data-testid={testid}>
        {children}
      </span>
    );
  return (
    <Link href={safe} className={className} data-testid={testid}>
      {children}
    </Link>
  );
}

/**
 * ★★ Stage 2 (design 01a; assistant-threads-v1 §9): the answer's work, drawn
 * from the SERVER's numbers - a chart, a breakdown, the rows behind a number,
 * one record. The model writes only the words around them; nothing here is
 * computed from the text, and every figure is the block's own.
 *
 * Each block says when it is not the whole story: counted from the first N
 * (`partial: capped`), part of what the store returned (`store_limit`), or
 * recorded for only some conversations (`coverage`) - never a distribution
 * over everything when it is not one.
 */
export function AnswerBlocks({
  blocks,
  threadId,
  messageId,
}: {
  readonly blocks: readonly AnswerBlock[];
  readonly threadId: string | null;
  readonly messageId: string | null;
}) {
  if (blocks.length === 0) return null;
  return (
    <div className={styles.blocks} data-testid="turn-blocks">
      {blocks.map((block) => (
        <section
          key={block.id}
          className={styles.block}
          data-type={block.type}
          data-testid={`block-${block.id}`}
        >
          {block.type === 'chart' ? (
            <ChartBlock block={block} />
          ) : block.type === 'breakdown' ? (
            <BreakdownBlock block={block} />
          ) : block.type === 'record_list' ? (
            <RecordListBlock block={block} threadId={threadId} messageId={messageId} />
          ) : (
            <RecordBlock block={block} />
          )}
          <BlockFoot block={block} />
        </section>
      ))}
    </div>
  );
}

function BlockFoot({ block }: { readonly block: AnswerBlock }) {
  const t = useTurnTranslations('home.conversation.blocks');
  const partial = block.partial;
  // "Recorded for 0 of 0" says nothing: coverage only when there was something to cover.
  const coverage = block.type === 'breakdown' && block.coverage?.of ? block.coverage : null;
  if (!partial && !coverage && !block.deepLink) return null;
  return (
    <div className={styles.blockFoot}>
      {coverage ? (
        <span className={styles.blockNote} data-testid={`block-${block.id}-coverage`}>
          {t('coverage', { covered: coverage.covered, of: coverage.of })}
        </span>
      ) : null}
      {partial ? (
        <span className={styles.blockNote} data-testid={`block-${block.id}-partial`}>
          {partial.reason === 'capped' ? t('capped', { cap: partial.cap }) : t('storeLimit')}
        </span>
      ) : null}
      {block.deepLink ? (
        <InAppLink
          path={block.deepLink}
          className={styles.blockOpen}
          testid={`block-${block.id}-open`}
        >
          {t('open')}
        </InAppLink>
      ) : null}
    </div>
  );
}

/** A value in its unit: a count, an amount in its currency, a percentage (0-100). */
function useValue() {
  const format = useTurnFormatter();
  return (value: number, unit: 'count' | 'currency' | 'percent', currency: string | null) =>
    unit === 'currency' && currency
      ? format.number(value, { style: 'currency', currency, maximumFractionDigits: 0 })
      : unit === 'percent'
        ? format.number(value / 100, { style: 'percent', maximumFractionDigits: 1 })
        : format.number(value);
}

function ChartBlock({ block }: { readonly block: Chart }) {
  const format = useTurnFormatter();
  const value = useValue();
  const series = block.series.slice(0, 3);
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  // Days in the interface language: a week by weekday's letter, longer by the date.
  const label = (x: string) =>
    block.x.kind === 'day'
      ? format.dateTime(new Date(`${x}T00:00:00Z`), {
          ...(block.x.values.length <= 7 ? { weekday: 'narrow' } : { day: 'numeric' }),
          timeZone: 'UTC',
        })
      : x;
  const full = (x: string) =>
    block.x.kind === 'day'
      ? format.dateTime(new Date(`${x}T00:00:00Z`), {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          timeZone: 'UTC',
        })
      : x;
  return (
    <>
      <div className={styles.blockHead}>
        <h3 className={styles.blockTitle} dir="auto">
          {block.title}
        </h3>
        {series.length > 1 ? (
          <span className={styles.legend}>
            {series.map((s, i) => (
              <span key={s.key} className={styles.legendItem} data-series={i} dir="auto">
                {s.label}
              </span>
            ))}
          </span>
        ) : null}
      </div>
      <ol className={styles.bars} aria-label={block.title}>
        {block.x.values.map((x, i) => (
          <li
            key={x}
            className={styles.barSlot}
            data-highlight={block.highlight.includes(x) ? '' : undefined}
            data-testid={`bar-${block.id}-${x}`}
          >
            <span className={styles.barGroup}>
              {series.map((s, si) => {
                const v = s.values[i] ?? 0;
                return (
                  <span
                    key={s.key}
                    className={styles.chartBar}
                    data-series={si}
                    style={{ blockSize: `${Math.max(2, (v / max) * 100)}%` }}
                    title={`${full(x)} · ${s.label}: ${value(v, block.unit, block.currency)}`}
                    aria-label={`${full(x)} · ${s.label}: ${value(v, block.unit, block.currency)}`}
                  />
                );
              })}
            </span>
            <span className={styles.barLabel} aria-hidden="true">
              {label(x)}
            </span>
          </li>
        ))}
      </ol>
    </>
  );
}

function BreakdownBlock({ block }: { readonly block: Breakdown }) {
  const value = useValue();
  const t = useTurnTranslations('home.conversation.blocks');
  // Nothing to break down (Backend: "Refunds by reason" with no refunds) - said, not an empty frame.
  if (block.items.length === 0 && !block.other) {
    return (
      <>
        <div className={styles.blockHead}>
          <h3 className={styles.blockTitle} dir="auto">
            {block.title}
          </h3>
        </div>
        <p className={styles.blockNote} data-testid={`block-${block.id}-none`}>
          {t('none')}
        </p>
      </>
    );
  }
  return (
    <>
      <div className={styles.blockHead}>
        <h3 className={styles.blockTitle} dir="auto">
          {block.title}
        </h3>
        {block.total !== null ? (
          <span className={styles.blockMeta}>
            {t('total', { total: value(block.total, block.unit, block.currency) })}
          </span>
        ) : null}
      </div>
      <ul className={styles.parts}>
        {block.items.map((item, i) => (
          <li key={item.key} className={styles.part} data-testid={`part-${block.id}-${item.key}`}>
            <span className={styles.partLine}>
              <bdi dir="auto" className={styles.partLabel}>
                {item.label}
              </bdi>
              <span className={styles.partValue}>
                {value(item.value, block.unit, block.currency)}
              </span>
            </span>
            {/* The bar is the share the server gave - never one worked out here. */}
            <span className={styles.partTrack} aria-hidden="true">
              <span
                className={styles.partFill}
                data-first={i === 0 ? '' : undefined}
                style={{ inlineSize: `${Math.min(100, Math.max(0, item.share * 100))}%` }}
              />
            </span>
          </li>
        ))}
        {block.other ? (
          <li className={styles.part} data-testid={`part-${block.id}-other`}>
            <span className={styles.partLine}>
              <span className={styles.partLabel}>{block.other.label}</span>
              <span className={styles.partValue}>
                {value(block.other.value, block.unit, block.currency)}
              </span>
            </span>
          </li>
        ) : null}
      </ul>
    </>
  );
}

/**
 * The rows behind a number: the first page with the answer, the rest from
 * the source's own list (re-run with the reader's CURRENT visibility).
 */
function RecordListBlock({
  block,
  threadId,
  messageId,
}: {
  readonly block: RecordList;
  readonly threadId: string | null;
  readonly messageId: string | null;
}) {
  const t = useTurnTranslations('home.conversation.blocks');
  const [rows, setRows] = useState<readonly RecordItem[]>(block.items);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [failed, setFailed] = useState<'gone' | 'failed' | null>(null);
  const [loading, start] = useTransition();
  // More to read: the answer said so, and the list has not said it ended.
  const more = cursor === undefined ? block.hasMore && block.sourceId !== null : cursor !== null;
  const canRead = threadId !== null && messageId !== null && block.sourceId !== null;

  const readMore = () =>
    start(async () => {
      setFailed(null);
      try {
        const page = await browserApi.get({
          endpoint: assistantEndpoints.sourceRecords(threadId!, messageId!, block.sourceId!),
          query: cursor ? { cursor } : {},
          payload: sourceRecordsSchema,
          raw: true,
        });
        // The first read starts the list again: it is the reader's visibility now.
        setRows((current) => (cursor === undefined ? page.data : [...current, ...page.data]));
        setCursor(page.nextCursor);
      } catch (cause) {
        logger.warn('assistant.source_records_failed', { cause });
        setFailed(isApiError(cause) && cause.status === 409 ? 'gone' : 'failed');
      }
    });

  return (
    <>
      <div className={styles.blockHead}>
        <h3 className={styles.blockTitle} dir="auto">
          {block.title}
        </h3>
        {block.total !== null ? (
          <span className={styles.blockMeta}>{t('rows', { count: block.total })}</span>
        ) : null}
      </div>
      <ul className={styles.records} data-testid={`records-${block.id}`}>
        {rows.map((row) => (
          <li key={row.id} className={styles.recordRow}>
            <InAppLink path={row.deepLink} className={styles.recordLink}>
              <bdi dir="auto" className={styles.recordTitle}>
                {row.title}
              </bdi>
              {row.subtitle ? (
                <bdi dir="auto" className={styles.recordSub}>
                  {row.subtitle}
                </bdi>
              ) : null}
            </InAppLink>
            {row.meta ? <span className={styles.recordMeta}>{row.meta}</span> : null}
          </li>
        ))}
      </ul>
      {more && canRead ? (
        <button
          type="button"
          className={styles.moreRows}
          disabled={loading}
          onClick={readMore}
          data-testid={`records-${block.id}-more`}
        >
          {loading ? t('reading') : cursor === undefined ? t('showAll') : t('showMore')}
        </button>
      ) : null}
      {failed ? (
        <p className={styles.problem} role="alert" data-testid={`records-${block.id}-failed`}>
          {t(failed === 'gone' ? 'storeGone' : 'readFailed')}
        </p>
      ) : null}
    </>
  );
}

function RecordBlock({ block }: { readonly block: Record_ }) {
  return (
    <>
      <div className={styles.blockHead}>
        <h3 className={styles.blockTitle}>
          <bdi dir="auto">{block.title}</bdi>
        </h3>
      </div>
      <dl className={styles.fields}>
        {block.fields.map((field) => (
          <div key={field.key} className={styles.field}>
            <dt>{field.label}</dt>
            <dd>
              <bdi dir="auto">{field.value}</bdi>
            </dd>
          </div>
        ))}
      </dl>
    </>
  );
}

/** 01a's chips under the answer: what it stands on, each to its list when it has one. */
export function SourceChips({ sources }: { readonly sources: readonly AnswerSource[] }) {
  const t = useTurnTranslations('home.conversation.blocks');
  if (sources.length === 0) return null;
  return (
    <ul className={styles.sources} aria-label={t('sources')} data-testid="turn-sources">
      {sources.map((source) => (
        <li key={source.id}>
          <SourceChip source={source} />
        </li>
      ))}
    </ul>
  );
}

export function SourceChip({
  source,
  inline = false,
}: {
  readonly source: AnswerSource;
  readonly inline?: boolean;
}) {
  return (
    <InAppLink
      path={source.deepLink}
      className={inline ? `${styles.source} ${styles.sourceInline}` : styles.source}
      testid={inline ? `cite-${source.id}` : `source-${source.id}`}
    >
      <span className={styles.sourceDot} aria-hidden="true" />
      <bdi dir="auto">{source.label}</bdi>
    </InAppLink>
  );
}
