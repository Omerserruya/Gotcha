import { getTranslations } from 'next-intl/server';

import { InviteForm } from '@/features/people/InviteForm';
import { PeopleTabs } from '@/features/people/PeopleTabs';
import styles from '@/features/people/People.module.css';
import { GrantPicker } from '@/features/roles/GrantPicker';
import { loadCatalog } from '@/features/roles/load-catalog';
import { loadPerson, loadViewerId } from '@/features/roles/load-person';
import { loadRoles } from '@/features/roles/load-roles';
import { PersonPanel } from '@/features/roles/PersonPanel';
import { roleNameOf } from '@/features/roles/role-words';
import { Link } from '@/i18n/navigation';
import { loadPeople } from '@/features/people/load-people';
import { PeopleTable } from '@/features/people/PeopleTable';
import { TeamCards } from '@/features/people/TeamCards';
import { pageMetadata } from '@/shell/page-metadata';
import { Drawer } from '@/shell/Drawer';
import { InterfaceLanguageSelect } from '@/shell/InterfaceLanguageSelect';
import { SettingsSection } from '@/shell/SettingsSection';

/**
 * Settings · People & teams - screen 12.
 *
 * *"Humans and AI employees in one list, because operationally they are the
 * same resource."* One list, three reads, and a failure in one does not blank
 * the others - an admin who can still see their colleagues is better served
 * than one shown a single error for the whole page.
 *
 * The description line is DATA, not copy: how many people, employees and teams
 * there are. It is the first thing the design says and the first thing an
 * admin checks.
 */
export default async function Page({
  searchParams,
}: {
  readonly searchParams?: Promise<{
    readonly tab?: string;
    readonly invite?: string;
    /** 12d: whose drawer is open. */
    readonly person?: string;
    /** 12e: the add-permission panel over it. */
    readonly grant?: string;
  }>;
} = {}) {
  const t = await getTranslations('people');
  const tr = await getTranslations('roles');
  const params = (await searchParams) ?? {};
  const [{ members, aiEmployees, teams, presence }, roles, person, catalog, viewerId] =
    await Promise.all([
      loadPeople(),
      loadRoles(),
      params.person ? loadPerson(params.person) : Promise.resolve(null),
      // 12e's picker, and the invite's role list ("*" patterns expand against it).
      params.person || params.invite === '1' ? loadCatalog() : Promise.resolve(null),
      // 12d: whether the open drawer is the viewer's own.
      params.person ? loadViewerId() : Promise.resolve(null),
    ]);
  const member = person ? (members?.find((m) => m.id === person.id) ?? null) : null;
  const role = member?.roleId ? (roles?.find((r) => r.id === member.roleId) ?? null) : null;
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
    view the tab names. The Teams view has no invite (Omer, 2026-10-11):
    inviting is the People tab's, where the row it opens lives.
  */
  return (
    <SettingsSection
      title={t('title')}
      description={summary ?? t('description')}
      actions={
        tab === 'teams' ? undefined : (
          <Link
            href={{ pathname: '/settings/people', query: { invite: '1' } }}
            className={styles.headerAction}
            data-testid="invite-open"
          >
            {t('invite.open')}
          </Link>
        )
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
          <InviteForm
            teams={teams ?? []}
            open={params.invite === '1'}
            roles={roles}
            catalog={catalog ? catalog.permissions.map((p) => p.key) : null}
          />
          {members && aiEmployees ? (
            <PeopleTable members={members} aiEmployees={aiEmployees} presence={presence} />
          ) : (
            <p>{members ? t('aiUnavailable') : t('membersUnavailable')}</p>
          )}
          {/* 02: the team cards sit under the list, as well as on their own tab. */}
          {teams ? <TeamCards teams={teams} /> : null}
        </>
      )}

      {/*
        12d over People, and 12e over 12d. A person who cannot be read opens
        nothing - the roster stays, rather than a drawer of dashes about
        somebody unknown.
      */}
      {person ? (
        <Drawer
          title={person.name ?? person.email}
          line={person.email}
          closeHref="/settings/people"
          width={600}
          testId="drawer-person"
          lead={
            <span className={styles.drawerDisc} aria-hidden="true" data-testid="person-disc">
              {initialsOf(person.name ?? person.email)}
            </span>
          }
        >
          <PersonPanel
            person={person}
            permissions={catalog?.permissions ?? []}
            member={member}
            role={role}
            roles={roles}
            // Their own interface language, and only theirs: it is personal.
            ownLanguage={
              viewerId !== null && person.id === viewerId ? <InterfaceLanguageSelect /> : null
            }
          />
          {params.grant === '1' ? (
            <GrantPicker
              person={person}
              permissions={catalog?.permissions ?? []}
              roleName={
                role
                  ? roleNameOf(role, (key, part) => tr(`builtinRole.${key}.${part}`))
                  : (member?.roleName ?? null)
              }
            />
          ) : null}
        </Drawer>
      ) : null}
    </SettingsSection>
  );
}

/** The roster's own initials: first letters of the first two words. */
function initialsOf(name: string): string {
  const words = name
    .trim()
    .split(/[\s@._-]+/)
    .filter(Boolean);
  return (
    words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? '?').slice(0, 2)
  ).toUpperCase();
}

export const generateMetadata = pageMetadata('settings.people');
