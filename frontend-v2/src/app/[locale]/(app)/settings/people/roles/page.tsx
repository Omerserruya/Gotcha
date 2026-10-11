import { getLocale, getTranslations } from 'next-intl/server';

import { loadRoles } from '@/features/roles/load-roles';
import { RoleList } from '@/features/roles/RoleList';
import { loadPeople } from '@/features/people/load-people';
import peopleStyles from '@/features/people/People.module.css';
import { PeopleTabs } from '@/features/people/PeopleTabs';
import { Link, redirect } from '@/i18n/navigation';
import { SettingsSection } from '@/shell/SettingsSection';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * Settings · People & teams · Roles - screen 12b.
 *
 * ── WHAT IS ABSENT, AND WHY ──
 * **No money limits.** The design describes three roles as allowing *"refunds
 * up to ₪1,000"* and *"up to ₪500"*. `TenantRoleFeature` is `(roleId,
 * feature)` - a composite key with **no other columns**. A role grants
 * `billing.refund` or it does not, and no amount is stored or enforced
 * anywhere.
 *
 * Writing the limit on screen would be the quiet-hours failure again: a
 * number a reader would act on that no code path reads. So the screen says
 * outright that roles carry no limits, because a reader arriving from that
 * design expects one and would otherwise assume the cap lives somewhere else.
 *
 * **No per-role prose for custom roles.** A built-in role carries the
 * platform's own description; one a tenant creates has whatever they typed.
 * Generating a sentence from a permission list would read as a promise about
 * behaviour rather than a summary of settings.
 *
 * **No tiles to People and to AI employees** under the table, and no
 * Duplicate on a built-in role (Omer, 2026-10-11). A role of your own starts
 * from Create role, whose "Start from" copies any role.
 *
 * **No foot saying built-in roles can't be changed** (auth 30d610da): they
 * can, within their ceilings, wherever the list says `editable`.
 */
export default async function Page({
  searchParams,
}: {
  readonly searchParams?: Promise<{ readonly create?: string }>;
} = {}) {
  const t = await getTranslations('roles');
  const tp = await getTranslations('people');
  const params = (await searchParams) ?? {};
  // 12c is its own page now; old addresses land on it.
  if (params.create === '1') {
    redirect({ href: '/settings/people/roles/new', locale: await getLocale() });
  }
  const [roles, { members, aiEmployees, teams }] = await Promise.all([loadRoles(), loadPeople()]);

  // The same header as 12 - 12b is People & teams with Roles open.
  const summary =
    members && aiEmployees && teams
      ? tp('summary', { people: members.length, ai: aiEmployees.length, teams: teams.length })
      : tp('description');

  return (
    <SettingsSection
      title={tp('title')}
      description={summary}
      actions={
        <Link
          href="/settings/people/roles/new"
          className={peopleStyles.headerAction}
          data-testid="role-create-open"
        >
          {t('create')}
        </Link>
      }
    >
      <PeopleTabs
        current="roles"
        counts={{
          people: members ? members.length : null,
          roles: roles ? roles.length : null,
          teams: teams ? teams.length : null,
        }}
      />

      {roles === null ? (
        <p data-testid="roles-unavailable">{t('unavailable')}</p>
      ) : (
        <RoleList roles={roles} members={members} />
      )}
    </SettingsSection>
  );
}

export const generateMetadata = pageMetadata('primary.settings');
