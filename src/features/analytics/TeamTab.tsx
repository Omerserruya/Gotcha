import { getFormatter, getTimeZone, getTranslations } from 'next-intl/server';

import {
  busiestLocalHour,
  humans,
  type AgentLoad,
  type TeamMember,
  type TeamReport,
} from '@/api/contracts/analytics';

import type { TeamData } from './load-analytics';
import styles from './Analytics.module.css';

/**
 * Screen 06c — how the team is doing, without a leaderboard. Measured.
 *
 * The dark card and "The handover works" (824 + 300), a five-figure strip,
 * then one table: people AND AI employees, as 02 wants them — colleagues in
 * the workload, not a separate report.
 *
 * ── THE RULES 06c's PANEL ALREADY KEEPS, KEPT ──
 *   · ALPHABETICAL. A volume sort builds the leaderboard out of row order.
 *   · NO REPLY-TIME COLUMN FROM `avgResponseTimeMs`: it measures distance
 *     from the claim, so it grows with how long a conversation runs, and it
 *     would make whoever takes the hard ones look slowest. "First reply"
 *     and "Resolved" per person are "—" — nothing measures either fairly.
 *   · TODAY'S NUMBERS SAY THEY ARE TODAY'S: open now, taken today.
 *
 * ── THE IMBALANCE IS THE QUEUE'S, NOT A PERSON'S ──
 * The dark card compares conversations open NOW, and says what it measured.
 * It names no speed and no outcome, and offers the routing fix (not live).
 */

/**
 * Who holds the most open conversations against who holds the fewest, among
 * people holding any — or null when the spread is under two to one.
 */
export function imbalance(
  agents: readonly AgentLoad[],
): { readonly heavy: AgentLoad; readonly light: AgentLoad; readonly ratio: number } | null {
  const holding = agents.filter((agent) => agent.activeConversations > 0);
  if (holding.length < 2) return null;
  const sorted = [...holding].sort((a, b) => b.activeConversations - a.activeConversations);
  const heavy = sorted[0]!;
  const light = sorted.at(-1)!;
  const ratio = heavy.activeConversations / light.activeConversations;
  return ratio >= 2 ? { heavy, light, ratio: Math.floor(ratio) } : null;
}

/**
 * What the dark card can truthfully say about the queue — five cases, not
 * two: "spread evenly" across fewer than two people, or across one who holds
 * everything, is true of nothing (measured on dev: one AI employee, no
 * Agent-role people, "spread evenly").
 */
export type QueueState =
  | { readonly kind: 'tooFew' }
  | { readonly kind: 'noneOpen' }
  | { readonly kind: 'oneHoldsAll'; readonly who: AgentLoad }
  | {
      readonly kind: 'uneven';
      readonly heavy: AgentLoad;
      readonly light: AgentLoad;
      readonly ratio: number;
    }
  | { readonly kind: 'even' };

export function queueState(agents: readonly AgentLoad[]): QueueState {
  if (agents.length < 2) return { kind: 'tooFew' };
  const holding = agents.filter((agent) => agent.activeConversations > 0);
  if (holding.length === 0) return { kind: 'noneOpen' };
  if (holding.length === 1) return { kind: 'oneHoldsAll', who: holding[0]! };
  const uneven = imbalance(agents);
  return uneven ? { kind: 'uneven', ...uneven } : { kind: 'even' };
}

/**
 * The header's line says what the table counts — 02's "Last 7 days · three
 * people, two teams". Teams are not modelled; people and AI employees are,
 * and a kind with none is left out rather than said as "0 people".
 */
/** AI employees: the report's when read, else the AI rows of the workload. */
function aiCount(data: TeamData): number {
  return (
    data.report?.members.filter((m) => m.kind === 'ai').length ??
    data.agents?.filter((a) => a.kind === 'ai').length ??
    0
  );
}

