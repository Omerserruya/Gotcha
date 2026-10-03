import { getFormatter, getTranslations } from 'next-intl/server';

import { humaniseCode } from '@/api/contracts/capabilities';
import { flowSteps, hasEverRun, STEP_TYPES, type Automation } from '@/api/contracts/automations';
import { channelName } from '@/api/contracts/inbox';
import { UserText } from '@/design-system/primitives/text/UserText';

import styles from './Automations.module.css';

/**
 * Screen 09's detail — the selected automation, measured.
 *
 * The name (24/600) over where it runs, Pause / Duplicate on the right; a
 * WHEN / THEN card; then how it has gone beside why it stopped.
 *
 * ── LIVE ──
 *   WHEN        `trigger` — free text, rendered as written
 *   THEN        the flow graph's steps, in the order it runs them, each by
 *               its node type; where it branches, it says so and stops
 *   runs        `runCount` — ALL-TIME, never "this week": no clock, no records
 *   on / off    `isActive` — a bare boolean: no actor, no date
 *
 * ── IN THEIR SHAPE ──
 *   finished alone / waited for you / stopped — no run records exist
 *   why it stopped — nothing records a stop's cause
 *   Pause, Duplicate — not built from here yet
 */
export async function AutomationDetail({ automation }: { readonly automation: Automation }) {
  const t = await getTranslations('automations');
  const channelNames = await getTranslations('channels');
  const format = await getFormatter();
  const { steps, branches } = flowSteps(automation);

  const stepWords = (type: string) =>
    (STEP_TYPES as readonly string[]).includes(type)
      ? t(`step.${type}` as 'step.send_message_text')
      : humaniseCode(type || 'step');

  return (
    <>
      <header className={styles.head}>
        <div className={styles.heading}>
          <h2 className={styles.name}>{automation.name}</h2>
          {/*
            One channel, or all of them — never the enum, and never a list of
            every channel for a null: the model says "all", not "these eight".
          */}
          <p className={styles.where} data-testid={`where-${automation.id}`}>
            {automation.channel
              ? t('where.one', { channel: channelName(automation.channel, channelNames)! })
              : t('where.all')}
            {' · '}
            <span data-testid={`state-${automation.id}`}>
              {automation.isActive ? t('state.on') : t('state.off')}
            </span>
          </p>
        </div>
        <div className={styles.actions}>
          <span className={styles.button} aria-disabled="true" title={t('detail.notYet')}>
            {automation.isActive ? t('detail.pause') : t('detail.resume')}
          </span>
          <span className={styles.button} aria-disabled="true" title={t('detail.notYet')}>
            {t('detail.duplicate')}
          </span>
        </div>
      </header>

      <section className={styles.flow} data-testid="flow">
        <div className={styles.flowRow}>
          <span className={styles.flowLabel}>{t('detail.when')}</span>
          <p className={styles.flowStep} data-testid="flow-when">
            {automation.trigger?.trim() ? (
              <UserText>{automation.trigger}</UserText>
            ) : (
              <span className={styles.flowNone}>{t('detail.whenNone')}</span>
            )}
          </p>
        </div>
        <div className={styles.flowRow}>
          <span className={styles.flowLabel}>{t('detail.then')}</span>
          <div className={styles.flowSteps} data-testid="flow-then">
            {steps.length === 0 ? (
              <p className={styles.flowStep}>
                <span className={styles.flowNone}>{t('detail.thenNone')}</span>
              </p>
            ) : (
              steps.map((type, index) => (
                <p key={`${type}-${index}`} className={styles.flowStep}>
                  {stepWords(type)}
                </p>
              ))
            )}
            {branches > 1 ? (
              <p className={styles.flowBranch} data-testid="flow-branches">
                {t('detail.branches', { count: branches })}
              </p>
            ) : null}
          </div>
        </div>
      </section>

      <div className={styles.bottom}>
        <section className={styles.went}>
          {/* No clock on the count: the card is not titled with a week. */}
          <h3 className={styles.cardTitle}>{t('detail.went')}</h3>
          <dl className={styles.wentFigures}>
            <div>
              <dd data-testid={`runs-${automation.id}`}>
                {hasEverRun(automation) ? format.number(automation.runCount) : '—'}
              </dd>
              <dt>
                {hasEverRun(automation)
                  ? t('detail.times', { count: automation.runCount })
                  : t('runs.never')}
              </dt>
            </div>
            <div>
              <dd>—</dd>
              <dt>{t('detail.alone')}</dt>
            </div>
            <div>
              <dd>—</dd>
              <dt>{t('detail.waited')}</dt>
            </div>
            <div>
              <dd>—</dd>
              <dt>{t('detail.stopped')}</dt>
            </div>
          </dl>
        </section>

        {/*
          Neutral, like 08's empty conflict card: alert colour only for a
          real stop, and nothing records one yet.
        */}
        <section className={styles.stops} data-state="empty" data-testid="stops">
          <h3 className={styles.stopsTitle}>{t('detail.stopsTitle')}</h3>
          <p className={styles.stopsBody}>{t('detail.stopsNone')}</p>
        </section>
      </div>
    </>
  );
}
