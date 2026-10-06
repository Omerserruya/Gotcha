import { getFormatter, getTranslations } from 'next-intl/server';

import type { NotificationPreferences } from '@/api/contracts/notifications';
import { Link } from '@/i18n/navigation';

import styles from './Notifications.module.css';
import type { ObservedVolume } from './volume';

/** 02's rows, each tied to the event that sends it - or to none. */
/**
 * `about`: 02's static line under the event - what it covers, not data. The
 * approval row's line in 02 is a count ("3 so far today"); nothing counts it,
 * so it has none.
 */
const ROWS = [
  { key: 'approval', event: 'tool.approval_required', approvals: true },
  { key: 'actionFailed', event: null, about: true },
  { key: 'systemDown', event: 'integration.check_failed', about: true },
  { key: 'employeeDown', event: null },
  { key: 'complaints', event: null, about: true },
  { key: 'campaign', event: 'broadcast.completed' },
  { key: 'assigned', event: 'conversation.assigned' },
] as const;

const CHANNELS = ['inApp', 'email', 'whatsapp'] as const;

/**
 * Screen 15 - "Tell me when" × In app · Email · WhatsApp, measured.
 *
 * ── WHAT A CELL MEANS, BECAUSE THE PLATFORM HAS NO PER-EVENT CHANNELS ──
 * Your preferences are three switches for every event (`inApp`, `email`,
 * `whatsapp`) and one for a single event (`approvals`). So a cell is ON when
 * that channel reaches you at all - and, for approvals, when approvals do.
 * A row with no event behind it ("an action failed", "an AI employee stops
 * working", "complaints spike") sends nothing: its cells are "-", not off.
 * Who is told at all is the workspace's rules (their own page, linked from the
 * foot); these only filter what
 * reaches you. Nothing writes preferences from here yet: the switches show
 * the state and say so.
 */
export async function PreferenceMatrix({
  preferences,
  volume,
  whatsappDestination,
}: {
  readonly preferences: NotificationPreferences | null;
  readonly volume: ObservedVolume | null;
  readonly whatsappDestination: string | null;
}) {
  const t = await getTranslations('notifications-settings.matrix');
  const format = await getFormatter();

  const on = (row: (typeof ROWS)[number], channel: (typeof CHANNELS)[number]) =>
    preferences !== null &&
    preferences[channel] &&
    (!('approvals' in row) || preferences.approvals);

  const nothing = volume !== null && volume.count === 0 && !volume.atLeast;

  return (
    <>
      <section className={styles.matrix} data-testid="pref-matrix">
        <div className={styles.matrixHead} aria-hidden="true">
          <span className={styles.matrixEvent}>{t('when')}</span>
          {CHANNELS.map((channel) => (
            <span key={channel} className={styles.matrixCell}>
              {t(`channel.${channel}`)}
            </span>
          ))}
        </div>
        <ul className={styles.matrixRows}>
          {ROWS.map((row) => (
            <li key={row.key} className={styles.matrixRow} data-testid={`pref-row-${row.key}`}>
              <span className={styles.matrixEvent}>
                <span className={styles.matrixName}>{t(`row.${row.key}`)}</span>
                {/*
                  A row nothing sends says so; what it would cover rides on
                  its title. A live row carries 02's line beneath it.
                */}
                {row.event === null ? (
                  <span
                    className={styles.matrixSub}
                    title={'about' in row ? t(`about.${row.key}`) : undefined}
                  >
                    {t('nothingSends')}
                  </span>
                ) : 'about' in row ? (
                  <span className={styles.matrixSub} data-testid={`pref-about-${row.key}`}>
                    {t(`about.${row.key}`)}
                  </span>
                ) : null}
              </span>
              {CHANNELS.map((channel) => (
                <span key={channel} className={styles.matrixCell}>
                  {row.event === null || preferences === null ? (
                    <span className={styles.matrixNone}>-</span>
                  ) : (
                    <span
                      className={styles.switch}
                      role="img"
                      data-on={on(row, channel) ? 'yes' : 'no'}
                      aria-label={`${t(`channel.${channel}`)}: ${on(row, channel) ? t('on') : t('off')}`}
                      title={t('switchNotYet')}
                      data-testid={`pref-${row.key}-${channel}`}
                    />
                  )}
                </span>
              ))}
            </li>
          ))}
        </ul>
        {/* The matrix is not the whole story: the rules are a page of their own. */}
        <p className={styles.matrixFoot}>
          {t.rich('foot', {
            rules: (chunks) => (
              <Link
                href="/settings/notifications/rules"
                className={styles.matrixFootLink}
                data-testid="pref-rules-link"
              >
                {chunks} →
              </Link>
            ),
          })}
        </p>
      </section>

      <div className={styles.prefCards}>
        <section className={styles.prefCard} data-testid="pref-quiet">
          <h2 className={styles.prefTitle}>{t('quiet.title')}</h2>
          <p className={styles.prefValue}>
            {preferences === null
              ? '-'
              : preferences.quietHours
                ? t('quiet.window', preferences.quietHours)
                : t('quiet.none')}
          </p>
          <p className={styles.prefNote}>{t('quiet.note')}</p>
        </section>
        <section className={styles.prefCard} data-testid="pref-whatsapp">
          <h2 className={styles.prefTitle}>{t('whatsapp.title')}</h2>
          <p className={styles.prefValue}>{whatsappDestination ?? t('whatsapp.none')}</p>
          <p className={styles.prefNote}>{t('whatsapp.note')}</p>
        </section>
        <section className={styles.prefCardAi} data-testid="pref-volume">
          <h2 className={styles.prefTitleAi}>
            {volume === null
              ? t('volume.unknown')
              : nothing
                ? t('volume.nothing', { days: volume.days })
                : t(volume.atLeast ? 'volume.atLeast' : 'volume.about', {
                    n: format.number(volume.perDay),
                  })}
          </h2>
          {/* "about 0 a day" is a figure of nothing; the title says the window. */}
          {nothing ? null : (
            <p className={styles.prefNoteAi}>{t('volume.note', { days: volume?.days ?? 7 })}</p>
          )}
        </section>
      </div>
    </>
  );
}
