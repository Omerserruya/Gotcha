'use client';

import { useTranslations } from 'next-intl';

import { useRouter } from '@/i18n/navigation';

import { ConfirmedAction } from './ConfirmedAction';
import styles from './Console.module.css';
import { keepDeleted } from './DeletedNotice';
import { deleteTenant, type DeleteResult } from './edit-actions';
import { useEditRefusal } from './TenantStatusEdit';

/** The System tenant's slug: the route refuses it, so the screen never offers it. */
const SYSTEM_SLUG = 'system';

/**
 * Delete a tenant (Omer, 2026-10-23): permanent and immediate. The last card
 * on the page, in danger tone.
 *
 * The confirm says plainly what goes, asks for the slug typed exactly and a
 * reason. On success the operator lands on the tenants list, where the
 * outcome is said with what is still connected on a provider's side. The
 * System tenant is shown the card with the reason it can't be deleted.
 */
export function TenantDelete({
  tenantId,
  name,
  slug,
}: {
  readonly tenantId: string;
  readonly name: string;
  readonly slug: string;
}) {
  const t = useTranslations('console.edit');
  const refusal = useEditRefusal();
  const router = useRouter();

  return (
    <section
      className={`${styles.card} ${styles.danger}`}
      aria-labelledby="tenant-delete"
      data-testid="tenant-delete"
    >
      <h2 id="tenant-delete" className={styles.cardTitle}>
        {t('delete.title')}
      </h2>
      {slug === SYSTEM_SLUG ? (
        <p className={styles.quiet} data-testid="tenant-delete-system">
          {t('delete.systemTenant')}
        </p>
      ) : (
        <>
          <p className={styles.quiet}>{t('delete.intro')}</p>
          <ConfirmedAction<DeleteResult>
            label={t('delete.label')}
            variant="danger"
            sentences={[t('delete.what', { name }), t('delete.provider')]}
            match={{ label: t('delete.match', { slug }), value: slug }}
            reason={t('reason')}
            yes={t('delete.yes')}
            run={({ reason }) => deleteTenant(tenantId, slug, reason)}
            done={() => t('delete.done', { name })}
            after={(result) => {
              keepDeleted({ name, ...result.deleted });
              router.push('/system/tenants');
            }}
            refused={refusal}
            testid="tenant-delete-submit"
          />
        </>
      )}
    </section>
  );
}
