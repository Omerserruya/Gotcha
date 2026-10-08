'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { knowledgeDocumentOf } from '@/api/contracts/knowledge-candidates';
import { WhatWillBeUsed } from '@/features/knowledge/WhatWillBeUsed';
import { Link, useRouter } from '@/i18n/navigation';

import { approveSuggestion, rejectSuggestion } from './candidate-actions';
import styles from './Channels.module.css';

/**
 * A suggestion's decisions on 13f - live (Omer, decision 13). A conflict
 * offers each observed answer to use; any suggestion can be edited before it
 * is approved, or set aside.
 *
 * ★ APPROVING CHANGES WHAT THE AI TELLS REAL CUSTOMERS, SO IT ASKS FIRST, AND
 *   SHOWS WHAT IT ASKS ABOUT (Omer): Approve, a Use, and Save each open the
 *   document the route will write, word for word - question, answer, and the
 *   platform's own lines - and only "Yes" sends it. Until then nothing is
 *   written, so nothing is used. Set aside writes no knowledge; it goes at once.
 */
export function SuggestionActions({
  id,
  question,
  answer,
  reasoning = null,
  liveLookup = false,
  variants,
  seeChats = null,
}: {
  readonly id: string;
  readonly question: string;
  readonly answer: string;
  /** Part of the document an approve writes; see `knowledgeDocumentOf`. */
  readonly reasoning?: string | null;
  readonly liveLookup?: boolean;
  /** The observed answers when they disagree; empty otherwise. */
  readonly variants: readonly string[];
  /** 02's "See the chats" on the right of a conflict: its words and where it opens. */
  readonly seeChats?: {
    readonly label: string;
    readonly href: {
      readonly pathname: '/settings/channels';
      readonly query: Record<string, string>;
    };
  } | null;
}) {
  const t = useTranslations('channels.whatsapp');
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null);
  /** The answer awaiting its "Yes" - shown as the document it becomes. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [said, setSaid] = useState<{ tone: 'ok' | 'problem'; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();
  const conflict = variants.length > 1;

  const approve = (text: string) =>
    startTransition(async () => {
      setSaid(null);
      const result = await approveSuggestion(id, text);
      setConfirming(null);
      if (result.ok) {
        setSaid({ tone: 'ok', text: t('decide.approved') });
        router.refresh();
      } else {
        setSaid({ tone: 'problem', text: t(`decide.refused.${result.reason}`) });
      }
    });

  const reject = () =>
    startTransition(async () => {
      setSaid(null);
      const result = await rejectSuggestion(id);
      if (result.ok) {
        setSaid({ tone: 'ok', text: t('decide.rejected') });
        router.refresh();
      } else {
        setSaid({ tone: 'problem', text: t(`decide.refused.${result.reason}`) });
      }
    });

  if (said?.tone === 'ok') {
    return (
      <p className={styles.reportDecided} role="status" data-testid={`decided-${id}`}>
        {said.text}
      </p>
    );
  }

  if (confirming !== null) {
    return (
      <div className={styles.usedAsk} data-testid={`confirm-${id}`}>
        <p className={styles.usedAskTitle}>{t('decide.confirm.title')}</p>
        <WhatWillBeUsed
          document={knowledgeDocumentOf(question, confirming, reasoning, liveLookup)}
          testid={`used-${id}`}
        />
        <p className={styles.usedAskNote}>{t('decide.confirm.note')}</p>
        <p className={styles.reportActions}>
          <button
            type="button"
            className={styles.reportAction}
            data-tone="primary"
            disabled={isPending}
            data-testid={`confirm-yes-${id}`}
            onClick={() => approve(confirming)}
          >
            {isPending ? t('decide.confirm.using') : t('decide.confirm.yes')}
          </button>
          <button
            type="button"
            className={styles.reportAction}
            disabled={isPending}
            data-testid={`confirm-back-${id}`}
            onClick={() => setConfirming(null)}
          >
            {t('decide.confirm.back')}
          </button>
        </p>
      </div>
    );
  }

  return (
    <>
      {editing !== null ? (
        <div className={styles.reportEdit}>
          <textarea
            className={styles.reportEditBox}
            value={editing}
            rows={3}
            aria-label={t('learn.edit')}
            data-testid={`edit-${id}`}
            onChange={(e) => setEditing(e.target.value)}
          />
        </div>
      ) : null}
      <p className={styles.reportActions}>
        {editing !== null ? (
          <>
            <button
              type="button"
              className={styles.reportAction}
              data-tone="primary"
              disabled={isPending || !editing.trim()}
              data-testid={`save-${id}`}
              onClick={() => {
                setSaid(null);
                setConfirming(editing.trim());
              }}
            >
              {t('decide.saveApprove')}
            </button>
            <button
              type="button"
              className={styles.reportAction}
              disabled={isPending}
              onClick={() => setEditing(null)}
            >
              {t('decide.cancel')}
            </button>
          </>
        ) : (
          <>
            {conflict ? (
              variants.map((v, i) => (
                <button
                  key={i}
                  type="button"
                  className={styles.reportAction}
                  // 02: the most-seen answer leads (black); the others beside it.
                  data-tone={i === 0 ? 'primary' : undefined}
                  disabled={isPending}
                  data-testid={`use-${id}-${i}`}
                  onClick={() => {
                    setSaid(null);
                    setConfirming(v);
                  }}
                >
                  {t('learn.use', { answer: v.slice(0, 24) })}
                </button>
              ))
            ) : (
              <button
                type="button"
                className={styles.reportAction}
                data-tone="primary"
                disabled={isPending}
                data-testid={`approve-${id}`}
                onClick={() => {
                  setSaid(null);
                  setConfirming(answer);
                }}
              >
                {t('review.approve')}
              </button>
            )}
            {/* 02: a conflict is decided between its answers - Use, Use, Skip; no Edit. */}
            {conflict ? null : (
              <button
                type="button"
                className={styles.reportAction}
                disabled={isPending}
                data-testid={`edit-open-${id}`}
                onClick={() => setEditing(answer)}
              >
                {t('learn.edit')}
              </button>
            )}
            <button
              type="button"
              className={styles.reportAction}
              disabled={isPending}
              data-testid={`reject-${id}`}
              onClick={reject}
            >
              {conflict ? t('learn.skip') : t('review.reject')}
            </button>
            {seeChats ? (
              <Link
                href={seeChats.href}
                className={styles.reportSeeChats}
                data-testid={`see-chats-${id}`}
                scroll={false}
              >
                {seeChats.label}
              </Link>
            ) : null}
          </>
        )}
      </p>
      {said ? (
        <p className={styles.reportProblem} role="alert" data-testid={`decide-problem-${id}`}>
          {said.text}
        </p>
      ) : null}
    </>
  );
}
