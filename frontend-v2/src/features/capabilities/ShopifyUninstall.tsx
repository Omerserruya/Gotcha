'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState, useTransition } from 'react';

import { usePathname, useRouter } from '@/i18n/navigation';

import {
  readShopifyConnectorStatus,
  uninstallShopify,
  type ShopifyUninstall,
} from './shopify-actions';
import styles from './Capabilities.module.css';

/** How often, and for how long, the screen asks whether Shopify has confirmed. */
export const UNINSTALL_POLL_MS = 5000;
export const UNINSTALL_POLL_TRIES = 24;

/** The statuses that mean Shopify's webhook landed: the store is no longer installed. */
const GONE = new Set(['uninstalled', 'not_installed']);

/**
 * Disconnect Shopify: ask Shopify to uninstall the GOTCHA app, then WAIT for
 * Shopify to confirm. The request is accepted, not done - only Shopify's signed
 * `app/uninstalled` webhook finishes it - so the screen says "Waiting for
 * Shopify to confirm" until the server's `connector.status` says the store is
 * gone. A reload keeps saying it: the server holds `uninstall_pending`.
 *
 * The old Disconnect was local only. It left the app installed and Shopify
 * billing, and said "Shopify keeps billing until you remove the app".
 */
export function ShopifyUninstall({
  name,
  pending = false,
}: {
  readonly name: string;
  /** The server already says `uninstall_pending`: open on the wait. */
  readonly pending?: boolean;
}) {
  const t = useTranslations('capabilities.disconnect');
  const router = useRouter();
  const pathname = usePathname();
  const [phase, setPhase] = useState<'idle' | 'confirming' | 'awaiting' | 'still'>(
    pending ? 'awaiting' : 'idle',
  );
  const [problem, setProblem] = useState<Extract<ShopifyUninstall, { ok: false }>['reason'] | null>(
    null,
  );
  const [round, setRound] = useState(0);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (phase !== 'awaiting') return;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const ask = async () => {
      const status = await readShopifyConnectorStatus();
      if (stopped) return;
      if (status !== null && GONE.has(status)) {
        router.replace(
          { pathname, query: { system: 'shopify', disconnected: '1' } },
          { scroll: false },
        );
        return;
      }
      tries += 1;
      if (tries >= UNINSTALL_POLL_TRIES) setPhase('still');
      else timer = setTimeout(() => void ask(), UNINSTALL_POLL_MS);
    };
    timer = setTimeout(() => void ask(), UNINSTALL_POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [phase, round, pathname, router]);

  if (phase === 'awaiting' || phase === 'still') {
    return (
      <section className={styles.disconnect} data-testid="disconnect" data-awaiting="">
        <p className={styles.connectLead} role="status" data-testid="disconnect-awaiting">
          {phase === 'awaiting' ? t('shopify.awaiting') : t('shopify.stillWaiting')}
        </p>
        {phase === 'still' ? (
          <button
            type="button"
            className={styles.disconnectKeep}
            data-testid="disconnect-check-again"
            onClick={() => {
              setRound((r) => r + 1);
              setPhase('awaiting');
            }}
          >
            {t('shopify.checkAgain')}
          </button>
        ) : null}
      </section>
    );
  }

  return (
    <section
      className={styles.disconnect}
      data-testid="disconnect"
      data-confirming={phase === 'confirming' ? '' : undefined}
    >
      {phase === 'idle' ? (
        <button
          type="button"
          className={styles.disconnectButton}
          data-testid="disconnect-start"
          onClick={() => {
            setProblem(null);
            setPhase('confirming');
          }}
        >
          {t('button', { name })}
        </button>
      ) : (
        <div className={styles.disconnectConfirm} role="group" aria-label={t('button', { name })}>
          <p className={styles.connectLead} data-testid="disconnect-what">
            {t('confirmShopify', { name })}
          </p>
          <div className={styles.disconnectRow}>
            <button
              type="button"
              className={styles.disconnectButton}
              disabled={isPending}
              data-testid="disconnect-confirm"
              onClick={() =>
                startTransition(async () => {
                  const result = await uninstallShopify();
                  if (result.ok) setPhase('awaiting');
                  else setProblem(result.reason);
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
              onClick={() => setPhase('idle')}
            >
              {t('keep')}
            </button>
          </div>
        </div>
      )}
      {problem ? (
        <p className={styles.connectProblem} role="alert" data-testid="disconnect-problem">
          {t(`shopify.problem.${problem}`)}
        </p>
      ) : null}
    </section>
  );
}
