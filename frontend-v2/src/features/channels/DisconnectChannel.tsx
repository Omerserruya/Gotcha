'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { Dialog, DialogContent } from '@/design-system/primitives/overlay/Dialog';
import { useRouter } from '@/i18n/navigation';

import styles from './Channels.module.css';
import { disconnectChannel, type DisconnectResult } from './disconnect-actions';

/**
 * A connected row's Disconnect: a confirmation that names the channel and
 * says what stops and what stays, then `POST /api/channels/:id/disconnect`.
 * Built as 13b's number disconnect (PanelFoot) is.
 */
export function DisconnectChannel({
  id,
  name,
  identity,
}: {
  /** The channel account's id. */
  readonly id: string;
  /** The channel's name in the reader's language: "Instagram", "Email". */
  readonly name: string;
  /** Which account - the address or handle - when the row has one. */
  readonly identity: string | null;
}) {
  const t = useTranslations('channels.disconnect');
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [failed, setFailed] = useState<Exclude<DisconnectResult, { ok: true }>['reason'] | null>(
    null,
  );
  const [disconnecting, startDisconnect] = useTransition();

  return (
    <>
      <button
        type="button"
        className={styles.rowDisconnect}
        aria-label={t('yes', { channel: name })}
        onClick={() => {
          setFailed(null);
          setConfirming(true);
        }}
        data-testid={`channel-disconnect-${id}`}
      >
        {t('action')}
      </button>
      {confirming ? (
        <Dialog open onOpenChange={(open) => (open ? null : setConfirming(false))}>
          <DialogContent
            title={t('title', { channel: name })}
            description={t('what', { channel: name })}
            data-testid={`channel-disconnect-confirm-${id}`}
          >
            {identity ? (
              <p className={styles.detail}>
                <bdi>{identity}</bdi>
              </p>
            ) : null}
            {failed ? (
              <p
                className={styles.footProblem}
                role="alert"
                data-testid={`channel-disconnect-failed-${id}`}
              >
                {t(`failed.${failed}`)}
              </p>
            ) : null}
            <span className={styles.confirmRow}>
              <button
                type="button"
                className={styles.confirmKeep}
                onClick={() => setConfirming(false)}
              >
                {t('cancel')}
              </button>
              <button
                type="button"
                className={styles.confirmDanger}
                disabled={disconnecting}
                onClick={() =>
                  startDisconnect(async () => {
                    setFailed(null);
                    const result = await disconnectChannel(id);
                    if (!result.ok) {
                      setFailed(result.reason);
                      return;
                    }
                    setConfirming(false);
                    router.refresh();
                  })
                }
                data-testid={`channel-disconnect-yes-${id}`}
              >
                {disconnecting ? t('working') : t('yes', { channel: name })}
              </button>
            </span>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
