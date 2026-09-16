import { getTranslations } from 'next-intl/server';

import { InviteForm } from '@/features/people/InviteForm';
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
export default async function Page() {
  const t = await getTranslations('people');
  const { members, aiEmployees, teams, presence } = await loadPeople();

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

  return (
    <SettingsSection title={t('title')} description={summary ?? t('description')}>
      {/*
        Above the roster, because it is what an admin came here to do on a
        tenant this empty — and it needs the teams, so a failed teams read
        means inviting without one rather than not inviting at all.
      */}
      <InviteForm teams={teams ?? []} />
      {members && aiEmployees ? (
        <PeopleTable members={members} aiEmployees={aiEmployees} presence={presence} />
      ) : (
        <p>{members ? t('aiUnavailable') : t('membersUnavailable')}</p>
      )}
      {teams ? <TeamCards teams={teams} /> : <p>{t('teamsUnavailable')}</p>}
    </SettingsSection>
  );
}

export const generateMetadata = pageMetadata('settings.people');
