'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useState, useTransition, type ReactNode } from 'react';

import { channelName, type InboxMessage } from '@/api/contracts/inbox';
import { ChannelPlate } from '@/design-system/brand/channel-plate';
import { UserText } from '@/design-system/primitives/text/UserText';

import type { WallConversation, WallHistory } from './load-wall';
import { conversationMessages } from './wall-actions';
import { historyChannels } from './wall-model';
import styles from './Wall.module.css';
import { SkeletonBubbles } from '@/design-system/primitives/skeleton/Skeleton';

type Level =
  | { readonly at: 'wall' }
  | { readonly at: 'list' }
  | { readonly at: 'summary'; readonly conversation: WallConversation }
  | { readonly at: 'whole'; readonly conversation: WallConversation };

type Messages =
  { readonly ok: true; readonly messages: readonly InboxMessage[] } | { readonly ok: false };

/**
 * The wall's scrolling body, and the history that covers it.
 *
 * 02 draws "History across all channels ›" as the body's last row; Omer's
 * description says what the › opens - three levels over the column, each
 * with "‹ Back":
 *
 *   1  the person's conversations: channel, date, its one-line summary
 *   2  one conversation's summary, and "Open the whole conversation"
 *   3  the whole conversation, to read - nothing here answers it
 *
 * Levels 1 and 2 are one read (Backend ed8f3e1f): each conversation comes
 * with its stored summary, so opening one asks nothing. Level 3 reads the
 * messages, once per conversation per visit.
 */
export function WallBody({
  history,
  why,
  showHistory = true,
  children,
}: {
  /** `null`: we could not read it, or had no person to read it for. */
  readonly history: WallHistory | null;
  /** The title on a "-" row: which of those two it was. */
  readonly why: string;
  /** No row at all - an unidentified visitor has no history to open yet. */
  readonly showHistory?: boolean;
  readonly children: ReactNode;
}) {
  const t = useTranslations('inbox.wall.history');
  const [level, setLevel] = useState<Level>({ at: 'wall' });
  const [wholes, setWholes] = useState<ReadonlyMap<string, Messages>>(new Map());
  const [isPending, startTransition] = useTransition();

  const openWhole = (conversation: WallConversation) => {
    setLevel({ at: 'whole', conversation });
    if (wholes.has(conversation.id)) return;
    startTransition(async () => {
      const read = await conversationMessages(conversation.id);
      setWholes((m) => new Map(m).set(conversation.id, read));
    });
  };

  /*
   * In the drill, Esc is Back (Omer, 2026-10-06), one level at a time - and
   * taken first, so the inbox's Esc does not also close the conversation.
   * On `document`, which the event reaches before the inbox's `window`.
   */
  useEffect(() => {
    if (level.at === 'wall') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      setLevel((now) =>
        now.at === 'whole'
          ? { at: 'summary', conversation: now.conversation }
          : now.at === 'summary'
            ? { at: 'list' }
            : { at: 'wall' },
      );
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [level.at]);

  if (!showHistory) return <>{children}</>;

  if (level.at === 'wall') {
    const usable = history !== null && history.conversations.length > 0;
    return (
      <>
        {children}
        <button
          type="button"
          className={styles.historyRow}
          disabled={!usable}
          title={usable ? undefined : history === null ? why : t('none')}
          onClick={() => setLevel({ at: 'list' })}
          data-testid="wall-history"
        >
          <span className={styles.historyText}>
            <span>{t('title')}</span>
            <span className={styles.meta} data-testid="wall-history-line">
              {history === null ? '-' : <HistoryLine history={history} />}
            </span>
          </span>
          <span className={styles.chevron} aria-hidden="true">
            ›
          </span>
        </button>
      </>
    );
  }

  const back =
    level.at === 'list'
      ? () => setLevel({ at: 'wall' })
      : level.at === 'summary'
        ? () => setLevel({ at: 'list' })
        : () => setLevel({ at: 'summary', conversation: level.conversation });

  return (
    <div className={styles.drill} data-testid="wall-drill" data-level={level.at}>
      <button type="button" className={styles.back} onClick={back} data-testid="wall-back">
        {t('back')}
      </button>

      {level.at === 'list' ? (
        <>
          <h3 className={styles.blockTitle}>{t('title')}</h3>
          <ul className={styles.historyList}>
            {(history?.conversations ?? []).map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className={styles.historyItem}
                  data-current={c.isCurrent ? 'yes' : 'no'}
                  onClick={() => setLevel({ at: 'summary', conversation: c })}
                  data-testid={`wall-history-${c.id}`}
                >
                  <ConversationFacts conversation={c} oneLine />
                </button>
              </li>
            ))}
          </ul>
          {history && history.total > history.conversations.length ? (
            <p className={styles.note} data-testid="wall-history-more">
              {t('more', { shown: history.conversations.length, total: history.total })}
            </p>
          ) : null}
        </>
      ) : level.at === 'summary' ? (
        <>
          <ConversationFacts conversation={level.conversation} oneLine={false} />
          <button
            type="button"
            className={styles.outlineButton}
            onClick={() => openWhole(level.conversation)}
            data-testid="wall-open-whole"
          >
            {t('openWhole')}
          </button>
        </>
      ) : (
        <>
          <ConversationFacts conversation={level.conversation} oneLine />
          <Whole read={wholes.get(level.conversation.id)} pending={isPending} />
        </>
      )}
    </div>
  );
}

