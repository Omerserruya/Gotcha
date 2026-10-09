'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { UnavailableAction } from '@/design-system/primitives/unavailable/Unavailable';
import { useRouter } from '@/i18n/navigation';

import { disconnectSystem, type DisconnectResult } from './connect-actions';
import { disconnectHere } from './oauth';
import styles from './Capabilities.module.css';

/**
 * Disconnect a connected system - confirmed first, and the confirmation says
 * exactly what `POST /api/connectors/:slug/disconnect` does: the row goes
 * DISCONNECTED (so its actions stop - the AI's tools are read only from
 * CONNECTED rows) and the stored credentials are emptied; the per-action
 * settings (`TenantTool`) are left alone.
 *
 * Shopify and the calendars are a status, not a button:
 *   - Shopify is disconnected by removing the app in Shopify (its uninstall
 *     webhook sets the row DISCONNECTED). Neither route here uninstalls the
 *     app or touches its Shopify billing, so a button here could not say
 *     what happens to the merchant's plan.
 *   - A calendar books through its per-employee `CalendarAccount`, which
 *     neither route touches - "disconnected" here would still book.
 */
export function DisconnectSystem({ slug, name }: { readonly slug: string; readonly name: string }) {
  const t = useTranslations('capabilities.disconnect');
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<Exclude<DisconnectResult, { ok: true }>['reason'] | null>(
    null,
  );
  const [isPending, startTransition] = useTransition();
  const where = disconnectHere(slug);

  if (where !== 'here') {
    return (
      <section className={styles.disconnect} data-testid="disconnect">
        <UnavailableAction
          label={t('button', { name })}
          tag={t('notHere')}
          why={t(`why.${where}`, { name })}
          testid="disconnect-unavailable"
        />
      </section>
    );
  }

  return (
    <section className={styles.disconnect} data-testid="disconnect">
      {!confirming ? (
        <button
          type="button"
          className={styles.disconnectButton}
          data-testid="disconnect-start"
          onClick={() => {
            setProblem(null);
            setConfirming(true);
          }}
        >
          {t('button', { name })}
        </button>
      ) : (
        <div className={styles.disconnectConfirm} role="group" aria-label={t('button', { name })}>
          <p className={styles.connectLead} data-testid="disconnect-what">
            {t('confirm', { name })}
          </p>
          <div className={styles.disconnectRow}>
            <button
              type="button"
              className={styles.disconnectButton}
              disabled={isPending}
              data-testid="disconnect-confirm"
              onClick={() =>
                startTransition(async () => {
                  const result = await disconnectSystem(slug);
                  if (result.ok) {
                    setConfirming(false);
                    router.refresh();
                  } else setProblem(result.reason);
                })
              }
            >
              {isPending ? t('working') : t('yes')}
            </button>
            <button
              type="button"
              className={styles.disconnectKeep}
              disabled={isPending}
              data-testid="disconnect-cancel"
              onClick={() => setConfirming(false)}
            >
              {t('keep')}
            </button>
          </div>
        </div>
      )}
      {problem ? (
        <p className={styles.connectProblem} role="alert" data-testid="disconnect-problem">
          {t(`problem.${problem}`, { name })}
        </p>
      ) : null}
    </section>
  );
}
