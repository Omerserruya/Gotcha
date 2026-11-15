'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { type PlatformTemplate } from '@/api/contracts/platform-whatsapp';
import { useRouter } from '@/i18n/navigation';

import consoleStyles from '../Console.module.css';
import { alertLabel } from './alert-label';
import { setPlatformAlert, type PlatformWrite } from './platform-whatsapp-actions';
import styles from './PlatformWhatsApp.module.css';

/**
 * Which platform alerts go out on WhatsApp: one switch per alert the route
 * calls `toggleable`, and a line for the two that follow another switch.
 *
 * ★ Turning on is offered only when the route says it can be (`canEnable`:
 *   both languages approved and a number connected); the route refuses it
 *   otherwise (409), and that refusal is said too. Turning off is always
 *   allowed. A switch that is on while nothing can send says so: the value
 *   is kept, and nothing goes out.
 */
export function PlatformAlerts({
  templates,
  canSend,
  hasNumber,
}: {
  readonly templates: readonly PlatformTemplate[];
  /** The sender sends right now (CONNECTED or PENDING_WEBHOOK). */
  readonly canSend: boolean;
  /** A number is linked at all (else "needs a number", not "needs approval"). */
  readonly hasNumber: boolean;
}) {
  const t = useTranslations('console.platformWhatsApp');
  return (
    <section
      className={consoleStyles.card}
      aria-labelledby="platform-alerts"
      data-testid="platform-alerts"
    >
      <h2 id="platform-alerts" className={consoleStyles.cardTitle}>
        {t('alerts.title')}
      </h2>
      <p className={styles.quiet}>{t('alerts.description')}</p>
      <ul className={styles.alerts} role="list">
        {templates.map((template) =>
          template.toggleable ? (
            <AlertRow
              // A new value from the route (Meta switched one off) is a new row.
              key={`${template.eventType}:${template.alertEnabled}`}
              template={template}
              canSend={canSend}
              hasNumber={hasNumber}
            />
          ) : (
            <li
              key={template.eventType}
              className={styles.alert}
              data-testid={`alert-${template.name}`}
            >
              <span className={styles.alertText}>
                {alertLabel(t, template.name)}
                {t.has(`alerts.rides.${template.name}`) ? (
                  <span className={styles.alertWhy}>{t(`alerts.rides.${template.name}`)}</span>
                ) : null}
              </span>
            </li>
          ),
        )}
      </ul>
    </section>
  );
}

function AlertRow({
  template,
  canSend,
  hasNumber,
}: {
  readonly template: PlatformTemplate;
  readonly canSend: boolean;
  readonly hasNumber: boolean;
}) {
  const t = useTranslations('console.platformWhatsApp');
  const router = useRouter();
  const [shown, setShown] = useState(template.alertEnabled);
  const [refusal, setRefusal] = useState<(PlatformWrite & { ok: false })['reason'] | null>(null);
  const [isPending, startTransition] = useTransition();
  const label = alertLabel(t, template.name);
  const id = `alert-${template.name}`;

  // Off and not allowed on: the switch is drawn, and held, with why.
  const held = !shown && !template.canEnable;
  const why = held
    ? hasNumber
      ? t('alerts.needsApproval')
      : t('alerts.needsNumber')
    : shown && !canSend
      ? t('alerts.stopped')
      : null;

  return (
    <li className={styles.alert} data-testid={id}>
      <span className={styles.alertText}>
        {label}
        {why ? (
          <span className={styles.alertWhy} data-testid={`${id}-why`}>
            {why}
          </span>
        ) : null}
      </span>
      <span className={styles.switchWrap}>
        <button
          type="button"
          role="switch"
          aria-checked={shown}
          aria-label={t('alerts.switchLabel', { alert: label })}
          className={styles.switch}
          data-on={shown ? 'yes' : 'no'}
          disabled={isPending || held}
          data-testid={`${id}-switch`}
          onClick={() => {
            const next = !shown;
            setShown(next);
            setRefusal(null);
            startTransition(async () => {
              const done = await setPlatformAlert(template.eventType, next);
              if (done.ok) {
                router.refresh();
              } else {
                setShown(!next);
                setRefusal(done.reason);
              }
            });
          }}
        />
        {refusal ? (
          <span className={consoleStyles.refused} role="alert" data-testid={`${id}-refused`}>
            {t(`refusal.${refusal}`)}
          </span>
        ) : null}
      </span>
    </li>
  );
}