/** "24 conversations · WhatsApp, Instagram, Email, 1 call". */
function HistoryLine({ history }: { readonly history: WallHistory }) {
  const t = useTranslations('inbox.wall.history');
  const channels = useTranslations('channels');
  const { written, calls } = historyChannels(history);
  const parts = [
    ...written.map((c) => channelName(c, channels) ?? channels('name.other')),
    ...(calls > 0 ? [t('calls', { count: calls })] : []),
  ];
  return (
    <>
      {t('count', { count: history.total })}
      {parts.length > 0 ? ` · ${parts.join(', ')}` : null}
    </>
  );
}

/** Channel mark, channel · date (· This one), then the summary - one line, or whole. */
function ConversationFacts({
  conversation,
  oneLine,
}: {
  readonly conversation: WallConversation;
  readonly oneLine: boolean;
}) {
  const t = useTranslations('inbox.wall.history');
  const channels = useTranslations('channels');
  const format = useFormatter();
  const at = conversation.lastAt ?? conversation.startedAt;
  return (
    <span className={styles.conversationFacts}>
      {/*
        ★★ THE BRAND'S OWN MARK (Omer, 2026-10-11), on a light plate: this is
        the dark wall, and Outlook's navy layer vanishes on it (1.02:1).
        Decorative: the channel's name is the first words beside it.
      */}
      <span className={styles.channelMark} data-testid={`wall-channel-${conversation.id}`}>
        <ChannelPlate channel={conversation.channel} size="md" decorative />
      </span>
      <span className={styles.historyText}>
        <span>
          {channelName(conversation.channel, channels) ?? channels('name.other')}
          {' · '}
          {at
            ? format.dateTime(new Date(at), { day: 'numeric', month: 'short', year: 'numeric' })
            : '-'}
          {conversation.isCurrent ? ` · ${t('thisOne')}` : null}
        </span>
        <span
          className={oneLine ? styles.summaryLine : styles.summary}
          data-testid={`wall-summary-${conversation.id}`}
        >
          {conversation.summary ? (
            <UserText>{conversation.summary}</UserText>
          ) : (
            // "No summary yet", never an empty line: the conversation is there.
            t('noSummary')
          )}
        </span>
      </span>
    </span>
  );
}

function Whole({
  read,
  pending,
}: {
  readonly read: Messages | undefined;
  readonly pending: boolean;
}) {
  const t = useTranslations('inbox.wall.history');
  const format = useFormatter();
  if (!read) {
    return pending ? (
      <SkeletonBubbles label={t('reading')} tone="light" count={3} testid="wall-history-skeleton" />
    ) : (
      <p className={styles.note}>-</p>
    );
  }
  if (!read.ok) {
    return (
      <p className={styles.note} data-testid="wall-whole-failed">
        {t('wholeFailed')}
      </p>
    );
  }
  return (
    <ol className={styles.whole} data-testid="wall-whole" aria-label={t('wholeLabel')}>
      {read.messages.map((m) => (
        <li key={m.id} className={styles.wholeMessage} data-direction={m.direction}>
          <span className={styles.meta}>
            {m.direction === 'INBOUND' ? t('customer') : t('yourSide')}
            {' · '}
            {format.dateTime(new Date(m.createdAt), {
              day: 'numeric',
              month: 'short',
              hour: 'numeric',
              minute: '2-digit',
              hourCycle: 'h23',
            })}
          </span>
          {m.body.trim() ? (
            <UserText className={styles.wholeBody}>{m.body}</UserText>
          ) : (
            <span className={styles.meta}>{t('attachment')}</span>
          )}
        </li>
      ))}
    </ol>
  );
}
