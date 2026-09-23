import { getTranslations } from 'next-intl/server';

import { loadRoles } from '@/features/roles/load-roles';
import { RoleList } from '@/features/roles/RoleList';
import styles from '@/features/roles/Roles.module.css';
import { PageContainer } from '@/shell/PageContainer';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * Settings · People & teams · Roles — screen 12b.
 *
 * ── WHAT IS ABSENT, AND WHY ──
 * **No money limits.** The design describes three roles as allowing *"refunds
 * up to ₪1,000"* and *"up to ₪500"*. `TenantRoleFeature` is `(roleId,
 * feature)` — a composite key with **no other columns**. A role grants
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
 */
export default async function Page() {
  const t = await getTranslations('roles');
  const roles = await loadRoles();

  if (roles === null) {
    return (
      <PageContainer title={t('title')} description={t('description')}>
        <p data-testid="roles-unavailable">{t('unavailable')}</p>
      </PageContainer>
    );
  }

  const custom = roles.filter((role) => !role.isSystem);

  return (
    <PageContainer title={t('title')} description={t('description')}>
      <div className={styles.screen} data-testid="roles-screen">
        {/*
          Stated once, above the list, because the design a reader arrives
          from puts a money limit in three role descriptions.
        */}
        <p className={styles.noLimits} data-testid="no-limits">
          {t('noLimits')}
        </p>

        <RoleList roles={roles} />

        {/*
          Zero custom roles is the state here, and it is worth naming: it
          means every permission anyone has comes from a role nobody chose.
        */}
        {custom.length === 0 ? (
          <div className={styles.empty} data-testid="no-custom-roles">
            <p className={styles.emptyLead}>{t('noCustom')}</p>
            <p className={styles.emptyBody}>{t('noCustomBody')}</p>
          </div>
        ) : null}
      </div>
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('primary.settings');
