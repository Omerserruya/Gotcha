import { getFormatter, getTranslations } from 'next-intl/server';

import { hasEverRun, type Automation } from '@/api/contracts/automations';
import { channelLabelKey } from '@/api/contracts/inbox';

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
  const channelNames = await getTranslations('channels');
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

            ══════════════════════════════════════════════════════════════════
            ★★ THE FOURTH RENDERER OF `channel`, AND IT IS DORMANT ON DEV
            ══════════════════════════════════════════════════════════════════
            This read `Runs on {channel}` with the platform's enum in it, so a
            channel-scoped automation would say **"Runs on WHATSAPP"**. No
            browser walk found it, and not because it is subtle: every
            automation on the dev tenant has `channel: null`, so the page only
            ever renders the `where.all` branch.

            ★ So the defect was invisible to the instrument that found its three
              siblings, for the same reason five other branches were invisible
              to captures this week — **tenant state forecloses the branch.** It
              was found by grepping the FIELD, which is the only method that
              does not care whether today's data reaches the code.
          */}
          <p className={styles.where} data-testid={`where-${automation.id}`}>
            {automation.channel
              ? t('where.one', {
                  channel: channelLabelKey(automation.channel)
                    ? channelNames(`name.${automation.channel}` as 'name.WHATSAPP')
                    : channelNames('name.other'),
                })
              : t('where.all')}
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
