import { getFormatter, getTranslations } from 'next-intl/server';

import { eventCell, type NotificationPreferences } from '@/api/contracts/notifications';
import { UnavailableStatus } from '@/design-system/primitives/unavailable/Unavailable';
import { Link } from '@/i18n/navigation';

import { DeviceAlerts } from './DeviceAlerts';
import { EventSwitch } from './EventSwitch';
import styles from './Notifications.module.css';
import { PreferenceSwitch } from './PreferenceSwitch';
import { QuietHours } from './QuietHours';
import type { ObservedVolume } from './volume';

/** 02's rows, each tied to the event that sends it - or to none. */
/**
 * `about`: 02's static line under the event - what it covers, not data. The
 * approval row's line in 02 is a count ("3 so far today"); nothing counts it,
 * so it has none.
 */
const ROWS = [
  { key: 'approval', event: 'tool.approval_required', approvals: true },
  // Refund, discount and meeting errors (Backend, 2026-10-08).
  { key: 'actionFailed', event: 'tool.action_failed', about: true },
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
 * foot); these only filter what reaches you.
 *
 * ★ THE SWITCHES ARE WHERE THE PLATFORM HAS THEM: one per channel, in its
 *   column's head ("Email, for everything below"), and approvals on its row.
 *   A switch in every cell would flip a whole column from one cell - the
 *   cells show what reaches you, and change when their switch does.
 *
 * ⚠ WHATSAPP TO A PERSON DOES NOT EXIST (Backend, 2026-10-08): no number to
 *   send from, no templates. Its column is a status, and its cells "-" -
 *   never a mark saying something reaches you that nothing sends.
 * ★ THE FAN-OUT OBEYS THEM (notifications 9164a058): per recipient and
 *   channel - the channel's switch, approvals off on every channel, and
 *   quiet hours (the workspace's time zone): inside them no email is sent
 *   (not held - dropped), the in-app row is still written, and a refund or
 *   discount that failed still emails. With no workspace rule, approvals,
 *   failures and billing reach admins in-app and an assignment its assignee
 *   in-app; email goes only where a rule sends it - the foot says so.
 *
 * ★★ PER EVENT NOW (notifications 63307535; Omer: "the Email column - which
 *   notifications are on by email, with a switch per row"). Each row's In app
 *   and Email cell is that event's own switch for this person - when a route
 *   really reaches them on that channel. One that does not is a quiet "-"
 *   saying so ("not sent by email in this workspace"), never a disabled
 *   switch. The column's switch stays the master: while it is off, the
 *   rows below are off and say so. A service without the matrix keeps the
 *   old read-only cells.
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
        <div className={styles.matrixHead}>
          <span className={styles.matrixEvent}>{t('when')}</span>
          {CHANNELS.map((channel) => (
            <span key={channel} className={styles.matrixHeadCell}>
              <span>{t(`channel.${channel}`)}</span>
              {preferences === null ? null : channel === 'whatsapp' ? (
                <UnavailableStatus
                  tag={t('whatsappUnavailable.tag')}
                  why={t('whatsappUnavailable.why')}
                  testid="pref-switch-whatsapp-unavailable"
                />
              ) : (
                <PreferenceSwitch
                  field={channel}
                  on={preferences[channel]}
                  label={t('channelSwitch', { channel: t(`channel.${channel}`) })}
                />
              )}
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
                {/* The one event the platform lets you switch on its own. */}
                {'approvals' in row && preferences !== null ? (
                  <span className={styles.matrixRowSwitch}>
                    <PreferenceSwitch
                      field="approvals"
                      on={preferences.approvals}
                      label={t('approvalsSwitch')}
                    />
                    <span className={styles.matrixSub}>{t('approvalsSwitch')}</span>
                  </span>
                ) : null}
              </span>
              {CHANNELS.map((channel) => {
                if (row.event === null || preferences === null || channel === 'whatsapp') {
                  return (
                    <span key={channel} className={styles.matrixCell}>
                      <span className={styles.matrixNone}>-</span>
                    </span>
                  );
                }
                const cell = eventCell(preferences, row.event, channel);
                return (
                  <span key={channel} className={styles.matrixCell}>
                    {cell.kind === 'unreachable' ? (
                      <span
                        className={styles.matrixNone}
                        title={t(channel === 'email' ? 'notByEmail' : 'notInApp')}
                        data-testid={`pref-${row.key}-${channel}-none`}
                      >
                        -
                      </span>
                    ) : cell.kind === 'switch' && preferences[channel] ? (
                      <EventSwitch
                        eventType={row.event}
                        channel={channel}
                        on={cell.on && on(row, channel)}
                        label={t('rowSwitch', {
                          channel: t(`channel.${channel}`),
                          event: t(`row.${row.key}`),
                        })}
                        testid={`pref-${row.key}-${channel}-switch`}
                      />
                    ) : (
                      <span
                        className={styles.cellState}
                        role="img"
                        data-on={on(row, channel) ? 'yes' : 'no'}
                        aria-label={`${t(`channel.${channel}`)}: ${on(row, channel) ? t('on') : t('off')}`}
                        title={t('cellWhy')}
                        data-testid={`pref-${row.key}-${channel}`}
                      />
                    )}
                  </span>
                );
              })}
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
          {preferences === null ? (
            <p className={styles.prefValue}>-</p>
          ) : (
            <QuietHours initial={preferences.quietHours} />
          )}
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

      {/* This device's chime and desktop notification for a customer's message. */}
      <DeviceAlerts />
    </>
  );
}
