import { getFormatter, getTranslations } from 'next-intl/server';

import { hasEverRun, type Automation } from '@/api/contracts/automations';

import styles from './Automations.module.css';

/**
 * Screen 09 — automations.
 *
 * ── THE COUNT IS FOR ALL TIME ──
 * The design says *"Ran 46 times **this week**"* and *"handled 1,204 things
 * this week"*. `runCount` is cumulative with no clock, and **there are no run
 * records of any kind** — so no per-period figure exists and none is claimed.
 * The screen says *"ran 46 times"*, which is what the number means.
 *
 * ── AND NEVER-RUN IS ITS OWN STATE ──
 * An automation that is on and has never fired is the interesting row on this
 * screen — it usually means the trigger never matches — and a bare `0` in a
 * column would not be noticed. It gets words instead.
 */
export async function AutomationList({
  automations,
}: {
  readonly automations: readonly Automation[];
}) {
  const t = await getTranslations('automations');
  const format = await getFormatter();

  return (
    <ul className={styles.list} data-testid="automation-list">
      {automations.map((automation) => (
        <li
          key={automation.id}
          className={styles.automation}
          data-testid={`automation-${automation.id}`}
          data-active={automation.isActive ? 'yes' : 'no'}
        >
          <div className={styles.head}>
            <h3 className={styles.name}>{automation.name}</h3>
            <span className={styles.state} data-testid={`state-${automation.id}`}>
              {automation.isActive ? t('state.on') : t('state.off')}
            </span>
          </div>

          {automation.description ? (
            <p className={styles.description}>{automation.description}</p>
          ) : null}

          {/*
            One channel, or all of them. The model has a single nullable
            field, so "WhatsApp, Instagram and email" is not expressible —
            and listing every known channel for a null would invent a
            specificity the flow does not have.
          */}
          <p className={styles.where} data-testid={`where-${automation.id}`}>
            {automation.channel ? t('where.one', { channel: automation.channel }) : t('where.all')}
          </p>

          {/*
            All-time, never "this week". The counter has no clock and there
            are no run records to derive a period from.
          */}
          <p className={styles.runs} data-testid={`runs-${automation.id}`}>
            {hasEverRun(automation)
              ? t('runs.total', { count: format.number(automation.runCount) })
              : t('runs.never')}
          </p>
        </li>
      ))}
    </ul>
  );
}
