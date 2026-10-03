import { getTranslations } from 'next-intl/server';

import { InviteForm } from '@/features/people/InviteForm';
import { PeopleTabs } from '@/features/people/PeopleTabs';
import styles from '@/features/people/People.module.css';
import { loadRoles } from '@/features/roles/load-roles';
import { Link } from '@/i18n/navigation';
import { loadPeople } from '@/features/people/load-people';
import { PeopleTable } from '@/features/people/PeopleTable';
import { TeamCards } from '@/features/people/TeamCards';
import { pageMetadata } from '@/shell/page-metadata';
import { SettingsSection } from '@/shell/SettingsSection';

/**
 * Settings · People & teams — screen 12.
 *
 * *"Humans and AI employees in one list, because operationally they are the
 * same resource."* One list, three reads, and a failure in one does not blank
 * the others — an admin who can still see their colleagues is better served
 * than one shown a single error for the whole page.
 *
 * The description line is DATA, not copy: how many people, employees and teams
 * there are. It is the first thing the design says and the first thing an
 * admin checks.
 */
export default async function Page({
  searchParams,
}: {
  readonly searchParams?: Promise<{ readonly tab?: string; readonly invite?: string }>;
} = {}) {
  const t = await getTranslations('people');
  const params = (await searchParams) ?? {};
  const [{ members, aiEmployees, teams, presence }, roles] = await Promise.all([
    loadPeople(),
    loadRoles(),
  ]);
  const tab = params.tab === 'teams' ? 'teams' : 'people';

  /*
   * The count line is only honest when every part of it loaded. A read that
   * failed would otherwise be reported as a zero, and "no AI employees" is a
   * very different thing to tell an owner than "we could not ask".
   */
  const summary =
    members && aiEmployees && teams
      ? t('summary', {
          people: members.length,
          ai: aiEmployees.length,
          teams: teams.length,
        })
      : undefined;

  /*
    12, measured: the header with "Invite someone" on the right (it opens the
    inline invite row, `?invite=1`), then People · Roles · Teams, then the
    view the tab names.
  */
  return (
    <SettingsSection
      title={t('title')}
      description={summary ?? t('description')}
      actions={
        <Link
          href={{ pathname: '/settings/people', query: { invite: '1' } }}
          className={styles.headerAction}
          data-testid="invite-open"
        >
          {t('invite.open')}
        </Link>
      }
    >
      <PeopleTabs
        current={tab}
        counts={{
          people: members ? members.length : null,
          roles: roles ? roles.length : null,
          teams: teams ? teams.length : null,
        }}
      />
      {tab === 'teams' ? (
        teams ? (
          <TeamCards teams={teams} />
        ) : (
          <p>{t('teamsUnavailable')}</p>
        )
      ) : (
        <>
          {/* It needs the teams: a failed teams read means inviting without one. */}
          <InviteForm teams={teams ?? []} open={params.invite === '1'} />
          {members && aiEmployees ? (
            <PeopleTable members={members} aiEmployees={aiEmployees} presence={presence} />
          ) : (
            <p>{members ? t('aiUnavailable') : t('membersUnavailable')}</p>
          )}
        </>
      )}
    </SettingsSection>
  );
}

export const generateMetadata = pageMetadata('settings.people');
