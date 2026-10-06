import { getTranslations } from 'next-intl/server';

import { loadCatalog } from '@/features/roles/load-catalog';
import { PermissionCatalog } from '@/features/roles/PermissionCatalog';
import styles from '@/features/roles/Roles.module.css';
import { PageContainer } from '@/shell/PageContainer';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * Settings · People & teams · What a role can allow - screen 12c.
 *
 * ── THIS IS A CATALOGUE, NOT THE DESIGN'S GRID, AND THE REASON IS A WRITE ──
 * The design draws one row per area with **None / View / Edit / Manage**, a
 * scope per row and a money limit per row. The platform has sixty-three
 * permissions shaped `domain:feature:action` - `conversation:messages:read ·
 * reply · takeover · assign · close` - where **the action is the level and
 * each is an independent key**.
 *
 * A four-way radio must pick one value to stand for five booleans, so saving
 * an untouched role would drop whatever the levels cannot express. **No
 * error, no warning, and the role now differs from what its owner believes.**
 *
 * `roundTrips` in the contract is the property that justifies this shape, and
 * it is asserted: open a role, change nothing, save, get back what you had.
 *
 * ── AND TWO THINGS SAID ONCE ──
 * **Scope is per role** - one reach for everything the role does. A reader
 * arriving from the mockup expects it per row.
 *
 * **There are no levels.** Meeting sixty-three independent switches without
 * warning reads as a missing feature rather than a different model.
 *
 * Money limits are absent, as on 12b, and are not repeated per row.
 */
export default async function Page() {
  const t = await getTranslations('roles');
  const catalog = await loadCatalog();

  if (catalog === null) {
    return (
      <PageContainer title={t('catalog.heading')}>
        <p data-testid="catalog-unavailable">{t('unavailable')}</p>
      </PageContainer>
    );
  }

  return (
    <PageContainer title={t('catalog.heading')}>
      <div className={styles.screen} data-testid="catalog-screen">
        {/*
          Both said above the list, because both correct a mental model the
          reader arrives with rather than describing what they are looking at.
        */}
        <p className={styles.catalogNote} data-testid="not-levels">
          {t('catalog.notLevels')}
        </p>
        <p className={styles.catalogNote} data-testid="scope-per-role">
          {t('catalog.scopeIsPerRole')}
        </p>

        <PermissionCatalog permissions={catalog.permissions} />
      </div>
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('primary.settings');
