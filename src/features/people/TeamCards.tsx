import { getTranslations } from 'next-intl/server';

import type { Department } from '@/api/contracts/people';

import styles from './People.module.css';

/**
 * Teams — `Department` in the backend.
 *
 * Two things the design draws are absent, both deliberately:
 *
 *   - **"gets WhatsApp, Instagram, web".** `ChannelAccount` carries no
 *     department link. Nothing routes a channel to a team, anywhere.
 *   - **"Escalations go to Tomer first".** `escalationPolicy` has one writer,
 *     fed by an onboarding payload no client populates, and the departments
 *     CRUD route cannot touch it. It is unreachable rather than unpopulated —
 *     which is why there is no "Not set" here either. An affordance offering a
 *     state the product cannot reach sends the reader looking for a control
 *     that exists on no screen.
 *
 * What is left is true: a name, what the team is for, and two counts the
 * backend serves with the list.
 */
export async function TeamCards({ teams }: { readonly teams: readonly Department[] }) {
  const t = await getTranslations('people');

  if (teams.length === 0) {
    return <p className={styles.empty}>{t('teams.none')}</p>;
  }

  return (
    <section className={styles.teams} data-testid="team-cards">
      <h2 className={styles.teamsHeading}>{t('teams.heading')}</h2>
      <ul className={styles.teamList}>
        {teams.map((team) => (
          <li key={team.id} className={styles.teamCard} data-testid={`team-${team.id}`}>
            <div className={styles.teamHead}>
              <span className={styles.teamName}>{team.name}</span>
              {/*
                A team with nobody in it says so, rather than showing nothing.
                Zero members is a real and actionable state - it is the state
                of every team on a tenant that has not finished setting up -
                and an empty meta line would read as a rendering fault.
              */}
              <span className={styles.teamMeta} data-testid={`team-meta-${team.id}`}>
                {t('teams.members', { count: team.memberCount })}
                {' · '}
                {t('teams.open', { count: team.openConversations })}
                {team.isActive ? '' : ` · ${t('teams.inactive')}`}
              </span>
            </div>
            {team.description ? <p className={styles.teamBody}>{team.description}</p> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
