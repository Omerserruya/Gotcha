import { getTranslations } from 'next-intl/server';

import { loadCatalog } from '@/features/roles/load-catalog';
import { loadRoles } from '@/features/roles/load-roles';
import { RoleForm } from '@/features/roles/RoleForm';
import { roleNameOf } from '@/features/roles/role-words';
import { Link } from '@/i18n/navigation';
import { pageMetadata } from '@/shell/page-metadata';
import { SettingsSection } from '@/shell/SettingsSection';

/**
 * Settings · People & teams · Edit role - 12b's Edit (Omer, 2026-10-08):
 * the 12c form on one custom role. A built-in role is not edited (the route
 * refuses it) - said, with Create role; a role that is gone is said too.
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
      ) : role.isSystem ? (
        <p data-testid="role-edit-builtin">
          {t('form.edit.builtIn', {
            name: roleNameOf(role, (key, part) => t(`builtinRole.${key}.${part}`)),
          })}{' '}
          <Link href="/settings/people/roles/new" data-testid="role-edit-create">
            {t('create')}
          </Link>
        </p>
      ) : (
        <RoleForm permissions={catalog.permissions} roles={roles} editing={role} />
      )}
    </SettingsSection>
  );
}

export const generateMetadata = pageMetadata('settings.people');
