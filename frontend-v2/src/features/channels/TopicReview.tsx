'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState, useTransition } from 'react';

import {
  choiceMissing,
  choiceTooLong,
  initialChoice,
  itemAnswer,
  TOPICS_FIRST_PAGE,
  type ItemChoice,
} from '@/api/contracts/import-topics';
import { ANSWER_MAX_CHARS } from '@/api/contracts/knowledge-candidates';
import { UserText } from '@/design-system/primitives/text/UserText';
import { useRouter } from '@/i18n/navigation';
import { PERMISSIONS } from '@/permissions/catalogue';
import { usePermissions } from '@/permissions/permissions-context';

import channels from './Channels.module.css';
import styles from './TopicReview.module.css';
import { approveTopic, rejectTopic, type TopicRefusal } from './topic-actions';
import type { TopicItemView, TopicView } from './topic-view';

/**
 * 13f by topic (Omer, 2026-11-18). Each topic is approved in one action with
 * its few canonical answers; per item the reviewer picks between the
 * suggestion, any variants, and "אחר" (typed). An unresolved item ("מה נכון?")
 * starts with nothing picked and holds the topic's approve until it is.
 *
 * Optimistic per card: a press reads as done at once, and a refusal puts the
 * card back with the reason under it (role=alert, no toast). A partial
 * approve keeps the card open with the items that did not save marked.
 *
 * Rejecting a topic of 3 or more pending questions asks first, inside the
 * card (Omer, 2026-11-18: one press threw away 30 questions from 254 chats);
 * under 3 it goes at once. What was rejected is listed, read-only, under
 * "נדחו" - the design's Rejected tab, per topic.
 */
export function TopicReview({
  importId,
  pending,
  auto,
  rejected = [],
  progress,
}: {
  readonly importId: string;
  /** Pending topics, most-asked first (`pendingByOccurrences`). */
  readonly pending: readonly TopicView[];
  readonly auto: readonly TopicView[];
  /** Rejected topics, most-asked first: shown, never acted on. */
  readonly rejected?: readonly TopicView[];
  readonly progress: { readonly total: number; readonly done: number } | null;
}) {
  const t = useTranslations('channels.whatsapp.topics');
  const { canSee } = usePermissions();
  const canWrite = canSee(PERMISSIONS.ai.knowledge.write);
  const [all, setAll] = useState(false);
  const shown = all ? pending : pending.slice(0, TOPICS_FIRST_PAGE);
  const more = pending.length - shown.length;

  return (
    <section className={styles.review} data-testid="topic-review">
      {progress && progress.total > 0 ? (
        <p className={styles.progress} data-testid="topic-progress">
          {t('progress', { done: progress.done, total: progress.total })}
        </p>
      ) : null}
      {canWrite ? null : (
        <p className={styles.readOnly} data-testid="topic-read-only">
          {t('readOnly')}
        </p>
      )}

      {pending.length === 0 ? (
        <p className={styles.allDone} data-testid="topic-all-done">
          {t('allDone')}
        </p>
      ) : (
        <ul className={styles.topics}>
          {shown.map((topic) => (
            <TopicCard key={topic.topicId} importId={importId} topic={topic} canWrite={canWrite} />
          ))}
        </ul>
      )}
      {more > 0 ? (
        <button
          type="button"
          className={styles.more}
          data-testid="topic-more"
          onClick={() => setAll(true)}
        >
          {t('showMore', { count: more })}
        </button>
      ) : null}

      {auto.length > 0 ? <AutoAdded importId={importId} topics={auto} canWrite={canWrite} /> : null}
      {rejected.length > 0 ? <Rejected topics={rejected} /> : null}
    </section>
  );
}

type Phase = 'open' | 'approved' | 'rejected';

/** From this many pending questions, "דחיית הנושא" asks first (Omer, 2026-11-18). */
export const REJECT_CONFIRM_FROM = 3;

