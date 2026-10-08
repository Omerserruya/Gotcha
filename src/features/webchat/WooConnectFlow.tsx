'use client';

import { Plug } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState, useSyncExternalStore, useTransition } from 'react';

import type { WooConnectRead } from './load-woo-connect';
import styles from './WooConnect.module.css';
import {
  bindWooPlugin,
  startWooPluginStore,
  type WooBind,
  type WooStoreStart,
} from './woo-plugin-actions';

/** What WordPress sent: the site, its settings page to return to, and its nonce. */
export interface WooLink {
  readonly site: string;
  readonly returnUrl: string;
  readonly nonce: string;
}

/** Kept across the store's own approval, which comes back with none of it (§2.1). */
export const WOO_LINK_KEY = 'gotcha:woo-connect';

/** The store's approval answers with these (woocommerce-oauth WOO_ERROR_CODES). */
const BACK_ERRORS = ['denied', 'insufficient_permissions'] as const;

const host = (url: string) => (URL.canParse(url) ? new URL(url).host.toLowerCase() : '');

/**
 * A link WordPress could have sent: an http(s) site, and a way back on the
 * same host under `/wp-admin/` - what the route will check (§2.3). Anything
 * else is not offered a button that can only fail.
 */
export function linkOf(asked: {
  readonly site: string | null;
  readonly returnUrl: string | null;
  readonly nonce: string | null;
}): WooLink | null {
  const { site, returnUrl, nonce } = asked;
  if (!site || !returnUrl || !nonce) return null;
  if (!URL.canParse(site) || !URL.canParse(returnUrl)) return null;
  const s = new URL(site);
  const r = new URL(returnUrl);
  if (!/^https?:$/.test(s.protocol) || !/^https?:$/.test(r.protocol)) return null;
  if (r.host.toLowerCase() !== s.host.toLowerCase() || !r.pathname.includes('/wp-admin/')) {
    return null;
  }
  return { site, returnUrl, nonce };
}

/** The kept link, raw: a string is a stable snapshot. `''` when none (or no storage). */
function rememberedRaw(): string {
  try {
    return window.sessionStorage.getItem(WOO_LINK_KEY) ?? '';
  } catch {
    return '';
  }
}

function parseRemembered(raw: string): WooLink | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<WooLink>;
    return linkOf({
      site: value.site ?? null,
      returnUrl: value.returnUrl ?? null,
      nonce: value.nonce ?? null,
    });
  } catch {
    return null;
  }
}

function remember(link: WooLink | null) {
  try {
    if (link) window.sessionStorage.setItem(WOO_LINK_KEY, JSON.stringify(link));
    else window.sessionStorage.removeItem(WOO_LINK_KEY);
  } catch {
    // Private mode: the round-trip through the store's approval asks for Connect again.
  }
}

/**
 * ★★ "Connect to GOTCHA" from the WooCommerce plugin (woocommerce-plugin-v1
 * §2), the page between WordPress and back.
 *
 * 1. The store approves GOTCHA first, if this workspace has no WooCommerce
 *    connection - the existing key flow, which comes back here.
 * 2. Connect: the web chat is created if the workspace has none, then a
 *    one-time code is made for the plugin, and the browser goes back to the
 *    plugin's settings page, on the store's own address.
 *
 * Nothing happens on arrival: a link can be followed by anyone, so the
 * person sees which site and which workspace before pressing anything.
 *
 * ⚠ v2 has no workspace switcher: the page names the workspace it will
 *   connect, and says how to choose another.
 */
