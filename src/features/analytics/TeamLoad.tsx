import { getFormatter, getTranslations } from 'next-intl/server';

import { byName, type AgentLoad } from '@/api/contracts/analytics';

import styles from './Analytics.module.css';

/**
 * Screen 06c — the team's workload.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * SHIPPED WITHOUT AN OUTCOME COLUMN, ON THE OWNER'S DECISION
 * ════════════════════════════════════════════════════════════════════════════
 * The design's first behaviour line is *"load is shown alongside outcome, so
 * volume never reads as merit"*. There is no per-agent outcome anywhere in
 * the platform — no resolution rate, no resolved count — so that
 * counterweight cannot be built today. The risk was put to Omer with the
 * alternatives and he chose to ship the table without it.
 *
 * ── SO WHAT IS LEFT IS TO NOT MISDESCRIBE IT ──
 * Authorising a screen with no outcome metric is not authorising a screen
 * that overstates the numbers it does have. Each figure carries the period
 * it actually covers, nothing is derived, and the two absences a reader will
 * notice are stated rather than left to be inferred:
 *
 *   · these are today's numbers, not the seven days the tab above shows
 *   · this is the human team; AI employees are not in this list
 *
 * ── AND NO PROXY FOR THE MISSING COLUMN ──
 * The tempting move is to put speed where outcome should be. Speed is not
 * quality: a fast average beside a big count invites exactly the reading the
 * design was trying to prevent, and dressed as an outcome it would be worse
 * than the honest absence. Volume and speed ship as volume and speed.
 */
export async function TeamLoad({
  agents,
}: {
  /** `null` when the read failed. Never an empty team. */
  readonly agents: readonly AgentLoad[] | null;
}) {
  const t = await getTranslations('analytics');
  const format = await getFormatter();

  if (agents === null) {
    return (
      <section className={styles.panel} data-testid="team-unavailable">
        <h2 className={styles.panelHeading}>{t('team.heading')}</h2>
        <p className={styles.note}>{t('team.unavailable')}</p>
      </section>
    );
  }

  return (
    <section className={styles.panel} data-testid="team-load">
      <h2 className={styles.panelHeading}>{t('team.heading')}</h2>

      {/*
        ★★ THE PERIOD, SAID HERE AND NOT INHERITED FROM THE TAB ABOVE.
        `claimedToday` and the response average are Redis day-keys. The
        screen's header says seven days; these numbers cannot answer that,
        and a figure under the wrong period label is wrong in a way no
        reader can see.
      */}
      <p className={styles.note} data-testid="team-period" title={t('team.today')}>
        {t('teamShort.today')}
      </p>

      {agents.length === 0 ? (
        <p className={styles.note} data-testid="team-none">
          {t('team.none')}
        </p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">{t('team.person')}</th>
              {/* "Open now" — a queue depth. NOT "handled", which is what a
                  number beside a name is usually read as. */}
              <th scope="col">{t('team.openNow')}</th>
              <th scope="col">{t('team.takenToday')}</th>
            </tr>
          </thead>
          <tbody>
            {/*
              Alphabetical, deliberately. Sorting by volume would build the
              leaderboard out of the row order even with no outcome column —
              the top of a sorted list reads as the best or worst of
              something, and these numbers support neither claim.
            */}
            {byName(agents).map((agent) => (
              <tr key={agent.agentId} data-testid={`agent-${agent.agentId}`}>
                <th scope="row">{agent.name ?? t('team.unnamed')}</th>
                <td>{format.number(agent.activeConversations)}</td>
                <td>{format.number(agent.claimedToday)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/*
        ★★ THE REPLY-TIME COLUMN WAS HERE AND HAS BEEN REMOVED.

        `avgResponseTimeMs` is written as `now − claim_time` on every agent
        message, and `claim_time` is set once per conversation and never
        cleared. So it measures the distance from one fixed point to each
        reply, and **grows with how long a conversation runs rather than
        with how slow anybody is**.

        Printed beside a person's name it makes whoever handles the long
        difficult cases look slowest — on the screen built not to rank
        anybody. An absent column is better than an unfair one, and the note
        below says it is absent rather than leaving a reader to wonder.
      */}
      {/* One line on the screen; the reason, which matters, is its tooltip. */}
      <p className={styles.note} data-testid="team-no-speed" title={t('team.noSpeed')}>
        {t('teamShort.noSpeed')}
      </p>

      {/*
        ★★ THE ABSENCE A READER WILL NOTICE FIRST.
        The design puts AI employees in this table as colleagues in the
        workload. `where: { role: "AGENT" }` is human users, so they are not
        here — and unstated, the first question is why, and the second is
        whether their work is being counted somewhere invisible.
      */}
      <p className={styles.note} data-testid="team-humans-only" title={t('team.humansOnly')}>
        {t('teamShort.humansOnly')}
      </p>
    </section>
  );
}
