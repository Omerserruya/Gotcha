import { getLocale, getTranslations } from 'next-intl/server';

import type { AiEmployee, Member } from '@/api/contracts/people';
import type { AgentPresence } from '@/api/contracts/presence';

import { Link } from '@/i18n/navigation';

import styles from './People.module.css';
import { buildRoster, type RosterRow } from './roster';
import { builtinRoleKey } from '@/features/roles/role-words';

/**
 * *"Humans and AI employees in one list."*
 *
 * A SERVER component, and not incidentally. `GET /api/ai-agents` answers the
 * whole `AIAgent` row - system prompts included - and although the contract
 * strips those fields, rendering here means nothing about an AI employee is
 * serialised into the browser payload at all. The table is also entirely
 * read-only: there is no state to own, so making it a client component would
 * ship JavaScript to no end.
 *
 * Two kinds share four columns because operationally they are the same
 * resource. They are told apart by the SHAPE of the avatar as well as its
 * colour - a circle for a person, a rounded square for an employee - so the
 * distinction survives greyscale and a viewer who cannot separate the hues.
 */
export async function PeopleTable({
  members,
  aiEmployees,
  presence,
}: {
  readonly members: readonly Member[];
  readonly aiEmployees: readonly AiEmployee[];
  readonly presence: readonly AgentPresence[];
}) {
  const t = await getTranslations('people');
  const tr = await getTranslations('roles');
  const locale = await getLocale();
  const rows = buildRoster(members, aiEmployees, presence, locale);

  if (rows.length === 0) {
    return <p className={styles.empty}>{t('empty')}</p>;
  }

  const time = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  /**
   * What this row may do.
   *
   * A built-in role is said by its KEY, so a Hebrew reader sees בעלים rather
   * than the English word - never by its name, which would translate a custom
   * role somebody called "Admin". A role the tenant invented is shown in
   * THEIR words: translating it is not ours to do.
   */
  const canDo = (row: RosterRow): string => {
    if (row.kind === 'ai') return t('aiEmployee');
    const key = builtinRoleKey(row.canDoKey);
    if (key) return tr(`builtinRole.${key}.name`);
    return row.canDo ?? t('noRole');
  };

  /** The sub-line under the name: an address for a person, a job for an AI. */
  const subLine = (row: RosterRow): string | null => {
    if (row.kind === 'person') return row.email;
    const key = row.canDo ?? 'custom';
    const known = ['customer_support', 'sales', 'booking', 'billing', 'custom'];
    return known.includes(key) ? t(`aiRole.${key}` as 'aiRole.custom') : key;
  };

  /*
   * "Right now", and the one caption on this screen that is easy to overstate.
   *
   * The count is conversations assigned and NOT CLOSED, which includes
   * WAITING - usually waiting on the customer, not on us. So it means "not
   * finished", never "being handled this second". The design's word was
   * "88 live"; this says "88 open", because the integer does not support the
   * present tense and no amount of correct plumbing would make it.
   */
  const rightNow = (row: RosterRow): { text: string; tone?: string } | null => {
    if (row.kind === 'ai') {
      if (row.dormant) return { text: t('paused'), tone: styles.toneMuted };
      if (row.openConversations == null) return null;
      return { text: t('openConversations', { count: row.openConversations }), tone: '' };
    }

    if (row.dormant) return { text: t('deactivated'), tone: styles.toneMuted };

    const parts: string[] = [];
    let tone: string | undefined = styles.toneMuted;

    if (row.presence === 'AWAY' && row.awayUntil) {
      parts.push(t('awayUntil', { time: time.format(new Date(row.awayUntil)) }));
    } else if (row.presence) {
      parts.push(t(`presence.${row.presence}` as 'presence.ONLINE'));
      if (row.presence === 'ONLINE') tone = styles.toneGood;
      if (row.presence === 'BUSY') tone = styles.toneBusy;
    }

    if (row.openConversations != null) {
      parts.push(t('openConversations', { count: row.openConversations }));
    }
    return parts.length > 0 ? { text: parts.join(' · '), tone } : null;
  };

  return (
    <div className={styles.table} data-testid="people-table">
      {/*
        Headings, not a `<table>`.

        The four columns are one row's worth of facts about a person, read
        left to right - not a grid of values compared down a column, which is
        what table semantics announce and what makes a screen reader offer
        column-by-column navigation. A list of rows is what this is.
      */}
      <div className={styles.head} aria-hidden="true">
        <span className={styles.colPerson}>{t('column.person')}</span>
        <span className={styles.colRole}>{t('column.canDo')}</span>
        <span className={styles.colTeam}>{t('column.team')}</span>
        <span className={styles.colNow}>{t('column.rightNow')}</span>
      </div>

      <ul className={styles.rows}>
        {rows.map((row) => {
          const now = rightNow(row);
          const sub = subLine(row);
          return (
            <li
              key={row.key}
              className={[
                styles.row,
                row.kind === 'ai' ? styles.rowAi : '',
                row.dormant ? styles.rowDormant : '',
              ]
                .join(' ')
                .trim()}
              data-testid={`person-row-${row.id}`}
              data-kind={row.kind}
            >
              <div className={styles.colPerson}>
                <span
                  className={row.kind === 'ai' ? styles.avatarAi : styles.avatar}
                  aria-hidden="true"
                >
                  {row.kind === 'ai' ? 'AI' : row.initials}
                </span>
                <span className={styles.identity}>
                  {/* 12d: a person's name opens their drawer over People. */}
                  {row.kind === 'person' ? (
                    <Link
                      href={{ pathname: '/settings/people', query: { person: row.id } }}
                      className={styles.nameLink}
                      data-testid={`person-name-${row.id}`}
                      scroll={false}
                    >
                      {row.name}
                    </Link>
                  ) : (
                    <span className={styles.name} data-testid={`person-name-${row.id}`}>
                      {row.name}
                    </span>
                  )}
                  {sub ? (
                    <span className={styles.sub} data-testid={`person-sub-${row.id}`}>
                      {sub}
                    </span>
                  ) : null}
                </span>
              </div>

              <span className={styles.colRole} data-testid={`person-role-${row.id}`}>
                {canDo(row)}
              </span>

              {/*
                Several teams are joined rather than truncated: a person who
                belongs to two and is shown one is being described wrongly, and
                the cell is wide enough to say so.
              */}
              <span className={styles.colTeam} data-testid={`person-team-${row.id}`}>
                {row.teams.length > 0 ? (
                  row.teams.join(' · ')
                ) : (
                  <span className={styles.unset}>{t('noTeam')}</span>
                )}
              </span>

              <span
                className={[styles.colNow, now?.tone ?? ''].join(' ').trim()}
                data-testid={`person-now-${row.id}`}
              >
                {now?.text ?? ''}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