function TopicCard({
  importId,
  topic,
  canWrite,
}: {
  readonly importId: string;
  readonly topic: TopicView;
  readonly canWrite: boolean;
}) {
  const t = useTranslations('channels.whatsapp.topics');
  const router = useRouter();
  const id = useId();
  const open = topic.items.filter((item) => item.status === 'pending');
  const [choices, setChoices] = useState<Record<string, ItemChoice | null>>(() =>
    Object.fromEntries(open.map((item) => [item.candidateId, initialChoice(item)])),
  );
  const [phase, setPhase] = useState<Phase>('open');
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const [saved, setSaved] = useState<ReadonlySet<string>>(new Set());
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, startBusy] = useTransition();
  const rejectButton = useRef<HTMLButtonElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  // Asking first lands on the safe answer, "ביטול".
  useEffect(() => {
    if (confirming) backButton.current?.focus();
  }, [confirming]);
  // "ביטול" and Escape alike: back where the reader was, on "דחיית הנושא".
  const cancelConfirm = () => {
    setConfirming(false);
    requestAnimationFrame(() => rejectButton.current?.focus());
  };

  const waiting = open.filter((item) => !saved.has(item.candidateId));
  const left = waiting.filter((item) => choiceMissing(choices[item.candidateId] ?? null)).length;
  const tooLong = waiting.some((item) => choiceTooLong(choices[item.candidateId] ?? null));

  const refusal = (reason: TopicRefusal) => {
    if (reason === 'stale') {
      setProblem(t('refreshed'));
      router.refresh();
    } else {
      setProblem(t(`refused.${reason}`));
    }
  };

  const approve = () => {
    const items = waiting.flatMap((item) => {
      const sent = itemAnswer(item, choices[item.candidateId] ?? null);
      return sent ? [sent] : [];
    });
    setProblem(null);
    setFailed(new Set());
    setPhase('approved');
    startBusy(async () => {
      const result = await approveTopic(importId, topic.topicId, items);
      if (!result.ok) {
        setPhase('open');
        refusal(result.reason);
        return;
      }
      if (result.failed.length > 0) {
        setPhase('open');
        setFailed(new Set(result.failed));
        setSaved(new Set([...saved, ...result.approved]));
        setProblem(t('partial', { count: result.failed.length }));
      }
      router.refresh();
    });
  };

  const reject = () => {
    setProblem(null);
    setConfirming(false);
    setPhase('rejected');
    startBusy(async () => {
      const result = await rejectTopic(importId, topic.topicId);
      if (!result.ok) {
        setPhase('open');
        refusal(result.reason);
        return;
      }
      router.refresh();
    });
  };

  const headingId = `${id}-label`;
  const leftId = `${id}-left`;
  const decided = phase !== 'open';

  return (
    <li
      className={styles.topic}
      aria-labelledby={headingId}
      data-phase={phase}
      data-testid={`topic-${topic.topicId}`}
    >
      <div className={styles.topicHead}>
        <h3 className={styles.topicLabel} id={headingId}>
          <UserText>{topic.label}</UserText>
        </h3>
        {topic.docConflict ? (
          <span
            className={channels.reportChip}
            data-tone="warn"
            data-testid={`topic-doc-conflict-${topic.topicId}`}
          >
            {t('docConflict')}
          </span>
        ) : null}
      </div>
      {topic.meta ? <p className={styles.topicMeta}>{topic.meta}</p> : null}

      <ul className={styles.items}>
        {topic.items.map((item) => (
          <TopicItem
            key={item.candidateId}
            topicId={topic.topicId}
            item={item}
            choice={choices[item.candidateId] ?? null}
            onChoose={(choice) => setChoices((all) => ({ ...all, [item.candidateId]: choice }))}
            editable={canWrite && !decided && !busy && !saved.has(item.candidateId)}
            mark={
              failed.has(item.candidateId) ? 'failed' : saved.has(item.candidateId) ? 'saved' : null
            }
          />
        ))}
      </ul>

      {phase === 'approved' ? (
        <p
          className={channels.reportDecided}
          role="status"
          data-testid={`topic-approved-${topic.topicId}`}
        >
          {t('approved')}
        </p>
      ) : phase === 'rejected' ? (
        <p
          className={channels.reportDecided}
          role="status"
          data-testid={`topic-rejected-${topic.topicId}`}
        >
          {t('rejected')}
        </p>
      ) : canWrite && confirming ? (
        <div
          className={styles.confirm}
          data-testid={`topic-reject-confirm-${topic.topicId}`}
          onKeyDown={(event) => {
            // Escape here cancels the question, never the drawer around it:
            // its listener on the document skips a prevented Escape. While
            // the reject is in flight it does neither.
            if (event.key !== 'Escape') return;
            event.preventDefault();
            if (!busy) cancelConfirm();
          }}
        >
          <p className={styles.confirmLine} id={`${id}-confirm`}>
            {topic.occurrences > 0
              ? t('rejectConfirm.lineChats', {
                  count: waiting.length,
                  conversations: topic.occurrences,
                })
              : t('rejectConfirm.line', { count: waiting.length })}
          </p>
          <div className={styles.actions}>
            <button
              type="button"
              className={channels.reportAction}
              data-tone="primary"
              disabled={busy}
              aria-describedby={`${id}-confirm`}
              data-testid={`topic-reject-yes-${topic.topicId}`}
              onClick={reject}
            >
              {t('rejectConfirm.yes')}
            </button>
            <button
              type="button"
              className={channels.reportAction}
              ref={backButton}
              disabled={busy}
              data-testid={`topic-reject-back-${topic.topicId}`}
              onClick={cancelConfirm}
            >
              {t('rejectConfirm.back')}
            </button>
          </div>
        </div>
      ) : canWrite ? (
        <div className={styles.actions}>
          <button
            type="button"
            className={channels.reportAction}
            data-tone="primary"
            disabled={busy || left > 0 || tooLong}
            aria-describedby={left > 0 || tooLong ? leftId : undefined}
            data-testid={`topic-approve-${topic.topicId}`}
            onClick={approve}
          >
            {t('approve')}
          </button>
          <button
            type="button"
            className={channels.reportAction}
            ref={rejectButton}
            disabled={busy}
            data-testid={`topic-reject-${topic.topicId}`}
            onClick={() => {
              if (waiting.length >= REJECT_CONFIRM_FROM) {
                setProblem(null);
                setConfirming(true);
              } else {
                reject();
              }
            }}
          >
            {t('reject')}
          </button>
          {left > 0 || tooLong ? (
            <span className={styles.left} id={leftId} data-testid={`topic-left-${topic.topicId}`}>
              {left > 0 ? t('left', { count: left }) : t('tooLong', { max: ANSWER_MAX_CHARS })}
            </span>
          ) : null}
        </div>
      ) : null}
      {problem ? (
        <p
          className={channels.reportProblem}
          role="alert"
          data-testid={`topic-problem-${topic.topicId}`}
        >
          {problem}
        </p>
      ) : null}
    </li>
  );
}

