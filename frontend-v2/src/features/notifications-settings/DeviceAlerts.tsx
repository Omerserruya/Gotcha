'use client';

import { useTranslations } from 'next-intl';
import { useId, useState, useSyncExternalStore } from 'react';

import { sharedChime } from '@/lib/inbound-alerts/chime';
import {
  SERVER_DEVICE_ALERTS,
  desktopPermission,
  deviceAlertsSnapshot,
  readDeviceAlerts,
  requestDesktopPermission,
  subscribeDesktopPermission,
  subscribeDeviceAlerts,
  writeDeviceAlerts,
  type DesktopPermission,
} from '@/lib/inbound-alerts/settings';

import styles from './Notifications.module.css';

/**
 * The incoming-message alerts of THIS device: a chime (on unless switched
 * off) and a desktop notification (off until turned on, and the browser
 * allows it). Kept in the browser, not on the person - see
 * `lib/inbound-alerts/settings.ts` for why.
 *
 * The desktop switch is on only when it is set AND the browser grants it: a
 * switch that says on while the browser blocks it would promise a
 * notification nothing can show. Turning it on asks the browser, from the
 * click itself (browsers ignore a request without one).
 */
export function DeviceAlerts() {
  const t = useTranslations('notifications-settings.device');
  const { settings, kept } = useSyncExternalStore(
    subscribeDeviceAlerts,
    deviceAlertsSnapshot,
    () => SERVER_DEVICE_ALERTS,
  );
  const permission = useSyncExternalStore<DesktopPermission | null>(
    subscribeDesktopPermission,
    desktopPermission,
    // Unknown on the server: the switch is drawn once the browser answers.
    () => null,
  );
  const id = useId();
  const [asking, setAsking] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const desktopOn = settings.desktop && permission === 'granted';
  const desktopUnavailable = permission === 'unsupported' || permission === 'denied';

  return (
    <section className={styles.deviceCard} data-testid="pref-device">
      <h2 className={styles.prefTitle}>{t('title')}</h2>

      <div className={styles.deviceRow}>
        <button
          type="button"
          role="switch"
          aria-checked={settings.sound}
          aria-labelledby={`${id}-sound`}
          className={styles.switch}
          data-on={settings.sound ? 'yes' : 'no'}
          data-testid="pref-device-sound"
          onClick={() => {
            const next = !settings.sound;
            writeDeviceAlerts({ ...settings, sound: next });
            // Turned on: heard once, now - the click is the gesture the browser wants.
            if (next) sharedChime().playFromGesture();
          }}
        />
        <span className={styles.deviceText}>
          <span id={`${id}-sound`} className={styles.deviceLabel}>
            {t('sound.label')}
          </span>
          <span className={styles.prefNote}>{t('sound.about')}</span>
        </span>
      </div>

      <div className={styles.deviceRow}>
        <button
          type="button"
          role="switch"
          aria-checked={desktopOn}
          aria-labelledby={`${id}-desktop`}
          aria-describedby={desktopUnavailable ? `${id}-state` : undefined}
          className={styles.switch}
          data-on={desktopOn ? 'yes' : 'no'}
          data-testid="pref-device-desktop"
          disabled={permission === null || desktopUnavailable || asking}
          onClick={() => {
            setDismissed(false);
            if (desktopOn) {
              writeDeviceAlerts({ ...settings, desktop: false });
              return;
            }
            if (permission === 'granted') {
              writeDeviceAlerts({ ...settings, desktop: true });
              return;
            }
            setAsking(true);
            void requestDesktopPermission().then((answer) => {
              setAsking(false);
              // Read again: the sound switch may have moved while the browser asked.
              writeDeviceAlerts({ ...readDeviceAlerts().settings, desktop: answer === 'granted' });
              setDismissed(answer === 'default');
            });
          }}
        />
        <span className={styles.deviceText}>
          <span id={`${id}-desktop`} className={styles.deviceLabel}>
            {t('desktop.label')}
          </span>
          <span className={styles.prefNote}>{t('desktop.about')}</span>
          {permission === 'denied' || permission === 'unsupported' ? (
            <span
              id={`${id}-state`}
              className={styles.deviceState}
              role="status"
              data-testid="pref-device-desktop-state"
            >
              {permission === 'denied' ? t('desktop.blocked') : t('desktop.unsupported')}
            </span>
          ) : dismissed ? (
            <span
              className={styles.deviceState}
              role="status"
              data-testid="pref-device-desktop-state"
            >
              {t('desktop.notAllowed')}
            </span>
          ) : null}
        </span>
      </div>

      <p className={styles.prefNote}>{t('quiet')}</p>
      <p className={styles.prefNote} data-testid="pref-device-kept">
        {kept ? t('note') : t('notKept')}
      </p>
    </section>
  );
}
