'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { useRouter } from '@/i18n/navigation';

import { setConversationRelevance, type RelevanceResult } from './conversation-actions';
import styles from './Inbox.module.css';
import type { RelevanceOverride, RelevanceTag } from './relevance';

export type RelevanceClasses = {
  readonly group?: string;
  readonly tag?: string;
  readonly button?: string;
  readonly problem?: string;
  /** The line after a mark that reached its sender. */
  readonly note?: string;
};

const WEBSITE: RelevanceClasses = {
  group: styles.verbs,
  tag: styles.tagNeutral,
  button: styles.verbButton,
  problem: styles.verbProblem,
  note: styles.verbNote,
};

/**
 * ★★ WHAT THIS CONVERSATION IS, AND A PERSON'S ONE-CLICK WORD ON IT (Omer,
 * 2026-11-17, `INBOX_RELEVANCE`).
 *
 * Tagged personal, a notice or marketing: the tag, and "This is a business
 * enquiry", which moves it back to the main views. A normal one: no tag, and
 * "Mark as not relevant", which moves it out (as personal). The platform
 * keeps the person's word; the classifier never relabels it.
 *
 * ★ After a yes the page is read again: the list loses (or gains) the row,
 *   the counts follow on the platform's `conversation:updated`, and the
 *   conversation stays open where it is (`?c=`). Nothing reaches the
 *   customer, so there is nothing to confirm first.
 */
export function RelevanceControl({
  conversationId,
  tag,
  override,
  classes = WEBSITE,
}: {
  readonly conversationId: string;
  /** The tag it wears (`relevanceTag`), or `null` for a normal conversation. */
  readonly tag: RelevanceTag | null;
  /** The override offered (`relevanceOverride`). */
  readonly override: RelevanceOverride;
  /** The phone's own look (`/m`); the website's verbs bar by default. */
  readonly classes?: RelevanceClasses;
}) {
  const t = useTranslations('inbox.relevance');
  const router = useRouter();
  const [result, setResult] = useState<RelevanceResult | null>(null);
  const [isPending, startTransition] = useTransition();

  function press() {
    setResult(null);
    startTransition(async () => {
      const outcome = await setConversationRelevance(conversationId, override);
      setResult(outcome);
      if (outcome.ok) router.refresh();
    });
  }

  return (
    <div
      className={classes.group}
      role="group"
      aria-label={t('label')}
      data-testid={`relevance-${conversationId}`}
    >
      {tag === null ? null : (
        <span className={classes.tag} data-testid={`relevance-tag-${conversationId}`}>
          {t(`tag.${tag}`)}
        </span>
      )}
      <button
        type="button"
        className={classes.button}
        data-testid={`relevance-${override}-${conversationId}`}
        disabled={isPending}
        onClick={press}
      >
        {override === 'business' ? t('markBusiness') : t('markIrrelevant')}
      </button>
      {/*
        What the mark did to its sender (Backend's sender rule), only when the
        response says so - never inferred from the channel. Dark until it does.
      */}
      {result?.ok && result.senderRule ? (
        <p
          className={classes.note}
          role="status"
          data-testid={`relevance-sender-${conversationId}`}
        >
          {t(`sender.${result.senderRule}`)}
        </p>
      ) : null}
      {result && !result.ok ? (
        <p
          className={classes.problem}
          role="alert"
          data-testid={`relevance-problem-${conversationId}`}
        >
          {t(
            `problem.${result.reason === 'not_found' || result.reason === 'not_allowed' ? result.reason : 'failed'}`,
          )}
        </p>
      ) : null}
    </div>
  );
}
