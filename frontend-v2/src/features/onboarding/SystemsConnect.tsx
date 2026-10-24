'use client';

import { ExternalLink } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import type { Integration } from '@/api/contracts/integrations';
import { siteHost } from '@/api/contracts/onboarding';
import { startOAuth, startWooOAuth } from '@/features/capabilities/connect-actions';
import { ConnectForm } from '@/features/capabilities/ConnectForm';
import type { ShopifyAvailability } from '@/features/capabilities/load-capabilities';
import { startShopifyInstall } from '@/features/capabilities/shopify-actions';

import { connectKind } from './connect-kind';
import styles from './SystemsStep.module.css';

/** Every start from step 2 asks for this flow, so the provider returns HERE. */
const FLOW = 'onboarding_systems';

type StartError =
  'invalid_store' | 'forbidden' | 'failed' | 'not_configured' | 'needs_store' | 'not_here';

/**
 * Step 2's connect: one button that goes to the provider and comes back to
 * this step (`flow=onboarding_systems`). The same server actions as Studio ·
 * Capabilities, so what is sent is the same - only where it lands differs.
 *
 * ★ WooCommerce is one click when the site scan found the store: its address
 *   is the site's, shown beside the button, with "a different address" for a
 *   store that lives elsewhere. Nothing is connected before the owner
 *   approves in the store's own admin.
 * ★ A failed start says what to do next, in place, and keeps the button.
 */
export function SystemsConnect({
  integration,
  name,
  reconnect = false,
  shopify,
  store,
  variant,
}: {
  readonly integration: Integration;
  readonly name: string;
  /** Connected but broken: the way back in, not a first connect. */
  readonly reconnect?: boolean;
  readonly shopify: ShopifyAvailability | null;
  /** The site the scan read - WooCommerce's store address, when it is the store. */
  readonly store: string | null;
  /** `hero`: the detected platform's big button; `row`: a quieter one in the list. */
  readonly variant: 'hero' | 'row';
}) {
  const t = useTranslations('onboarding.systems');
  const kind = connectKind(integration, reconnect);
  const [failed, setFailed] = useState<StartError | null>(null);
  const [isPending, startTransition] = useTransition();
  const knownStore = store ? siteHost(store) : null;
  const [address, setAddress] = useState(knownStore ?? '');
  const [typing, setTyping] = useState(knownStore === null);
  const [formOpen, setFormOpen] = useState(variant === 'hero');

  const go = (
    start: () => Promise<{ ok: true; url: string } | { ok: false; reason: StartError }>,
  ) => {
    setFailed(null);
    startTransition(async () => {
      const result = await start();
      if (result.ok) window.location.assign(result.url);
      else {
        setFailed(result.reason);
        if (result.reason === 'invalid_store') setTyping(true);
      }
    });
  };

  const buttonClass = variant === 'hero' ? styles.connect : styles.connectSmall;
  const label = reconnect ? t('reconnectName', { name }) : t('connectName', { name });
  const button = (onClick: (() => void) | undefined, disabled = false, submit = false) => (
    <button
      type={submit ? 'submit' : 'button'}
      className={buttonClass}
      disabled={isPending || disabled}
      data-testid={`systems-start-${integration.slug}`}
      onClick={onClick}
    >
      {isPending ? t('opening', { name }) : label}
      {variant === 'hero' ? <ExternalLink size={15} strokeWidth={2} aria-hidden="true" /> : null}
    </button>
  );
  const problem = failed ? (
    <p
      className={styles.startProblem}
      role="alert"
      data-testid={`systems-start-problem-${integration.slug}`}
    >
      {t(`startError.${failed}`, { name })}
    </p>
  ) : null;

  if (kind === 'shopify') {
    if (shopify?.mode !== 'listing') {
      return (
        <p className={styles.note} data-testid="systems-shopify-not-here">
          {shopify === null ? t('shopifyUnread') : t('shopifyFromAdmin')}{' '}
          {shopify?.helpUrl ? (
            <a
              href={shopify.helpUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.link}
            >
              {t('shopifyHelp')}
            </a>
          ) : null}
        </p>
      );
    }
    return (
      <div className={styles.launch}>
        {button(() => go(() => startShopifyInstall(FLOW)))}
        {problem}
      </div>
    );
  }

  if (kind === 'oauth') {
    return (
      <div className={styles.launch}>
        {button(() => go(() => startOAuth(integration.slug, undefined, FLOW)))}
        {problem}
      </div>
    );
  }

  if (kind === 'woo') {
    return (
      <form
        className={styles.launch}
        data-testid="systems-woo"
        onSubmit={(e) => {
          e.preventDefault();
          if (!address.trim() || isPending) return;
          go(() => startWooOAuth(address, FLOW));
        }}
      >
        {typing ? (
          <label className={styles.storeField}>
            <span className={styles.storeLabel}>{t('store.label')}</span>
            <input
              className={styles.storeBox}
              value={address}
              dir="ltr"
              inputMode="url"
              autoComplete="url"
              placeholder={t('store.placeholder')}
              data-testid="systems-woo-address"
              onChange={(e) => setAddress(e.target.value)}
            />
          </label>
        ) : null}
        <div className={styles.launchRow}>
          {button(undefined, !address.trim(), true)}
          {!typing && knownStore ? (
            <span className={styles.storeAt} data-testid="systems-woo-store">
              {t.rich('store.at', {
                host: knownStore,
                ltr: (chunks) => <bdi dir="ltr">{chunks}</bdi>,
              })}
              <button
                type="button"
                className={styles.textButton}
                data-testid="systems-woo-change"
                onClick={() => setTyping(true)}
              >
                {t('store.change')}
              </button>
            </span>
          ) : null}
        </div>
        {problem}
      </form>
    );
  }

  if (kind === 'form') {
    return formOpen ? (
      <div className={styles.formWrap}>
        <ConnectForm
          slug={integration.slug}
          name={integration.name}
          fields={integration.authSchema.fields}
          label={label}
        />
      </div>
    ) : (
      <button
        type="button"
        className={buttonClass}
        data-testid={`systems-start-${integration.slug}`}
        onClick={() => setFormOpen(true)}
      >
        {label}
      </button>
    );
  }

  return null;
}
