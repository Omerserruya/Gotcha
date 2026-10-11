import { getTranslations } from 'next-intl/server';

import { loadCatalog } from '@/features/roles/load-catalog';
import { loadRoles } from '@/features/roles/load-roles';
import { RoleForm } from '@/features/roles/RoleForm';
import { pageMetadata } from '@/shell/page-metadata';
import { SettingsSection } from '@/shell/SettingsSection';

/**
 * Settings · People & teams · New role - screen 12c, a page of its own, as
 * 02 draws it: "← Roles" above "New role". It starts from Agent; "Start from"
 * picks another (12b has no Duplicate: Omer, 2026-10-11).
 *
 * Without the catalogue there is nothing to grant, so the page says so
 * rather than offering a role of no permissions.
 */
export default async function Page() {
  const t = await getTranslations('roles');
  const tp = await getTranslations('people');
  const [roles, catalog] = await Promise.all([loadRoles(), loadCatalog()]);

  return (
    <SettingsSection
      title={t('form.heading')}
      back={{ href: '/settings/people/roles', label: tp('tabs.roles') }}
    >
      {roles === null || catalog === null ? (
        <p data-testid="role-form-unavailable">{t('unavailable')}</p>
      ) : (
        <RoleForm permissions={catalog.permissions} roles={roles} />
      )}
    </SettingsSection>
  );
}

export const generateMetadata = pageMetadata('settings.people');
