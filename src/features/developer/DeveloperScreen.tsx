import { getTranslations } from 'next-intl/server';

import styles from './Developer.module.css';

/**
 * 18 — API keys, webhooks, and access for someone outside the team, in 02's
 * shape: a full-width keys card, then webhooks beside the dark access card.
 *
 * Nothing serves any of the three. There is no API-key store, the only
 * webhook table holds INCOMING automation triggers (not endpoints GOTCHA
 * calls), and no role is "API only". So each card is drawn with its "—"
 * and its control present and not live, with why on the title. 02's two
 * foot lines ("Failed deliveries retry for 24 hours…", "Everything they do
 * appears in the security log…") are promises about behaviour that does not
 * exist, so they are not drawn.
 */
export async function DeveloperScreen() {
  const t = await getTranslations('developer');

  return (
    <>
      <section className={styles.card} data-testid="developer-keys">
        <header className={styles.head}>
          <h2 className={styles.title}>{t('keys.title')}</h2>
          <span
            className={styles.primary}
            aria-disabled="true"
            title={t('keys.none')}
            data-testid="developer-new-key"
          >
            {t('keys.new')}
          </span>
        </header>
        <p className={styles.none} title={t('keys.none')} data-testid="developer-keys-none">
          —
        </p>
      </section>

      <div className={styles.row}>
        <section className={styles.card} data-testid="developer-webhooks">
          <header className={styles.head}>
            <h2 className={styles.title}>{t('webhooks.title')}</h2>
            <span
              className={styles.outline}
              aria-disabled="true"
              title={t('webhooks.none')}
              data-testid="developer-add-endpoint"
            >
              {t('webhooks.add')}
            </span>
          </header>
          <p
            className={styles.none}
            title={t('webhooks.none')}
            data-testid="developer-webhooks-none"
          >
            —
          </p>
        </section>

        <section className={styles.access} data-testid="developer-access">
          <h2 className={styles.accessTitle}>{t('access.title')}</h2>
          <p
            className={styles.accessNone}
            title={t('access.none')}
            data-testid="developer-access-none"
          >
            —
          </p>
        </section>
      </div>
    </>
  );
}