export function WooConnectFlow({
  asked,
  back,
  workspace,
  store: initialStore,
  hasWidget,
}: WooConnectRead & {
  readonly asked: {
    readonly site: string | null;
    readonly returnUrl: string | null;
    readonly nonce: string | null;
  };
  /** `'connected'` / an error code from the store's approval; `null`: not back from it. */
  readonly back: string | null;
}) {
  const t = useTranslations('channels.wooConnect');
  const fromWordPress = linkOf(asked);
  // `null` on the server: the session is looked in on the client only.
  const kept = useSyncExternalStore(noSubscription, rememberedRaw, () => null);
  const link: WooLink | null | undefined =
    fromWordPress ?? (kept === null ? undefined : parseRemembered(kept));
  const [store, setStore] = useState(initialStore);
  const [result, setResult] = useState<WooBind | WooStoreStart | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (fromWordPress) remember(fromWordPress);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on arrival
  }, []);

  if (link === undefined) return <Frame />;
  if (link === null) {
    return (
      <Frame>
        <p className={styles.problem} role="alert" data-testid="woo-connect-incomplete">
          {t('incomplete')}
        </p>
      </Frame>
    );
  }

  const site = host(link.site);
  const storeState =
    back === 'connected'
      ? 'this'
      : store === null
        ? 'unknown'
        : store === 'none'
          ? 'none'
          : host(store) === site
            ? 'this'
            : 'other';
  const backError =
    back && back !== 'connected'
      ? (BACK_ERRORS as readonly string[]).includes(back)
        ? back
        : 'other'
      : null;

  const approve = () =>
    startTransition(async () => {
      const done = await startWooPluginStore(link.site);
      setResult(done);
      if (done.ok) window.location.assign(done.url);
    });
  const connect = () =>
    startTransition(async () => {
      const done = await bindWooPlugin(link, { createWidget: hasWidget === false });
      setResult(done);
      if (done.ok) {
        remember(null);
        window.location.assign(done.redirect);
      } else if (done.reason === 'store_not_connected') {
        setStore('none');
      }
    });

  return (
    <Frame>
      <h1 className={styles.title} data-testid="woo-connect-title">
        {t('title', { site })}
      </h1>
      <p className={styles.line} data-testid="woo-connect-workspace">
        {workspace ? t('workspace', { workspace }) : t('workspaceUnread')}
      </p>
      <p className={styles.hint}>{t('otherWorkspace')}</p>

      {backError ? (
        <p className={styles.problem} role="alert" data-testid="woo-connect-back-error">
          {t(`back.${backError}`)}
        </p>
      ) : null}

      <ol className={styles.steps}>
        <li data-done={storeState === 'this' ? '' : undefined} data-testid="woo-connect-store">
          {storeState === 'this'
            ? t('store.this', { site })
            : storeState === 'other'
              ? t('store.other', { store: host(store as string), site })
              : storeState === 'none'
                ? t('store.none', { site })
                : t('store.unknown', { site })}
        </li>
        {hasWidget === false ? (
          <li data-testid="woo-connect-widget">{t('widget.create')}</li>
        ) : null}
        <li>{t('returnStep')}</li>
      </ol>

      {result && !result.ok ? (
        <p className={styles.problem} role="alert" data-testid="woo-connect-problem">
          {t(`problem.${result.reason}`)}
        </p>
      ) : null}

      <div className={styles.actions}>
        {storeState === 'none' ? (
          <button
            type="button"
            className={styles.primary}
            disabled={isPending}
            onClick={approve}
            data-testid="woo-connect-approve"
          >
            {isPending ? t('opening') : t('approve', { site })}
          </button>
        ) : storeState === 'other' ? null : (
          <button
            type="button"
            className={styles.primary}
            disabled={isPending}
            onClick={connect}
            data-testid="woo-connect-yes"
          >
            {isPending ? t('connecting') : t('connect')}
          </button>
        )}
        <a className={styles.secondary} href={link.returnUrl} data-testid="woo-connect-cancel">
          {t('cancel')}
        </a>
      </div>
    </Frame>
  );
}

const noSubscription = () => () => {};

function Frame({ children }: { readonly children?: React.ReactNode }) {
  return (
    <main className={styles.page}>
      <section className={styles.card} data-testid="woo-connect">
        <span className={styles.mark} aria-hidden="true">
          <Plug size={16} />
        </span>
        {children}
      </section>
    </main>
  );
}
