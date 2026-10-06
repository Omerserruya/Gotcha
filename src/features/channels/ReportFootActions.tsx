'use client';

import { RotateCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, useTransition, type ReactNode } from 'react';

import { useRouter } from '@/i18n/navigation';

import { addReadyAnswers, rerunAnalysis } from './candidate-actions';
import styles from './Channels.module.css';

/**
 * 13f's two foot actions, live (Omer). Each changes what GOTCHA tells
 * customers in bulk, so each asks first and says exactly what it will do.
 */
export function AddReady({
  importId,
  count,
}: {
  readonly importId: string;
  readonly count: number;
}) {
  const t = useTranslations('channels.whatsapp.foot');
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  if (said?.ok) {
    return (
      <span className={styles.footDone} role="status" data-testid="bulk-done">
        {said.text}
      </span>
    );
  }
  return asking ? (
    <span className={styles.footAsk} data-testid="bulk-confirm">
      <span>{t('addAsk', { count })}</span>
      <button
        type="button"
        className={styles.learnPrimaryButton}
        disabled={isPending}
        data-testid="bulk-yes"
        onClick={() =>
          startTransition(async () => {
            const done = await addReadyAnswers(importId);
            setAsking(false);
            if (done.ok) {
              setSaid({
                ok: true,
                text: t('added', { count: done.approved, skipped: done.skipped }),
              });
              router.refresh();
            } else setSaid({ ok: false, text: t(`refused.${done.reason}`) });
          })
        }
      >
        {isPending ? t('adding') : t('addYes')}
      </button>
      <button type="button" className={styles.footCancel} onClick={() => setAsking(false)}>
        {t('cancel')}
      </button>
    </span>
  ) : (
    <span className={styles.footAsk}>
      <button
        type="button"
        className={styles.learnPrimaryButton}
        disabled={count === 0}
        data-testid="report-bulk"
        onClick={() => {
          setSaid(null);
          setAsking(true);
        }}
      >
        {t('add', { count })}
      </button>
      {said ? (
        <span className={styles.footProblem} role="alert" data-testid="bulk-problem">
          {said.text}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The footer row. Run again's confirmation is a long sentence, and beside Add
 * and Finish later it wrapped both onto several lines (measured on dev), so
 * while it asks it IS the row; Not now gives the row back.
 */
export function ReportFoot({
  importId,
  count,
  later,
  noteClassName,
}: {
  readonly importId: string;
  readonly count: number;
  /** "Finish later" - a link the server renders. */
  readonly later: ReactNode;
  readonly noteClassName?: string;
}) {
  const [rerunAsking, setRerunAsking] = useState(false);
  return (
    <>
      {/* Positions are fixed, so RunAgain keeps its state as the others leave. */}
      {rerunAsking ? null : <AddReady importId={importId} count={count} />}
      {rerunAsking ? null : later}
      <span className={rerunAsking ? undefined : noteClassName}>
        <RunAgain importId={importId} asking={rerunAsking} setAsking={setRerunAsking} />
      </span>
    </>
  );
}

export function RunAgain({
  importId,
  asking,
  setAsking,
}: {
  readonly importId: string;
  readonly asking: boolean;
  readonly setAsking: (asking: boolean) => void;
}) {
  const t = useTranslations('channels.whatsapp.foot');
  const router = useRouter();
  const [problem, setProblem] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  return asking ? (
    <span className={styles.footAsk} data-testid="rerun-confirm">
      <span>{t('rerunAsk')}</span>
      <button
        type="button"
        className={styles.footDanger}
        disabled={isPending}
        data-testid="rerun-yes"
        onClick={() =>
          startTransition(async () => {
            const done = await rerunAnalysis(importId);
            setAsking(false);
            if (done.ok)
              router.push(`/settings/channels?panel=whatsapp&import=${importId}&view=progress`);
            else setProblem(t(`rerunRefused.${done.reason}`));
          })
        }
      >
        {isPending ? t('rerunning') : t('rerunYes')}
      </button>
      <button type="button" className={styles.footCancel} onClick={() => setAsking(false)}>
        {t('cancel')}
      </button>
    </span>
  ) : (
    <span className={styles.footAsk}>
      <button
        type="button"
        className={styles.rerunButton}
        data-testid="report-rerun"
        onClick={() => {
          setProblem(null);
          setAsking(true);
        }}
      >
        <RotateCw size={13} aria-hidden="true" />
        {t('rerun')}
      </button>
      {problem ? (
        <span className={styles.footProblem} role="alert" data-testid="rerun-problem">
          {problem}
        </span>
      ) : null}
    </span>
  );
}
