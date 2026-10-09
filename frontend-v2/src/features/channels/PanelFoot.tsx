'use client';

import { List, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { Dialog, DialogContent } from '@/design-system/primitives/overlay/Dialog';
import { UnavailableAction } from '@/design-system/primitives/unavailable/Unavailable';
import { Link, useRouter } from '@/i18n/navigation';

import {
  disconnectNumber,
  refreshNumber,
  refreshUnprofiled,
  type UnprofiledRefreshResult,
  type WriteResult,
} from './number-actions';
import styles from './Channels.module.css';

type Refresh = 'idle' | 'done' | Exclude<UnprofiledRefreshResult, { ok: true }>['reason'];

/**
 * 13b's foot, live where a route is (Omer, 2026-10-07: no dead buttons).
 *
 *   Refresh from Meta   each number's health read again from Meta, now;
 *                       then "Updated just now", or why not
 *   Activity log        the Activity tab
 *   Disconnect          one number, by name, after a confirmation that
 *                       says what goes and what stays
 *
 * Both act on numbers GOTCHA keeps a record of. With none (dev's one number
 * is unprofiled) they are a status, saying why; Disconnect with several is
 * too - it names one number, and the foot cannot say which.
 */
export function PanelFoot({
  numbers,
  unprofiled = [],
}: {
  /** Numbers with a record here: the ones refresh and disconnect can act on. */
  readonly numbers: readonly { readonly id: string; readonly phoneNumber: string | null }[];
  /**
   * Channel accounts with no number record (dev's one): Refresh reads them
   * from Meta too (Backend 7131f530); Disconnect still cannot name them.
   */
  readonly unprofiled?: readonly string[];
}) {
  const t = useTranslations('channels.whatsapp');
  const router = useRouter();
  const [refresh, setRefresh] = useState<Refresh>('idle');
  const [refreshing, startRefresh] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [failed, setFailed] = useState<Exclude<WriteResult, { ok: true }>['reason'] | null>(null);
  const [disconnecting, startDisconnect] = useTransition();
  const one = numbers.length === 1 ? numbers[0]! : null;
  const name = one?.phoneNumber ?? t('foot.thisNumber');

  const runRefresh = () =>
    startRefresh(async () => {
      setRefresh('idle');
      let outcome: Refresh = 'done';
      for (const n of numbers) {
        const result = await refreshNumber(n.id);
        if (!result.ok) outcome = result.reason;
      }
      for (const id of unprofiled) {
        const result = await refreshUnprofiled(id);
        if (!result.ok) outcome = result.reason;
      }
      setRefresh(outcome);
      router.refresh();
    });

  return (
    <footer className={styles.panelFoot}>
      {numbers.length === 0 && unprofiled.length === 0 ? (
        <UnavailableAction
          label={t('foot.refresh')}
          tag={t('notYet')}
          why={t('foot.noRecord')}
          testid="whatsapp-foot-refresh"
        />
      ) : (
        <span className={styles.footAction}>
          <button
            type="button"
            className={styles.panelFootLink}
            onClick={runRefresh}
            disabled={refreshing}
            aria-busy={refreshing}
            data-testid="whatsapp-foot-refresh"
          >
            <RefreshCw
              size={13}
              aria-hidden="true"
              className={refreshing ? styles.spinning : undefined}
            />
            {refreshing ? t('foot.refreshing') : t('foot.refresh')}
          </button>
          {refresh !== 'idle' && !refreshing ? (
            <span
              className={refresh === 'done' ? styles.footDone : styles.footProblem}
              role={refresh === 'done' ? 'status' : 'alert'}
              data-testid="whatsapp-foot-refresh-result"
            >
              {t(`foot.refreshResult.${refresh}`)}
            </span>
          ) : null}
        </span>
      )}
      <Link
        href={{ pathname: '/settings/channels', query: { panel: 'whatsapp', tab: 'activity' } }}
        replace
        scroll={false}
        className={styles.panelFootLink}
        data-testid="whatsapp-foot-activity"
      >
        <List size={13} aria-hidden="true" />
        {t('foot.activity')}
      </Link>
      {one ? (
        <button
          type="button"
          className={styles.panelFootDanger}
          onClick={() => {
            setFailed(null);
            setConfirming(true);
          }}
          data-testid="whatsapp-foot-disconnect"
        >
          {t('foot.disconnect')}
        </button>
      ) : (
        <UnavailableAction
          label={t('foot.disconnect')}
          tag={t('notYet')}
          why={
            numbers.length > 0
              ? t('foot.disconnectMany')
              : unprofiled.length > 0
                ? t('foot.noRecordDisconnect')
                : t('foot.noRecord')
          }
          testid="whatsapp-foot-disconnect"
        />
      )}
      {one && confirming ? (
        <Dialog open onOpenChange={(open) => (open ? null : setConfirming(false))}>
          <DialogContent
            title={t('foot.disconnectTitle', { number: name })}
            description={t('foot.disconnectWhat')}
            data-testid="whatsapp-disconnect"
          >
            {failed ? (
              <p
                className={styles.footProblem}
                role="alert"
                data-testid="whatsapp-disconnect-failed"
              >
                {t(`foot.disconnectFailed.${failed}`)}
              </p>
            ) : null}
            <span className={styles.confirmRow}>
              <button
                type="button"
                className={styles.confirmKeep}
                onClick={() => setConfirming(false)}
              >
                {t('foot.disconnectCancel')}
              </button>
              <button
                type="button"
                className={styles.confirmDanger}
                disabled={disconnecting}
                onClick={() =>
                  startDisconnect(async () => {
                    setFailed(null);
                    const result = await disconnectNumber(one.id);
                    if (!result.ok) {
                      setFailed(result.reason);
                      return;
                    }
                    setConfirming(false);
                    router.replace('/settings/channels');
                  })
                }
                data-testid="whatsapp-disconnect-yes"
              >
                {disconnecting
                  ? t('foot.disconnecting')
                  : t('foot.disconnectYes', { number: name })}
              </button>
            </span>
          </DialogContent>
        </Dialog>
      ) : null}
    </footer>
  );
}
