import { getLocale } from 'next-intl/server';

import { redirect } from '@/i18n/navigation';
import { loadPermissions } from '@/shell/load-permissions';
import { PermissionSet } from '@/permissions/permission-set';
import { STUDIO_SECTIONS } from '@/shell/navigation';

/**
 * ★★ S1 (Omer, 2026-10-14): Studio has no landing page - clicking Studio
 * opens AI employees. A person who may not see employees lands on the first
 * Studio area they may see, in the sidebar's order, by the same permission
 * set the sidebar uses (read once per request, `load-permissions.ts`).
 *
 * The sidebar keeps "Studio" lit on every /studio/* page, so the redirect no
 * longer costs what the old index guarded against. Permissions that could not
 * be read gate nothing - as the sidebar does - so that case opens employees,
 * and the page there says what it says.
 */
export default async function Page() {
  const [{ permissions, roleKey, status }, locale] = await Promise.all([
    loadPermissions(),
    getLocale(),
  ]);
  const held = new PermissionSet(permissions, roleKey);
  const first =
    STUDIO_SECTIONS.find(
      (area) => !area.permission || status !== 'loaded' || held.has(area.permission),
    ) ?? STUDIO_SECTIONS[0]!;
  redirect({ href: first.href ?? '/studio/employees', locale });
}
