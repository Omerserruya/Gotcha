import { getTranslations } from 'next-intl/server';

import { isEditable, isMergedAdmin } from '@/api/contracts/roles';
import { loadCatalog } from '@/features/roles/load-catalog';
import { loadRoles } from '@/features/roles/load-roles';
import { RoleForm } from '@/features/roles/RoleForm';
import { roleNameOf } from '@/features/roles/role-words';
import { Link } from '@/i18n/navigation';
import { pageMetadata } from '@/shell/page-metadata';
import { SettingsSection } from '@/shell/SettingsSection';

/**
 * Settings · People & teams · Edit role - 12b's Edit (Omer, 2026-10-08):
 * the 12c form on one role the server calls `editable` - a custom role, or a
 * built-in one within its ceiling (auth 30d610da).
 *
 * Not editable is said, never a form the server turns down: the merged Admin
 * ("now part of Owner"), and a built-in role while the server keeps built-ins
 * fixed (an older backend, or its kill switch) - with Create role. A role
 * that is gone is said too.
 *
 * The form is keyed on what the role holds, so after "Reset to default" the
 * page's fresh read seeds it again rather than leaving the old selection.
 */
export default async function Page({
  params,
}: {
  readonly params: Promise<{ readonly roleId: string }>;
}) {
  const { roleId } = await params;
  const t = await getTranslations('roles');
  const tp = await getTranslations('people');
  const [roles, catalog] = await Promise.all([loadRoles(), loadCatalog()]);
  const role = roles?.find((r) => r.id === roleId) ?? null;

  return (
    <SettingsSection
      title={t('form.edit.heading')}
      back={{ href: '/settings/people/roles', label: tp('tabs.roles') }}
    >
      {roles === null || catalog === null ? (
        <p data-testid="role-form-unavailable">{t('unavailable')}</p>
      ) : role === null ? (
        <p data-testid="role-edit-missing">{t('form.edit.notHere')}</p>
      ) : isMergedAdmin(role) ? (
        <p data-testid="role-edit-merged">{t('merged')}</p>
      ) : !isEditable(role) ? (
        <p data-testid="role-edit-builtin">
          {t('form.edit.builtIn', {
            name: roleNameOf(role, (key, part) => t(`builtinRole.${key}.${part}`)),
          })}{' '}
          <Link href="/settings/people/roles/new" data-testid="role-edit-create">
            {t('create')}
          </Link>
        </p>
      ) : (
        <RoleForm
          key={`${role.id}:${role.customized}:${role.features.join(',')}`}
          permissions={catalog.permissions}
          roles={roles}
          editing={role}
        />
      )}
    </SettingsSection>
  );
}

export const generateMetadata = pageMetadata('settings.people');
