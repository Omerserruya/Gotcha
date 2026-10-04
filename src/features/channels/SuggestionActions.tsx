'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { useRouter } from '@/i18n/navigation';

import { approveSuggestion, rejectSuggestion } from './candidate-actions';
import styles from './Channels.module.css';

/**
 * A suggestion's decisions on 13f — live (Omer, decision 13). A conflict
 * offers each observed answer to use; any suggestion can be edited before it
 * is approved, or set aside. Nothing is written before a press.
 */
export function SuggestionActions({
  id,
  answer,
  variants,
  seeChats = null,
}: {
  readonly id: string;
  readonly answer: string;
  /** The observed answers when they disagree; empty otherwise. */
  readonly variants: readonly string[];
  /** 02's "See the chats" on the right of a conflict — drawn: the evidence has no screen yet. */
  readonly seeChats?: string | null;
}) {
  const t = useTranslations('channels.whatsapp');
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null);
  const [said, setSaid] = useState<{ tone: 'ok' | 'problem'; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();
  const conflict = variants.length > 1;

  const approve = (text: string) =>
    startTransition(async () => {
      setSaid(null);
      const result = await approveSuggestion(id, text);
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
              onClick={() => approve(editing)}
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
                  onClick={() => approve(v)}
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
                onClick={() => approve(answer)}
              >
                {t('review.approve')}
              </button>
            )}
            {/* 02: a conflict is decided between its answers — Use, Use, Skip; no Edit. */}
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
              <span
                className={styles.reportSeeChats}
                aria-disabled="true"
                title={t('learn.seeChatsNotYet')}
                data-testid={`see-chats-${id}`}
              >
                {seeChats}
              </span>
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
