import { getTranslations } from 'next-intl/server';

import { loadSecurity } from '@/features/security/load-security';
import { MfaPolicy } from '@/features/security/MfaPolicy';
import styles from '@/features/security/Security.module.css';
import { AuditSection, LoginHistory } from '@/features/security/SecuritySections';
import { SessionList } from '@/features/security/SessionList';
import { pageMetadata } from '@/shell/page-metadata';
import { SettingsSection } from '@/shell/SettingsSection';

/**
 * Settings · Security — screen 16.
 *
 * *"Access control, plus the record of everything that happened — including
 * everything GOTCHA did."*
 *
 * Four sections, four independent reads, four independent failure states. The
 * order is what someone came for: where you are signed in, then who has signed
 * in, then who must prove who they are, then everything that happened.
 *
 * The activity log is last and, today, unavailable — no route serves
 * `AuditLog`, though the AI reads it constantly for its own reasoning. It says
 * so rather than showing an empty list.
 */
export default async function Page() {
  const t = await getTranslations('security');
  const {
    sessions,
    sessionsAvailable,
    logins,
    loginsAvailable,
    tenant,
    audit,
    auditAvailable,
    facets,
    facetsTruncated,
  } = await loadSecurity();

  return (
    <SettingsSection title={t('title')} description={t('description')}>
      <section className={styles.section} data-testid="section-sessions">
        <h2 className={styles.sectionHeading}>{t('heading.sessions')}</h2>
        <SessionList sessions={sessions} available={sessionsAvailable} />
      </section>

      <section className={styles.section} data-testid="section-logins">
        <h2 className={styles.sectionHeading}>{t('heading.logins')}</h2>
        <LoginHistory events={logins} available={loginsAvailable} />
      </section>

      {/*
        Absent rather than disabled when the policy could not be read. An
        unchecked switch would assert that two-factor is NOT required, which is
        a claim about this tenant's security that we have no basis for.
      */}
      {tenant ? (
        <section className={styles.section} data-testid="section-mfa">
          <h2 className={styles.sectionHeading}>{t('heading.mfa')}</h2>
          <MfaPolicy policy={tenant} />
        </section>
      ) : null}

      <section className={styles.section} data-testid="section-audit">
        <h2 className={styles.sectionHeading}>{t('heading.audit')}</h2>
        <AuditSection
          entries={audit}
          available={auditAvailable}
          facets={facets}
          facetsTruncated={facetsTruncated}
        />
      </section>
    </SettingsSection>
  );
}

export const generateMetadata = pageMetadata('settings.security');