export async function teamSubline(data: TeamData): Promise<string> {
  const t = await getTranslations('analytics');
  const parts = [
    data.agents && humans(data.agents).length
      ? t('teamTab.sublinePeople', { count: humans(data.agents).length })
      : null,
    aiCount(data) ? t('teamTab.sublineAi', { count: aiCount(data) }) : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0
    ? t('teamTab.sublineCounted', { who: parts.join(', ') })
    : t('teamTab.subline');
}

export async function TeamHero({ agents }: { readonly agents: readonly AgentLoad[] | null }) {
  const t = await getTranslations('analytics');
  // A queue is compared between PEOPLE; AI employees are assigned, not claiming.
  const state = agents ? queueState(humans(agents)) : null;
  const nameOf = (agent: AgentLoad) => agent.name ?? t('team.unnamed');
  return (
    <section className={styles.gHero} data-testid="team-hero">
      <p className={styles.gHeroEyebrow}>{t('teamTab.hero.eyebrow')}</p>
      <p className={styles.gHeroTitle}>
        {state === null
          ? '—'
          : state.kind === 'uneven'
            ? t.rich('teamTab.hero.uneven', {
                heavy: nameOf(state.heavy),
                light: nameOf(state.light),
                ratio: state.ratio,
                figure: (chunks) => <span className={styles.gHeroAmber}>{chunks}</span>,
              })
            : state.kind === 'oneHoldsAll'
              ? t('teamTab.hero.oneHoldsAll', { who: nameOf(state.who) })
              : t(`teamTab.hero.${state.kind}`)}
      </p>
      {state && (state.kind === 'uneven' || state.kind === 'oneHoldsAll') ? (
        <p className={styles.gHeroLine}>{t('teamTab.hero.measured')}</p>
      ) : null}
      <div className={styles.gActions}>
        <span className={styles.gLight} aria-disabled="true">
          {t('teamTab.hero.rebalance')}
        </span>
        <span className={styles.gDarkOutline} aria-disabled="true">
          {t('teamTab.hero.week')}
        </span>
      </div>
    </section>
  );
}

/** 02's "The handover works": pickup time and bounce-backs. Nothing measures either yet. */
export async function HandoverCard() {
  const t = await getTranslations('analytics');
  return (
    <section className={styles.gStopped} data-testid="team-handover">
      <h2 className={styles.gCardTitle}>{t('teamTab.handover.title')}</h2>
      <p className={styles.gCardBody}>{t('teamTab.handover.none')}</p>
    </section>
  );
}

/**
 * 06c's five cards, from the team report: over every conversation a person
 * replied in. The busiest hour arrives as a UTC histogram and is moved to the
 * workspace's time zone before its peak is taken.
 */
export async function TeamStrip({ data }: { readonly data: TeamData }) {
  const t = await getTranslations('analytics');
  const format = await getFormatter();
  const zone = await getTimeZone();
  const cards = data.report?.cards ?? null;
  const peak = cards ? busiestLocalHour(cards.inboundByHourUtc, zone) : null;
  // A week nobody wrote in: its counts are counts of nothing — "—", as on every tab.
  const quiet =
    cards !== null && cards.handledByPeople === 0 && cards.inboundByHourUtc.every((n) => n === 0);
  const count = (n: number | undefined) =>
    cards === null || quiet || n === undefined ? '—' : format.number(n);
  const cells = [
    { key: 'people', value: count(cards?.handledByPeople) },
    { key: 'firstReply', value: replyTime(cards?.firstReplyMedianMs ?? null, t) },
    { key: 'resolved', value: rate(cards?.resolvedRate ?? null) },
    { key: 'handedBack', value: count(cards?.handedBackToGotcha) },
    { key: 'busiest', value: peak === null ? '—' : `${String(peak).padStart(2, '0')}:00` },
  ] as const;
  return (
    <dl className={styles.gStrip} data-testid="team-strip">
      {cells.map((cell) => (
        <div key={cell.key} className={styles.gCell} data-testid={`team-${cell.key}`}>
          <dt>{t(`teamTab.strip.${cell.key}`)}</dt>
          <dd>{cell.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** "3m", "18s", "1h" — or "—" with nothing measured. */
export function replyTime(
  ms: number | null,
  t: Awaited<ReturnType<typeof getTranslations<'analytics'>>>,
): string {
  if (ms === null) return '—';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return t('kpi.seconds', { n: seconds });
  const minutes = Math.round(seconds / 60);
  return minutes < 60
    ? t('kpi.minutes', { n: minutes })
    : t('kpi.hours', { n: Math.round(minutes / 60) });
}

/** A fraction as 02 writes it: "94%"; `null` (nothing handled) is "—". */
export function rate(fraction: number | null): string {
  return fraction === null ? '—' : `${Math.round(fraction * 100)}%`;
}

function initials(name: string | null): string {
  return (name ?? '')
    .split(/\s+/)
    .filter((word) => /\p{L}/u.test(word))
    .slice(0, 2)
    .map((word) => word.match(/\p{L}/u)?.[0]?.toUpperCase() ?? '')
    .join('');
}

/**
 * 06c's table, 02's columns: Person · Handled · First reply · Resolved · Load
 * through the week. People first, then AI employees (violet, with no reply
 * target — decided), each alphabetical. A week's bars are scaled within their
 * kind: an AI employee's thousands would flatten every person's week.
 */
export async function TeamTable({ report }: { readonly report: TeamReport | null }) {
  const t = await getTranslations('analytics');
  const format = await getFormatter();
  const people = report ? report.members.filter((m) => m.kind === 'human').sort(alphabetical) : [];
  const ais = report ? report.members.filter((m) => m.kind === 'ai').sort(alphabetical) : [];
  const peak = (members: readonly TeamMember[]) =>
    Math.max(1, ...members.flatMap((m) => m.loadByDay));
  const row = (member: TeamMember, busiest: number) => (
    <li
      key={member.id}
      className={styles.tRow}
      data-ai={member.kind === 'ai' ? '' : undefined}
      data-testid={`team-row-${member.id}`}
    >
      <span className={styles.tWho}>
        <span
          className={styles.tDisc}
          data-ai={member.kind === 'ai' ? '' : undefined}
          aria-hidden="true"
        >
          {member.kind === 'ai' ? 'AI' : initials(member.name)}
        </span>
        {member.kind === 'ai' ? (
          <span className={styles.tNameStack}>
            <span className={styles.tName}>{member.name ?? t('team.unnamed')}</span>
            <span className={styles.tRole}>{t('teamTab.table.aiEmployee')}</span>
          </span>
        ) : (
          <span className={styles.tName}>{member.name ?? t('team.unnamed')}</span>
        )}
      </span>
      <span>{format.number(member.handled)}</span>
      <span>{replyTime(member.firstReplyMedianMs, t)}</span>
      <span>{rate(member.resolvedRate)}</span>
      <span
        className={styles.tLoad}
        role="img"
        aria-label={t('teamTab.table.loadLabel', { days: member.loadByDay.join(', ') })}
      >
        {member.loadByDay.map((n, day) => (
          <span
            key={day}
            className={styles.tLoadDay}
            data-ai={member.kind === 'ai' ? '' : undefined}
            data-load={n > 0 ? '' : undefined}
            style={
              n > 0 ? { blockSize: `${Math.max(2, Math.round((n / busiest) * 26))}px` } : undefined
            }
          />
        ))}
      </span>
    </li>
  );

  return (
    <section className={styles.tTable} data-testid="team-table">
      <div className={styles.tHead} aria-hidden="true">
        <span>{t('teamTab.table.person')}</span>
        <span>{t('teamTab.table.handled')}</span>
        <span>{t('teamTab.table.firstReply')}</span>
        <span>{t('teamTab.table.resolved')}</span>
        <span>{t('teamTab.table.load')}</span>
      </div>
      <div className={styles.tRows}>
        {report === null ? (
          <p className={styles.gNone} data-testid="team-unavailable">
            {t('team.unavailable')}
          </p>
        ) : people.length === 0 && ais.length === 0 ? (
          <p className={styles.gNone} data-testid="team-none">
            {t('teamShort.none')}
          </p>
        ) : (
          <ul className={styles.tList}>
            {people.map((m) => row(m, peak(people)))}
            {ais.map((m) => row(m, peak(ais)))}
          </ul>
        )}
      </div>
      <p className={styles.tFoot} data-testid="team-foot">
        {t('teamTab.table.foot')}
      </p>
    </section>
  );
}

function alphabetical(a: TeamMember, b: TeamMember): number {
  return (a.name ?? '').localeCompare(b.name ?? '');
}

/** A null figure's reason, in words, for its title. */
export function nullReason(
  agent: AgentLoad,
  field: 'claimedToday',
  t: Awaited<ReturnType<typeof getTranslations<'analytics'>>>,
): string | undefined {
  const reason = agent[field] === null ? agent.nullReasons[field] : undefined;
  if (!reason) return undefined;
  return t.has(`team.nullReason.${reason}`)
    ? t(`team.nullReason.${reason}` as 'team.nullReason.ai_does_not_claim')
    : undefined;
}
