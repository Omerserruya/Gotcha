import { getFormatter, getTranslations } from 'next-intl/server';

import type { AgentPresence } from '@/api/contracts/presence';
import type { Team } from '@/api/contracts/team';
import { Text } from '@/design-system/primitives/text/Text';
import { Link } from '@/i18n/navigation';

import styles from './Home.module.css';

/**
 * "Your team right now".
 *
 * Workload and availability arrive separately — `/api/analytics/agents` knows
 * how much each person is carrying, `/api/agents/presence` knows whether they
 * are there — and are joined here on `agentId`.
 *
 * The backend derives presence at read time, so a stale row already reads
 * OFFLINE and an elapsed away window already reads ONLINE. Nothing here has to
 * reason about freshness.
 *
 * One thing is still not an action: `rebalance`. Reassignment is
 * per-conversation, so it navigates into Inbox rather than pretending to
 * redistribute a queue. And the observation at the foot is derived here rather
 * than fetched — the backend has no such signal, but "one person is carrying
 * most of the queue" is arithmetic over data already in hand, and it is the
 * most useful line on the panel.
 */
export async function TeamPanel({
  team,
  presence,
}: {
  /** `null`: the read failed. */
  team: Team | null;
  presence: ReadonlyMap<string, AgentPresence>;
}) {
  const t = await getTranslations('home.team');
  const format = await getFormatter();
  /*
    `/api/analytics/agents` lists users with the AGENT role only, so a
    workspace run by its admins has nobody here: drawn, "—", and why.
  */
  if (team === null || team.length === 0) {
    return (
      <section className={styles.queueCard} data-testid="team-panel">
        <div className={styles.teamBody}>
          <div className={styles.sectionHeader}>
            <Text role="label" as="h2">
              {t('title')}
            </Text>
          </div>
          <p
            className={styles.emptyNote}
            title={team === null ? t('unavailable') : t('none')}
            data-testid="team-none"
          >
            —
          </p>
        </div>
      </section>
    );
  }
  const imbalance = findImbalance(team);
  const online = team.filter((member) => presence.get(member.agentId)?.status === 'ONLINE').length;

  return (
    <section className={styles.queueCard} data-testid="team-panel">
      <div className={styles.teamBody}>
        <div className={styles.sectionHeader}>
          <Text role="label" as="h2">
            {t('title')}
          </Text>
          <Text role="micro" tone="subtle" as="span">
            {t('online', { count: online })}
          </Text>
        </div>

        <ul className={styles.teamList} role="list">
          {team.map((member) => (
            <li key={member.agentId} className={styles.teamRow}>
              <span className={styles.avatarSmall} aria-hidden="true">
                {initials(member.name ?? member.email ?? '?')}
              </span>
              <span className={styles.teamText}>
                <Text role="meta" as="span" truncate>
                  {member.name ?? member.email ?? member.agentId}
                </Text>
                <Text role="micro" tone="subtle" as="span">
                  {secondLine(t, format, member, presence.get(member.agentId))}
                </Text>
              </span>
              {/*
                The dot carries availability, and the row's text always says
                the same thing in words — colour is never the only carrier.
              */}
              <span
                className={[styles.presenceDot, presenceClass(presence.get(member.agentId))]
                  .filter(Boolean)
                  .join(' ')}
                aria-hidden="true"
              />
            </li>
          ))}
        </ul>

        {imbalance ? (
          <p className={styles.teamNote}>
            {t('imbalance', { name: imbalance.name })}{' '}
            {/* Not a rebalance action: reassignment is per-conversation, so
                this goes to the Inbox filtered to that person. */}
            <Link href="/inbox?view=active" className={styles.inlineLink}>
              {t('rebalance')}
            </Link>
          </p>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Whoever is carrying at least double the median load.
 *
 * Median rather than mean so one very busy person does not raise the bar
 * enough to hide themselves. Silent unless the gap is real — an observation
 * that appears every day stops being read.
 */
function findImbalance(team: Team): { name: string } | null {
  if (team.length < 3) return null;

  const loads = team.map((member) => member.activeConversations).sort((a, b) => a - b);
  const median = loads[Math.floor(loads.length / 2)] ?? 0;
  if (median === 0) return null;

  const heaviest = [...team].sort((a, b) => b.activeConversations - a.activeConversations)[0];
  if (!heaviest || heaviest.activeConversations < median * 2) return null;

  return { name: heaviest.name ?? heaviest.email ?? heaviest.agentId };
}

/**
 * The row's second line.
 *
 * Someone away until a stated time is described by that, not by their queue —
 * "away until 11:00" answers the question a colleague is actually asking.
 * Everyone else is described by load.
 */
function secondLine(
  t: Awaited<ReturnType<typeof getTranslations<'home.team'>>>,
  format: Awaited<ReturnType<typeof getFormatter>>,
  member: Team[number],
  presence: AgentPresence | undefined,
): string {
  if (presence?.status === 'AWAY' && presence.awayUntil) {
    const until = new Date(presence.awayUntil);
    if (!Number.isNaN(until.getTime())) {
      return t('awayUntil', {
        /*
         * ★★ THE PAGE'S CLOCK, NOT THE SERVER'S.
         *
         * This was `toLocaleTimeString(undefined, …)` in a SERVER component,
         * so `undefined` resolved to Node's locale — `en-US` here — for every
         * reader. On a Hebrew page it printed **`02:30 PM`** beside `14:30`
         * times drawn through this same formatter elsewhere on the screen.
         *
         * And it would not have been read as a bug: a 12-hour clock next to
         * 24-hour ones inside one Hebrew screenshot looks like an
         * inconsistent design, and it would have been filed against the
         * panel. That is the expensive kind of wrong evidence — not obviously
         * broken, quietly wrong in a way a reviewer rationalises.
         */
        time: format.dateTime(until, { hour: '2-digit', minute: '2-digit', hour12: false }),
      });
    }
  }
  return t('load', {
    open: member.activeConversations,
    reply: formatReply(member.avgResponseTimeMs),
  });
}

function presenceClass(presence: AgentPresence | undefined): string | undefined {
  switch (presence?.status) {
    case 'ONLINE':
      return styles.presenceOnline;
    case 'BUSY':
    case 'AWAY':
      return styles.presenceAway;
    default:
      return undefined;
  }
}

function initials(from: string): string {
  return from
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

/** Minutes, because "replies in 3m" is the unit the design speaks in. */
function formatReply(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  const minutes = Math.round(ms / 60_000);
  return minutes < 1 ? '<1m' : `${minutes}m`;
}