function TopicItem({
  topicId,
  item,
  choice,
  onChoose,
  editable,
  mark,
}: {
  readonly topicId: string;
  readonly item: TopicItemView;
  readonly choice: ItemChoice | null;
  readonly onChoose: (choice: ItemChoice) => void;
  readonly editable: boolean;
  readonly mark: 'failed' | 'saved' | null;
}) {
  const t = useTranslations('channels.whatsapp.topics');
  const id = useId();
  const focusNext = useRef(false);
  const name = `${id}-answer`;
  const other = choice?.kind === 'other' ? choice.text : null;
  const testid = `${topicId}-${item.candidateId}`;

  return (
    <li className={styles.item} data-testid={`topic-item-${testid}`}>
      <p className={styles.question}>
        <UserText>{item.question}</UserText>
        {item.unresolved && item.status === 'pending' ? (
          <span className={styles.which} data-testid={`topic-which-${testid}`}>
            {t('whichIsRight')}
          </span>
        ) : null}
        {mark === 'failed' ? (
          <span className={styles.markFailed} data-testid={`topic-item-failed-${testid}`}>
            {t('itemFailed')}
          </span>
        ) : mark === 'saved' ? (
          <span className={styles.markSaved}>{t('itemSaved')}</span>
        ) : null}
      </p>
      {item.chosenLine ? (
        <p className={styles.chosen} data-testid={`topic-chosen-${testid}`}>
          {item.chosenLine}
        </p>
      ) : null}
      {/* The document it contradicts, in the chosen line's place and style (0559643c). */}
      {item.docConflict?.document ? (
        <p className={styles.chosen} data-testid={`topic-doc-conflict-line-${testid}`}>
          {t('docConflictLine.lead')} <UserText>{item.docConflict.document}</UserText>
          {item.docConflict.passage ? (
            <>
              {t('docConflictLine.says')} <UserText>{item.docConflict.passage}</UserText>
            </>
          ) : null}
        </p>
      ) : null}

      {item.status !== 'pending' ? (
        <p className={styles.answer}>
          <UserText>{item.options[0] ?? ''}</UserText>{' '}
          <span className={styles.itemStatus}>{t(`itemStatus.${item.status}`)}</span>
        </p>
      ) : (
        <fieldset className={styles.choices} disabled={!editable}>
          <legend className="srOnly">{item.question}</legend>
          {item.options.map((option, index) => (
            <label key={index} className={styles.choice}>
              <input
                type="radio"
                name={name}
                checked={choice?.kind === 'option' && choice.index === index}
                onChange={() => onChoose({ kind: 'option', index })}
                data-testid={`topic-option-${testid}-${index}`}
              />
              <span className={styles.choiceText}>
                <UserText>{option}</UserText>
                {item.optionSeen[index] ? (
                  <span className={styles.seen}>
                    {t('seen', { date: item.optionSeen[index] ?? '' })}
                  </span>
                ) : null}
              </span>
            </label>
          ))}
          <label className={styles.choice}>
            <input
              type="radio"
              name={name}
              checked={other !== null}
              onChange={() => {
                focusNext.current = true;
                onChoose({ kind: 'other', text: other ?? '' });
              }}
              data-testid={`topic-other-${testid}`}
            />
            <span className={styles.choiceText}>{t('other')}</span>
          </label>
          {other !== null ? (
            <div className={styles.otherBox}>
              <textarea
                ref={(el) => {
                  if (el && focusNext.current) {
                    focusNext.current = false;
                    el.focus();
                  }
                }}
                className={channels.reportEditBox}
                value={other}
                rows={3}
                aria-label={t('otherLabel', { question: item.question })}
                aria-describedby={`${id}-count`}
                data-testid={`topic-other-text-${testid}`}
                onChange={(e) => onChoose({ kind: 'other', text: e.target.value })}
              />
              <span
                className={styles.count}
                id={`${id}-count`}
                data-over={other.trim().length > ANSWER_MAX_CHARS ? 'yes' : undefined}
                data-testid={`topic-other-count-${testid}`}
              >
                {t('counter', { count: other.trim().length, max: ANSWER_MAX_CHARS })}
              </span>
            </div>
          ) : null}
        </fieldset>
      )}

      {item.quotes.length > 0 ? (
        <ul className={styles.quotes}>
          {item.quotes.map((q, i) => (
            <li key={i} className={styles.quote}>
              {q.question ? (
                <span className={styles.quoteAsked}>
                  <UserText>{q.question}</UserText>
                </span>
              ) : null}
              {q.answer ? (
                <span className={styles.quoteSaid}>
                  <UserText>{q.answer}</UserText>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** "נוסף אוטומטית": approved without a person; "ביטול" rejects it and removes its documents. */
function AutoAdded({
  importId,
  topics,
  canWrite,
}: {
  readonly importId: string;
  readonly topics: readonly TopicView[];
  readonly canWrite: boolean;
}) {
  const t = useTranslations('channels.whatsapp.topics');
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <section className={styles.auto} data-testid="topic-auto">
      <button
        type="button"
        className={styles.autoToggle}
        aria-expanded={open}
        aria-controls={`${id}-list`}
        data-testid="topic-auto-toggle"
        onClick={() => setOpen(!open)}
      >
        {t('auto.heading', { count: topics.length })}
      </button>
      {/* Closed, the list is not drawn at all - never `hidden` under a display class. */}
      {open ? (
        <ul className={styles.autoList} id={`${id}-list`}>
          {topics.map((topic) => (
            <AutoTopic key={topic.topicId} importId={importId} topic={topic} canWrite={canWrite} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function AutoTopic({
  importId,
  topic,
  canWrite,
}: {
  readonly importId: string;
  readonly topic: TopicView;
  readonly canWrite: boolean;
}) {
  const t = useTranslations('channels.whatsapp.topics');
  const router = useRouter();
  const [undone, setUndone] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, startBusy] = useTransition();

  const undo = () => {
    setProblem(null);
    setUndone(true);
    startBusy(async () => {
      const result = await rejectTopic(importId, topic.topicId);
      if (!result.ok) {
        setUndone(false);
        if (result.reason === 'stale') router.refresh();
        setProblem(result.reason === 'stale' ? t('refreshed') : t(`refused.${result.reason}`));
        return;
      }
      router.refresh();
    });
  };

  return (
    <li className={styles.autoTopic} data-testid={`topic-auto-${topic.topicId}`}>
      <div className={styles.topicHead}>
        <p className={styles.autoLabel}>
          <UserText>{topic.label}</UserText>
        </p>
        {undone ? (
          <span className={styles.itemStatus} role="status">
            {t('auto.undone')}
          </span>
        ) : canWrite ? (
          <button
            type="button"
            className={channels.reportAction}
            disabled={busy}
            data-testid={`topic-auto-undo-${topic.topicId}`}
            onClick={undo}
          >
            {t('auto.undo')}
          </button>
        ) : null}
      </div>
      <ul className={styles.autoItems}>
        {topic.items.map((item) => (
          <li key={item.candidateId} className={styles.autoItem}>
            <span className={styles.quoteAsked}>
              <UserText>{item.question}</UserText>
            </span>
            <span>
              <UserText>{item.options[0] ?? ''}</UserText>
            </span>
          </li>
        ))}
      </ul>
      {problem ? (
        <p
          className={channels.reportProblem}
          role="alert"
          data-testid={`topic-auto-problem-${topic.topicId}`}
        >
          {problem}
        </p>
      ) : null}
    </li>
  );
}

/** "נדחו": what a person rejected, read-only (Omer, 2026-11-18). Closed, its list is not drawn. */
function Rejected({ topics }: { readonly topics: readonly TopicView[] }) {
  const t = useTranslations('channels.whatsapp.topics');
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <section className={styles.auto} data-testid="topic-rejected-section">
      <button
        type="button"
        className={styles.autoToggle}
        aria-expanded={open}
        aria-controls={`${id}-list`}
        data-testid="topic-rejected-toggle"
        onClick={() => setOpen(!open)}
      >
        {t('rejectedSection.heading', { count: topics.length })}
      </button>
      {open ? (
        <ul className={styles.autoList} id={`${id}-list`}>
          {topics.map((topic) => (
            <li
              key={topic.topicId}
              className={styles.autoTopic}
              data-testid={`topic-rejected-item-${topic.topicId}`}
            >
              <p className={styles.autoLabel}>
                <UserText>{topic.label}</UserText>
              </p>
              {topic.meta ? <p className={styles.topicMeta}>{topic.meta}</p> : null}
              <ul className={styles.autoItems}>
                {topic.items.map((item) => (
                  <li key={item.candidateId} className={styles.autoItem}>
                    <span className={styles.quoteAsked}>
                      <UserText>{item.question}</UserText>
                    </span>
                    <span>
                      <UserText>{item.options[0] ?? ''}</UserText>
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
