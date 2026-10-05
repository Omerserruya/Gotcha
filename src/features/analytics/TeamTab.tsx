import { getFormatter, getTranslations } from 'next-intl/server';

import { busiestHour, byName, humans, type AgentLoad } from '@/api/contracts/analytics';
import type { AiEmployee } from '@/api/contracts/people';

import { hadConversations } from './figures';
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
/** AI employees: the employee list when read, else the AI rows of the workload. */
function aiCount(data: TeamData): number {
  return data.aiEmployees?.length ?? data.agents?.filter((a) => a.kind === 'ai').length ?? 0;
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
 * ⚠ "Busiest hour" from `/hourly`, whose hours are UTC; the formatter carries
 * the configured time zone, so 09:00Z reads as 12:00 in Israel.
 */
export async function TeamStrip({ data }: { readonly data: TeamData }) {
  const t = await getTranslations('analytics');
  const format = await getFormatter();
  const peak = data.hourly ? busiestHour(data.hourly) : null;
  const cells = [
    {
      key: 'people',
      // No figure of nothing: with no conversations, "—" — see `hadConversations`.
      value: hadConversations(data.overview)
        ? format.number(data.overview!.humanHandledCount)
        : '—',
    },
    // Not separable from GOTCHA's in what the platform measures.
    { key: 'firstReply', value: '—' },
    { key: 'resolved', value: '—' },
    { key: 'handedBack', value: '—' },
    {
      key: 'busiest',
      value: peak
        ? format.dateTime(peak, { hour: '2-digit', minute: '2-digit', hour12: false })
        : '—',
    },
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

function initials(name: string | null): string {
  return (name ?? '')
    .split(/\s+/)
    .filter((word) => /\p{L}/u.test(word))
    .slice(0, 2)
    .map((word) => word.match(/\p{L}/u)?.[0]?.toUpperCase() ?? '')
    .join('');
}

/** People and AI employees in one table, alphabetical within each. */
export async function TeamTable({
  agents,
  aiEmployees,
}: {
  readonly agents: readonly AgentLoad[] | null;
  readonly aiEmployees: readonly AiEmployee[] | null;
}) {
  const t = await getTranslations('analytics');
  const format = await getFormatter();
  const week = Array.from({ length: 7 }, (_, index) => index);
  const load = (
    <span className={styles.tLoad} aria-hidden="true">
      {week.map((day) => (
        <span key={day} className={styles.tLoadDay} />
      ))}
    </span>
  );
  /*
    People and AI employees in one table (backend e188ce7c sends both). An
    AI employee the read carries has its real open count; one only in the
    employee list (none open, say) is drawn from it — never twice.
  */
  const people = agents ? byName(agents) : [];
  const counted = new Set(people.filter((a) => a.kind === 'ai').map((a) => a.agentId));
  const ais = aiEmployees
    ? [...aiEmployees]
        .filter((ai) => !counted.has(ai.id))
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];

  return (
    <section className={styles.tTable} data-testid="team-table">
      <div className={styles.tHead} aria-hidden="true">
        <span>{t('teamTab.table.person')}</span>
        <span>{t('teamTab.table.open')}</span>
        <span>{t('teamTab.table.today')}</span>
        <span>{t('teamTab.table.firstReply')}</span>
        <span>{t('teamTab.table.resolved')}</span>
        <span>{t('teamTab.table.load')}</span>
      </div>
      <div className={styles.tRows}>
        {agents === null && aiEmployees === null ? (
          <p className={styles.gNone} data-testid="team-unavailable">
            {t('team.unavailable')}
          </p>
        ) : people.length === 0 && ais.length === 0 ? (
          <p className={styles.gNone} data-testid="team-none">
            {t('teamShort.none')}
          </p>
        ) : (
          <ul className={styles.tList}>
            {people.map((agent) => (
              <li
                key={agent.agentId}
                className={styles.tRow}
                data-ai={agent.kind === 'ai' ? '' : undefined}
                data-testid={`team-row-${agent.agentId}`}
              >
                <span className={styles.tWho}>
                  <span
                    className={styles.tDisc}
                    data-ai={agent.kind === 'ai' ? '' : undefined}
                    aria-hidden="true"
                  >
                    {agent.kind === 'ai' ? 'AI' : initials(agent.name)}
                  </span>
                  {agent.kind === 'ai' ? (
                    <span className={styles.tNameStack}>
                      <span className={styles.tName}>{agent.name ?? t('team.unnamed')}</span>
                      <span className={styles.tRole}>{t('teamTab.table.aiEmployee')}</span>
                    </span>
                  ) : (
                    <span className={styles.tName}>{agent.name ?? t('team.unnamed')}</span>
                  )}
                </span>
                <span>{format.number(agent.activeConversations)}</span>
                <span title={nullReason(agent, 'claimedToday', t)}>
                  {agent.claimedToday === null ? '—' : format.number(agent.claimedToday)}
                </span>
                <span>—</span>
                <span>—</span>
                {load}
              </li>
            ))}
            {ais.map((ai) => (
              <li key={ai.id} className={styles.tRow} data-ai="" data-testid={`team-row-${ai.id}`}>
                <span className={styles.tWho}>
                  <span className={styles.tDisc} data-ai="" aria-hidden="true">
                    AI
                  </span>
                  <span className={styles.tNameStack}>
                    <span className={styles.tName}>{ai.name}</span>
                    <span className={styles.tRole}>{t('teamTab.table.aiEmployee')}</span>
                  </span>
                </span>
                {/* Nothing counts an AI employee's conversations per employee yet. */}
                <span>—</span>
                <span>—</span>
                <span>—</span>
                <span>—</span>
                {load}
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className={styles.tFoot} data-testid="team-foot">
        {t('teamTab.table.foot')}
      </p>
    </section>
  );
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
