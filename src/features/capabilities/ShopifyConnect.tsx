'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { useRouter } from '@/i18n/navigation';

import { claimShopifyInstall, startShopifyInstall, type ShopifyClaim } from './shopify-actions';
import styles from './Capabilities.module.css';

/**
 * 10's "Connect Shopify" (backend 98676242). No store is typed — Shopify
 * picks it. Read BEFORE the button: a listing that is not public yet is a
 * sentence (and the operator's help link), never a button that does nothing.
 */
export function ShopifyConnect({
  mode,
  helpUrl,
}: {
  /** `null`: availability was not read. */
  readonly mode: string | null;
  readonly helpUrl: string | null;
}) {
  const t = useTranslations('capabilities.shopify');
  const [failed, setFailed] = useState<'forbidden' | 'failed' | null>(null);
  const [isPending, startTransition] = useTransition();

  if (mode !== 'listing') {
    return (
      <p className={styles.connectNote} data-testid="shopify-not-published">
        {mode === null ? t('unread') : t('startsInShopify')}{' '}
        {helpUrl && mode !== null ? (
          <a href={helpUrl} target="_blank" rel="noopener noreferrer" data-testid="shopify-help">
            {t('help')}
          </a>
        ) : null}
      </p>
    );
  }
  return (
    <div className={styles.connectFoot}>
      <button
        type="button"
        className={styles.connectButton}
        disabled={isPending}
        data-testid="shopify-start"
        onClick={() => {
          setFailed(null);
          startTransition(async () => {
            const result = await startShopifyInstall();
            if (result.ok) window.location.assign(result.url);
            else setFailed(result.reason);
          });
        }}
      >
        {isPending ? t('opening') : t('connect')}
      </button>
      {failed ? (
        <span className={styles.connectProblem} role="alert" data-testid="shopify-problem">
          {t(`error.${failed}`)}
        </span>
      ) : (
        <span className={styles.connectNote}>{t('note')}</span>
      )}
    </div>
  );
}

/**
 * Back from Shopify with a store waiting to be claimed — to replace the one
 * connected now, or one that did not finish. No design yet (Omer): a
 * sentence and a button, in 10's existing shape. Nothing is replaced before
 * the press.
 */
export function ShopifyPending({
  shopDomain,
  replace,
}: {
  readonly shopDomain: string;
  readonly replace: boolean;
}) {
  const t = useTranslations('capabilities.shopify.pending');
  const router = useRouter();
  const [result, setResult] = useState<ShopifyClaim | null>(null);
  const [isPending, startTransition] = useTransition();

  if (result?.ok) {
    return (
      <p className={styles.landing} data-outcome="ok" role="status" data-testid="shopify-claimed">
        {t('done', { shop: shopDomain })}
      </p>
    );
  }
  return (
    <div className={styles.landing} data-outcome="problem" data-testid="shopify-pending">
      <span>
        {replace ? t('replaceLead', { shop: shopDomain }) : t('finishLead', { shop: shopDomain })}
      </span>
      <button
        type="button"
        className={styles.connectButton}
        disabled={isPending}
        data-testid="shopify-claim"
        onClick={() =>
          startTransition(async () => {
            const done = await claimShopifyInstall(replace);
            setResult(done);
            if (done.ok) router.refresh();
          })
        }
      >
        {replace ? t('replace', { shop: shopDomain }) : t('finish', { shop: shopDomain })}
      </button>
      {result && !result.ok ? (
        <span className={styles.connectProblem} role="alert" data-testid="shopify-claim-problem">
          {result.reason === 'another_store_connected' && result.currentShop
            ? t('error.anotherNamed', { current: result.currentShop, shop: shopDomain })
            : t(`error.${result.reason}`, { shop: shopDomain })}
        </span>
      ) : null}
    </div>
  );
}
