'use client';

import { useFormatter, useTranslations } from 'next-intl';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from 'react';

import { labelOf, type ActivityStep } from '@/api/contracts/ai-activity';
import { useConversationRoom, useRealtimeEvent } from '@/realtime/realtime-provider';

import { stopAi } from '../conversation-actions';
import { readActivity } from './wall-actions';
import { activitySummary, applyStep } from './wall-model';
import styles from './Wall.module.css';

/** `undefined`: not read yet; `null`: the read failed. */
type Steps = readonly ActivityStep[] | null | undefined;

const ActivityContext = createContext<Steps>(undefined);

/**
 * The AI's steps for the open conversation (Backend ed0f1c9c), shared by the
 * header's "Working on this" and the body's "What it did".
 *
 * ★ ONE READ, THEN THE EVENTS. The list is read once when the wall opens on
 *   a conversation; each `ai.activity.updated` changes its row in place —
 *   running → completed with its duration — and nothing re-reads the list.
 */
export function ActivityProvider({
  conversationId,
  children,
}: {
  /** `null`: nothing open — nothing read, nothing joined. */
  readonly conversationId: string | null;
  readonly children: ReactNode;
}) {
  const [steps, setSteps] = useState<Steps>(undefined);
  const asked = useRef(false);

  useEffect(() => {
    if (asked.current || conversationId === null) return;
    asked.current = true;
    void readActivity(conversationId).then(setSteps);
  }, [conversationId]);

  useConversationRoom(conversationId);
  useRealtimeEvent(
    'ai.activity.updated',
    useCallback(
      (event) => {
        if (event.type !== 'ai.activity.updated' || event.conversationId !== conversationId) {
          return;
        }
        // A step before the list arrived starts the list; after a failed read too.
        setSteps((now) => applyStep(now ?? [], event));
      },
      [conversationId],
    ),
  );

  return <ActivityContext.Provider value={steps}>{children}</ActivityContext.Provider>;
}

/** 02's header, right side: "Working on this · stop" while a step runs, "—" otherwise. */
export function WorkingState({
  conversationId,
  aiDriving,
}: {
  readonly conversationId: string | null;
  /** The AI answers this conversation now — so "stop" means something. */
  readonly aiDriving: boolean;
}) {
  const t = useTranslations('inbox.wall.activity');
  const steps = useContext(ActivityContext);
  const [failed, setFailed] = useState(false);
  const [isPending, startTransition] = useTransition();
  const running = steps ? activitySummary(steps).running : false;

  if (!running || conversationId === null) {
    return (
      <span
        className={styles.headerState}
        title={steps === null ? t('unread') : t('idle')}
        data-testid="wall-working"
        data-working="no"
      >
        —
      </span>
    );
  }
  return (
    <span className={styles.headerState} data-testid="wall-working" data-working="yes">
      {t('workingOn')}
      {aiDriving ? (
        <>
          {' · '}
          <button
            type="button"
            className={styles.textButton}
            disabled={isPending}
            title={failed ? t('stopFailed') : t('stopTitle')}
            onClick={() =>
              startTransition(async () => setFailed(!(await stopAi(conversationId)).ok))
            }
            data-testid="wall-stop"
          >
            {t('stop')}
          </button>
        </>
      ) : null}
    </span>
  );
}

/** How many steps the strip lists; the count says how many there are. */
export const STEPS_SHOWN = 5;

/** 02's "What it did · 5 steps · 4s", then a dot, a label and a result per step. */
export function ActivityStrip() {
  const t = useTranslations('inbox.wall.activity');
  const format = useFormatter();
  const steps = useContext(ActivityContext);
  const summary = steps ? activitySummary(steps) : null;

  const seconds = (ms: number) =>
    ms < 1000
      ? t('ms', { ms: format.number(Math.round(ms)) })
      : t('seconds', { s: format.number(ms / 1000, { maximumFractionDigits: 1 }) });

  return (
    <section className={styles.activity} data-testid="wall-activity">
      <div className={styles.activityHead}>
        <span>{t('title')}</span>
        <span className={styles.rule} aria-hidden="true" />
        <span data-testid="wall-activity-count" title={steps === null ? t('unread') : undefined}>
          {summary === null
            ? '—'
            : summary.count === 0
              ? t('none')
              : `${t('steps', { count: summary.count })} · ${seconds(summary.totalMs)}`}
        </span>
      </div>
      {steps === undefined ? null : steps === null ? (
        <div className={styles.step}>
          <span className={styles.stepDot} aria-hidden="true" />
          <span className={styles.stepText} title={t('unread')}>
            —
          </span>
        </div>
      ) : (
        <ol className={styles.steps}>
          {steps.slice(0, STEPS_SHOWN).map((step) => (
            <li
              key={step.id}
              className={styles.step}
              data-testid={`wall-step-${step.id}`}
              data-status={step.status ?? 'unknown'}
            >
              <span
                className={styles.stepDot}
                data-status={step.status ?? 'unknown'}
                aria-hidden="true"
              />
              <span className={styles.stepText}>{t(`label.${labelOf(step.labelKey)}`)}</span>
              <span
                className={styles.stepResult}
                data-status={step.status ?? 'unknown'}
                // The provider's message on a failure — never the tool's arguments.
                title={step.error ?? undefined}
              >
                {step.status === 'completed'
                  ? step.durationMs === null
                    ? t('status.completed')
                    : seconds(step.durationMs)
                  : step.status === null
                    ? '—'
                    : t(`status.${step.status}`)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
