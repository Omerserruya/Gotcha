'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';

import { confidenceBand, isDraft, type Suggestion } from '@/api/contracts/copilot';
import { UserText } from '@/design-system/primitives/text/UserText';
import { useConversationRoom, useRealtimeEvent } from '@/realtime/realtime-provider';

import type { CopilotRead } from '../load-copilot';
import { fillComposer } from '../reply-event';
import { useCarousel } from './use-carousel';
import { Pager } from './Pager';
import { readSuggestions, refreshSuggestions } from './wall-actions';
import { canUse, saysRecommended, suggestionView } from './wall-model';
import styles from './Wall.module.css';

/**
 * 02's "Three ways to answer · 1 of 3 open".
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THREE READS, AND EACH HAS ONE CAUSE (Omer, 2026-10-06; Backend 9c5e96cc)
 * ════════════════════════════════════════════════════════════════════════════
 *   the GET      once, when the wall mounts on a conversation
 *   the GET      again, on `copilot.suggestions.updated` for this one
 *   the refresh  "Try again" — a model call, metered, and only the button
 *
 * Not in `loadConversation`: the page re-renders on every delivery change
 * (`StreamLive`), and a read there is a read per refresh.
 *
 * ── "USE THIS" AND "EDIT" SEND NOTHING ──
 * Both put the text in the reply box; Use this as it is, Edit with the box
 * focused and the text selected for changing. The composer is the only
 * control here that sends.
 */
export function SuggestionCarousel({ conversationId }: { readonly conversationId: string }) {
  const t = useTranslations('inbox');
  const [read, setRead] = useState<CopilotRead | null>(null);
  const [wait, setWait] = useState<number | null | undefined>(undefined);
  const [isPending, startTransition] = useTransition();
  const asked = useRef(false);

  const reread = useCallback(() => {
    startTransition(async () => setRead(await readSuggestions(conversationId)));
  }, [conversationId]);

  // Once per conversation: the wall is keyed by it, and a ref survives
  // StrictMode's second effect, so dev does not read twice either.
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    reread();
  }, [reread]);

  useConversationRoom(conversationId);
  useRealtimeEvent(
    'copilot.suggestions.updated',
    useCallback(
      (event) => {
        if (event.type !== 'copilot.suggestions.updated') return;
        if (event.conversationId !== conversationId) return;
        reread();
      },
      [conversationId, reread],
    ),
  );

  const tryAgain = () => {
    setWait(undefined);
    startTransition(async () => {
      const answer = await refreshSuggestions(conversationId);
      if (answer.state === 'rate_limited') setWait(answer.retryAfterSeconds);
      else setRead(answer);
    });
  };

  const view = read === null ? null : suggestionView(read);
  const cards = view?.kind === 'cards' ? view.suggestions : [];
  const { index, go, region, first, last } = useCarousel(cards.length);

  return (
    <section className={styles.answers} data-testid="wall-suggestions" aria-busy={isPending}>
      <div className={styles.blockHead}>
        <h3 className={styles.blockTitle}>{t('wall.answers.title', { count: cards.length })}</h3>
        {cards.length > 1 ? (
          <>
            <span className={styles.meta} data-testid="wall-suggestions-position">
              {t('wall.answers.position', { at: index + 1, count: cards.length })}
            </span>
            <Pager first={first} last={last} go={go} testid="wall-suggestions" />
          </>
        ) : null}
      </div>

      {view === null ? (
        <p className={styles.note} data-testid="wall-suggestions-loading">
          {t('wall.answers.reading')}
        </p>
      ) : view.kind === 'note' ? (
        <>
          <p className={styles.note} data-testid="wall-suggestions-note" data-note={view.note}>
            {view.note === 'waiting' || view.note === 'writing'
              ? t(`wall.answers.${view.note}`)
              : t(`copilot.${view.note}`)}
          </p>
          {view.retry ? <RetryLine wait={wait} pending={isPending} onRetry={tryAgain} /> : null}
        </>
      ) : (
        <div className={styles.cards} {...region} aria-roledescription={t('wall.carousel')}>
          {view.stale ? (
            <p className={styles.note} data-testid="wall-suggestions-stale">
              {t('wall.answers.stale')}
            </p>
          ) : null}
          {cards.map((suggestion, i) =>
            i === index ? (
              <OpenCard key={suggestion.id} suggestion={suggestion} recommended={i === 0} />
            ) : (
              <button
                key={suggestion.id}
                type="button"
                className={styles.foldedCard}
                data-testid={`wall-suggestion-${suggestion.id}`}
                data-open="no"
                onClick={() => go(i - index)}
              >
                <CardHead suggestion={suggestion} recommended={i === 0} />
                <UserText className={styles.foldedText}>{suggestion.text}</UserText>
              </button>
            ),
          )}
        </div>
      )}
    </section>
  );
}

