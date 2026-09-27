import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { loadCatalog } from '@/features/roles/load-catalog';
import { loadPerson } from '@/features/roles/load-person';
import { PersonPanel } from '@/features/roles/PersonPanel';
import { PageContainer } from '@/shell/PageContainer';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * Settings · People · one person — screen 12d.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ `PersonPanel` HAS EXISTED, WITH A TEST, AND NOTHING IMPORTED IT
 * ════════════════════════════════════════════════════════════════════════════
 * Its own header said *"Screen 12d — one person"* and there was no route to it.
 * `settings/people/roles` mounts `RoleForm` and `RoleList` — 12b and 12c — so
 * `roles.spec.ts` photographed two thirds of a family and reported green.
 *
 * The capture looked exactly like the captures behind the complete screens,
 * which is the part worth remembering: **a partial screen and a finished one
 * produce the same kind of evidence.**
 *
 * ── AND 12e's SECOND PATH CAME WITH IT ──
 * `RemovePermission` is inside this panel now, on each ADDED grant. The design
 * describes taking a permission away from one person and only the ADD path
 * (`PermissionCatalog`, on `settings/people/permissions`) was mounted. A remove
 * beside the grant it removes is the only place a reader can see what they are
 * taking away.
 *
 * ⚠ THAT IS A WRITE against a real person on a tenant that sends live traffic.
 * No test and no capture presses it.
 */
export default async function Page({
  params,
}: {
  readonly params: Promise<{ readonly userId: string }>;
}) {
  const t = await getTranslations('roles');
  const { userId } = await params;

  /*
   * Both reads, in parallel, and they fail differently.
   *
   * The person is the subject: without them there is no screen, and `null` from
   * `loadPerson` covers a failed read AND a user who is not there. A 404 is the
   * honest answer to both — inventing an empty person would render a panel
   * asserting they have no overrides, which is a claim about somebody we could
   * not read.
   *
   * The catalogue is decoration by comparison: without it every permission
   * shows its key and says why. So it degrades to an empty list rather than
   * taking the screen with it.
   */
  const [person, catalog] = await Promise.all([loadPerson(userId), loadCatalog()]);

  if (person === null) notFound();

  return (
    <PageContainer title={t('person.title')} description={t('person.description')}>
      <PersonPanel person={person} permissions={catalog?.permissions ?? []} />
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('settings.people');
