'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { startWooOAuth, type WooStart } from './connect-actions';
import styles from './Capabilities.module.css';

/**
 * B: WooCommerce through the store's own approval (backend ecd64c4d) — in
 * place of the key form. Only the store address; the store asks its owner
 * to approve GOTCHA and returns here (`?system=woocommerce&connected=1`).
 */
export function WooConnect({ name }: { readonly name: string }) {
  const t = useTranslations('capabilities.woo');
  const [address, setAddress] = useState('');
  const [failed, setFailed] = useState<Exclude<WooStart, { ok: true }>['reason'] | null>(null);
  const [isPending, startTransition] = useTransition();

  return (
    <form
      className={styles.connectForm}
      data-testid="woo-connect"
      onSubmit={(e) => {
        e.preventDefault();
        if (!address.trim() || isPending) return;
        setFailed(null);
        startTransition(async () => {
          const result = await startWooOAuth(address);
          if (result.ok) window.location.assign(result.url);
          else setFailed(result.reason);
        });
      }}
    >
      <label className={styles.connectField}>
        <span className={styles.connectLabel}>{t('address')}</span>
        <input
          className={styles.connectBox}
          value={address}
          inputMode="url"
          placeholder="https://yourstore.com"
          autoComplete="url"
          data-testid="woo-address"
          onChange={(e) => setAddress(e.target.value)}
        />
      </label>
      <div className={styles.connectFoot}>
        <button
          type="submit"
          className={styles.connectButton}
          disabled={isPending || !address.trim()}
          data-testid="woo-start"
        >
          {isPending ? t('opening') : t('start', { name })}
        </button>
        {failed ? (
          <span className={styles.connectProblem} role="alert" data-testid="woo-problem">
            {t(`error.${failed}`, { name })}
          </span>
        ) : (
          <span className={styles.connectNote}>{t('note')}</span>
        )}
      </div>
    </form>
  );
}