function RetryLine({
  wait,
  pending,
  onRetry,
}: {
  readonly wait: number | null | undefined;
  readonly pending: boolean;
  readonly onRetry: () => void;
}) {
  const t = useTranslations('inbox.wall.answers');
  return (
    <p className={styles.retryLine}>
      <button
        type="button"
        className={styles.textButton}
        onClick={onRetry}
        disabled={pending}
        data-testid="wall-suggestions-retry"
      >
        {pending ? t('trying') : t('retry')}
      </button>
      {wait !== undefined ? (
        <span className={styles.meta} data-testid="wall-suggestions-wait">
          {wait === null ? t('waitUnnamed') : t('wait', { seconds: wait })}
        </span>
      ) : null}
    </p>
  );
}

/** "Recommended · <approach>" on the first; the approach alone on the rest. Model text isolated. */
function CardHead({
  suggestion,
  recommended,
}: {
  readonly suggestion: Suggestion;
  readonly recommended: boolean;
}) {
  const t = useTranslations('inbox');
  const approach = suggestion.approach?.trim();
  const rationale = suggestion.rationale?.trim();
  // The model often writes "Recommended · escalate" itself: ours once, not twice.
  const ours =
    recommended && !(approach && saysRecommended(approach, t('wall.answers.recommended')));
  /* A band, never a percentage — see `confidenceBand`. */
  const confidence = isDraft(suggestion)
    ? t(`copilot.confidence.${confidenceBand(suggestion)}` as 'copilot.confidence.high')
    : t('copilot.proposal');
  return (
    <span className={styles.cardHead}>
      <span className={styles.cardLabel} data-recommended={recommended ? 'yes' : 'no'}>
        {ours ? t('wall.answers.recommended') : null}
        {ours && approach ? ' · ' : null}
        {approach ? <UserText>{approach}</UserText> : null}
        {!recommended && !approach ? t('wall.answers.another') : null}
      </span>
      {/*
        02's top right is the WHY or the cost ("no refund yet", "costs ₪179",
        "needs approval") — the model's rationale. How sure it is goes in the
        title; with no rationale, it is the line.
      */}
      <span className={styles.cardWhy} title={confidence} data-testid={`wall-why-${suggestion.id}`}>
        {rationale ? <UserText>{rationale}</UserText> : confidence}
      </span>
    </span>
  );
}

function OpenCard({
  suggestion,
  recommended,
}: {
  readonly suggestion: Suggestion;
  readonly recommended: boolean;
}) {
  const t = useTranslations('inbox.wall.answers');
  return (
    <div
      className={styles.openCard}
      data-testid={`wall-suggestion-${suggestion.id}`}
      data-open="yes"
    >
      <CardHead suggestion={suggestion} recommended={recommended} />
      <UserText className={styles.openText}>{suggestion.text}</UserText>
      {/*
        A proposed action has no button here — the approvals screen is where
        a tool is fired, with the keyboard model built for no undo.
      */}
      {canUse(suggestion) ? (
        <div className={styles.cardActions}>
          <button
            type="button"
            className={styles.useButton}
            onClick={() => fillComposer(suggestion.text)}
            title={t('useTitle')}
            data-testid="wall-suggestion-use"
          >
            {t('use')}
          </button>
          <button
            type="button"
            className={styles.outlineButton}
            onClick={() => fillComposer(suggestion.text, { select: true })}
            title={t('editTitle')}
            data-testid="wall-suggestion-edit"
          >
            {t('edit')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
