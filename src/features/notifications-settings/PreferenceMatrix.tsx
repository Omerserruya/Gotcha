import { getFormatter, getTranslations } from 'next-intl/server';

import type { NotificationPreferences } from '@/api/contracts/notifications';

import styles from './Notifications.module.css';
import type { ObservedVolume } from './volume';

/** 02's rows, each tied to the event that sends it — or to none. */
const ROWS = [
  { key: 'approval', event: 'tool.approval_required', approvals: true },
  { key: 'actionFailed', event: null },
  { key: 'systemDown', event: 'integration.check_failed' },
  { key: 'employeeDown', event: null },
  { key: 'complaints', event: null },
  { key: 'campaign', event: 'broadcast.completed' },
  { key: 'assigned', event: 'conversation.assigned' },
] as const;

const CHANNELS = ['inApp', 'email', 'whatsapp'] as const;

/**
 * Screen 15 — "Tell me when" × In app · Email · WhatsApp, measured.
 *
 * ── WHAT A CELL MEANS, BECAUSE THE PLATFORM HAS NO PER-EVENT CHANNELS ──
 * Your preferences are three switches for every event (`inApp`, `email`,
 * `whatsapp`) and one for a single event (`approvals`). So a cell is ON when
 * that channel reaches you at all — and, for approvals, when approvals do.
 * A row with no event behind it ("an action failed", "an AI employee stops
 * working", "complaints spike") sends nothing: its cells are "—", not off.
 * Who is told at all is the workspace's rules (below); these only filter what
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
                {row.event === null ? (
                  <span className={styles.matrixSub}>{t('nothingSends')}</span>
                ) : null}
              </span>
              {CHANNELS.map((channel) => (
                <span key={channel} className={styles.matrixCell}>
                  {row.event === null || preferences === null ? (
                    <span className={styles.matrixNone}>—</span>
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
        <p className={styles.matrixFoot}>{t('foot')}</p>
      </section>

      <div className={styles.prefCards}>
        <section className={styles.prefCard} data-testid="pref-quiet">
          <h2 className={styles.prefTitle}>{t('quiet.title')}</h2>
          <p className={styles.prefValue}>
            {preferences === null
              ? '—'
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
              : t(volume.atLeast ? 'volume.atLeast' : 'volume.about', {
                  n: format.number(volume.perDay),
                })}
          </h2>
          <p className={styles.prefNoteAi}>{t('volume.note', { days: volume?.days ?? 7 })}</p>
        </section>
      </div>
    </>
  );
}
