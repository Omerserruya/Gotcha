'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import {
  myshopifyOf,
  type MerchantRequest,
  type RequestRefusal,
} from '@/api/contracts/shopify-private-apps';
import { Input } from '@/design-system/primitives/input/Input';

import styles from './Capabilities.module.css';
import { requestShopifyPrivateApp } from './shopify-private-actions';

/**
 * Connect Shopify before the App Store listing is live (private apps,
 * 2026-11-22), on availability mode `custom_app_request`. Studio's Systems
 * page and onboarding's systems step draw this same card.
 *
 * - No request (or one revoked): the store's myshopify address, checked as
 *   typed ("my-store" → my-store.myshopify.com) and refused before any
 *   request when it still is not a store address.
 * - requested: "we're preparing a private install link; it will reach you by
 *   email".
 * - link_sent: a real button to Shopify's install page, and when it expires.
 *   Expired (the server sends no link then): said, with no dead button.
 * - installed: the store is connected, and that card is the Systems page's own.
 *   Here, nothing.
 * - `undefined`: the request could not be read. Said, and the form is not
 *   offered over a request that may exist.
 */
export function ShopifyPrivateRequest({
  request,
}: {
  readonly request: MerchantRequest | null | undefined;
}) {
  const t = useTranslations('capabilities.shopify.private');
  const format = useFormatter();
  const [address, setAddress] = useState('');
  const [sent, setSent] = useState<MerchantRequest | null | undefined>(request);
  const [refused, setRefused] = useState<RequestRefusal | null>(null);
  const [isPending, startTransition] = useTransition();
  const shop = myshopifyOf(address);

  if (sent === undefined) {
    return (
      <p className={styles.connectNote} role="status" data-testid="shopify-private-unread">
        {t('unread')}
      </p>
    );
  }
  if (sent?.status === 'installed') return null;
  if (sent?.status === 'requested') {
    return (
      <p
        className={styles.connectNote}
        role="status"
        data-testid="shopify-private-sent"
        data-state="requested"
      >
        {t('requested', { shop: sent.shopDomain })}
      </p>
    );
  }
  if (sent?.status === 'link_sent') {
    const expires = sent.linkExpiresAt ? new Date(sent.linkExpiresAt) : null;
    const day =
      expires && !Number.isNaN(expires.getTime())
        ? // Numeric: a month's name can differ between the server's ICU and the browser's (#418).
          format.dateTime(expires, {
            day: 'numeric',
            month: 'numeric',
            year: 'numeric',
            timeZone: 'UTC',
          })
        : null;
    return sent.installLink ? (
      <div className={styles.connectFoot} data-testid="shopify-private-sent" data-state="link_sent">
        <a
          href={sent.installLink}
          className={styles.connectButton}
          rel="noopener noreferrer"
          data-testid="shopify-private-install"
        >
          {t('install', { shop: sent.shopDomain })}
        </a>
        <span className={styles.connectNote}>
          {day ? t('linkReadyUntil', { day }) : t('linkReady')}
        </span>
      </div>
    ) : (
      <p
        className={styles.connectNote}
        role="status"
        data-testid="shopify-private-sent"
        data-state="expired"
      >
        {t('linkExpired', { shop: sent.shopDomain })}
      </p>
    );
  }

  const submit = () => {
    if (!shop) {
      setRefused('invalid_shop_domain');
      return;
    }
    setRefused(null);
    startTransition(async () => {
      const result = await requestShopifyPrivateApp(shop);
      if (result.ok) setSent(result.request);
      else setRefused(result.reason);
    });
  };

  return (
    <form
      className={styles.connectFoot}
      data-testid="shopify-private-request"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {sent?.status === 'revoked' ? (
        <span className={styles.connectNote} data-testid="shopify-private-revoked">
          {t('revoked', { shop: sent.shopDomain })}
        </span>
      ) : null}
      <Input
        label={t('label')}
        hint={t('hint')}
        placeholder="your-store.myshopify.com"
        dir="ltr"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        value={address}
        onChange={(event) => setAddress(event.target.value)}
        error={refused === 'invalid_shop_domain' ? t('error.invalid_shop_domain') : undefined}
        data-testid="shopify-private-address"
      />
      <button
        type="submit"
        className={styles.connectButton}
        disabled={isPending || address.trim() === ''}
        data-testid="shopify-private-submit"
      >
        {isPending ? t('sending') : t('submit')}
      </button>
      {refused && refused !== 'invalid_shop_domain' ? (
        <span className={styles.connectProblem} role="alert" data-testid="shopify-private-problem">
          {t(`error.${refused}`, { shop: shop ?? address.trim() })}
        </span>
      ) : null}
    </form>
  );
}
