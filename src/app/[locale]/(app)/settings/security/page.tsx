import { getTranslations } from 'next-intl/server';

import { loadSecurity } from '@/features/security/load-security';
import { MfaPolicy } from '@/features/security/MfaPolicy';
import styles from '@/features/security/Security.module.css';
import { AuditSection, LoginHistory } from '@/features/security/SecuritySections';
import { SessionList } from '@/features/security/SessionList';
import { pageMetadata } from '@/shell/page-metadata';
import { SettingsSection } from '@/shell/SettingsSection';

/**
 * Settings · Security - screen 16.
 *
 * *"Access control, plus the record of everything that happened - including
 * everything GOTCHA did."*
 *
 * Four sections, four independent reads, four independent failure states,
 * laid out as 02 draws them: the sign-in policy beside where you are signed
 * in, then everything that happened. Recent sign-ins are not in 02 and sit
 * last.
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

  /*
    16, measured: sign-in on the left beside where you are signed in, then
    "Everything that happened" - the audit - as one card. Sign-ins (the login
    history) are not in 02 and stay below it: they are this screen's record of
    who got in, which the audit does not carry.
  */
  return (
    <SettingsSection title={t('title')} description={t('description')} fill>
      <div className={styles.topRow}>
        {/*
          The switches are absent when the policy could not be read - an
          unchecked switch would assert that two-factor is NOT required. But
          the card stays, and says so: "we could not find out" is never silent.
        */}
        <section className={styles.card} data-testid="section-mfa">
          <h2 className="srOnly">{t('heading.mfa')}</h2>
          {tenant ? (
            <MfaPolicy policy={tenant} />
          ) : (
            <p className={styles.unavailable} data-testid="mfa-unavailable">
              {t('mfa.unavailable')}
            </p>
          )}
          {/* 02's two more rows. Nothing here reads either: "-", and why. */}
          <div className={styles.policyRow} title={t('policy.googleNone')}>
            <span className={styles.policyText}>
              <span className={styles.policyName}>{t('policy.google')}</span>
            </span>
            <span className={styles.policyNone}>-</span>
          </div>
          <div className={styles.policyRow} title={t('policy.sessionNone')}>
            <span className={styles.policyText}>
              <span className={styles.policyName}>{t('policy.session')}</span>
            </span>
            <span className={styles.policyNone}>-</span>
          </div>
        </section>

        <section className={styles.card} data-testid="section-sessions">
          {/* 02's head: the title, and how many devices - when they could be read. */}
          <header className={styles.cardHead}>
            <h2 className={styles.cardTitle}>{t('heading.sessions')}</h2>
            {sessionsAvailable ? (
              <span className={styles.cardCount} data-testid="sessions-count">
                {t('sessions.count', { count: sessions.length })}
              </span>
            ) : null}
          </header>
          <SessionList sessions={sessions} available={sessionsAvailable} />
        </section>
      </div>

      <section className={styles.auditCard} data-testid="section-audit">
        <AuditSection
          entries={audit}
          available={auditAvailable}
          facets={facets}
          facetsTruncated={facetsTruncated}
        />
      </section>

      <section className={styles.loginsCard} data-testid="section-logins">
        <h2 className={styles.cardTitle}>{t('heading.logins')}</h2>
        <LoginHistory events={logins} available={loginsAvailable} />
      </section>
    </SettingsSection>
  );
}

export const generateMetadata = pageMetadata('settings.security');
