'use client';

import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, useTransition } from 'react';

import { Link, usePathname, useRouter } from '@/i18n/navigation';

import {
  claimShopifyInstall,
  startShopifyInstall,
  verifyShopifyBilling,
  type ShopifyBillingCheck,
  type ShopifyClaim,
} from './shopify-actions';
import styles from './Capabilities.module.css';

/**
 * 10's "Connect Shopify" (backend 98676242). No store is typed - Shopify
 * picks it. Read BEFORE the button: a listing that is not public yet is a
 * sentence (and the operator's help link), never a button that does nothing.
 *
 * ★ GOTCHA Core first (Omer, 2026-10-28): a store can be connected only once
 * Core is paid. The server decides (`core.allowsShopifyConnect`, the rule
 * the claim enforces) and the button waits on its word; if the word was not
 * read, the button stays and the server's 402 `core_plan_required` is said.
 */
export function ShopifyConnect({
  mode,
  helpUrl,
  connectAllowed = null,
}: {
  /** `null`: availability was not read. */
  readonly mode: string | null;
  readonly helpUrl: string | null;
  /** `false`: the server says GOTCHA Core must be paid first. `null`: not said. */
  readonly connectAllowed?: boolean | null;
}) {
  const t = useTranslations('capabilities.shopify');
  const tc = useTranslations('billing.connector');
  const [failed, setFailed] = useState<'forbidden' | 'failed' | 'core_plan_required' | null>(null);
  const [isPending, startTransition] = useTransition();

  if (connectAllowed === false) {
    return (
      <p className={styles.connectNote} data-testid="shopify-core-first">
        {tc('coreFirst')}{' '}
        <Link href="/settings/billing/plan" data-testid="shopify-core-first-link">
          {tc('coreFirstLink')}
        </Link>
      </p>
    );
  }

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
 * Back from Shopify with `pending=1`: a store waiting to be claimed - to
 * replace the one connected now, or one that did not finish - or, when the
 * page found no approval, why there is nothing to claim. No design yet
 * (Omer): a sentence and a button, in 10's existing shape. Nothing is
 * replaced before the press.
 *
 * ★ ONE component for all three, holding what the claim did (prod,
 *   2026-10-29). A successful claim spends the cookie and revalidates the
 *   page, which then reads "no approval" - and when this was two components,
 *   the page swapped the claimed banner for "That approval has expired or was
 *   already used" right after a claim that worked. Here an ok claim is said,
 *   whatever the page reads after it; "gone" is only what the page found on
 *   arrival. Then the browser leaves the pending URL: to Shopify's plan page
 *   when the server owes one, else this page without `pending` - where the
 *   store's state is the server's to say.
 */
export function ShopifyPending({
  pending,
  replace,
  helpUrl,
}: {
  /** The server's read on arrival: the store's domain, `'gone'`, or `null` (unread). */
  readonly pending: string | 'gone' | null;
  readonly replace: boolean;
  readonly helpUrl: string | null;
}) {
  const t = useTranslations('capabilities.shopify.pending');
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const [result, setResult] = useState<ShopifyClaim | null>(null);
  const [claimed, setClaimed] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const shopDomain = typeof pending === 'string' && pending !== 'gone' ? pending : null;
  /* `reason=claim` that met another store: the question becomes "replace it?". */
  const conflict = result && !result.ok && result.reason === 'another_store_connected';
  const replacing = replace || Boolean(conflict);

  const claim = () => {
    if (shopDomain === null) return;
    startTransition(async () => {
      const done = await claimShopifyInstall(replacing);
      setResult(done);
      if (!done.ok) return;
      setClaimed(shopDomain);
      // A plan is owed: Shopify's page is the next step, so go there.
      if (done.planSelectionUrl) {
        window.location.assign(done.planSelectionUrl);
        return;
      }
      // Off the pending URL: the approval is spent, and the page says the store's state.
      const rest = new URLSearchParams(search.toString());
      rest.delete('pending');
      rest.delete('reason');
      const query = rest.toString();
      router.replace(query ? `${pathname}?${query}` : pathname);
    });
  };

  if (claimed !== null) {
    return (
      <p className={styles.landing} data-outcome="ok" role="status" data-testid="shopify-claimed">
        {t('done', { shop: claimed })}
      </p>
    );
  }
  if (shopDomain === null) {
    return <ShopifyPendingGone read={pending === 'gone'} helpUrl={helpUrl} />;
  }
  return (
    <div className={styles.landing} data-outcome="problem" data-testid="shopify-pending">
      <span data-testid="shopify-pending-lead">
        {conflict
          ? result.currentShop
            ? t('conflictNamed', { current: result.currentShop })
            : t('conflict')
          : replace
            ? t('replaceLead', { shop: shopDomain })
            : t('finishLead', { shop: shopDomain })}
      </span>
      <button
        type="button"
        className={styles.connectButton}
        disabled={isPending}
        data-testid="shopify-claim"
        onClick={claim}
      >
        {conflict
          ? t('replaceIt')
          : replace
            ? t('replace', { shop: shopDomain })
            : t('finish', { shop: shopDomain })}
      </button>
      {result && !result.ok && !conflict ? (
        <span className={styles.connectProblem} role="alert" data-testid="shopify-claim-problem">
          {result.reason === 'another_store_connected' && result.currentShop
            ? t('error.anotherNamed', { current: result.currentShop, shop: shopDomain })
            : t(`error.${result.reason}`, { shop: shopDomain })}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Back from Shopify's plan page (`?billing=verify&shop=`). No design yet
 * (Omer: "build something of your own for now"): 10's landing line. It says
 * nothing until the server has asked Shopify, because the URL proves nothing.
 */
export function ShopifyBillingVerify({
  shop,
  needsReconnect = false,
}: {
  readonly shop: string | null;
  /**
   * The integration exists but is not working: "not connected" means
   * "reconnect it" - said here; the button is the card's, below (one per screen).
   */
  readonly needsReconnect?: boolean;
}) {
  const t = useTranslations('capabilities.shopify.billing');
  const router = useRouter();
  const [check, setCheck] = useState<ShopifyBillingCheck | null>(null);
  const [isPending, startTransition] = useTransition();

  const verify = () =>
    startTransition(async () => {
      const done = await verifyShopifyBilling(shop);
      setCheck(done);
      if (done.ok && done.grantsAccess) router.refresh();
    });
  // Once, on arrival - a development double-mount must not ask Shopify twice.
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    verify();
  });

  if (check === null || (isPending && !check.ok)) {
    return (
      <p className={styles.landing} role="status" data-testid="shopify-billing-checking">
        {t('checking')}
      </p>
    );
  }
  if (!check.ok && check.reason === 'not_connected' && needsReconnect) {
    // Measured on dev: a store in ERROR answered "no store connected" beside a card that has one.
    return (
      <div className={styles.landing} data-outcome="problem" data-testid="shopify-billing">
        <span>{t('error.reconnect')}</span>
      </div>
    );
  }
  if (!check.ok) {
    return (
      <div className={styles.landing} data-outcome="problem" data-testid="shopify-billing">
        <span>{t(`error.${check.reason}`)}</span>
        {check.reason === 'unreachable' || check.reason === 'failed' ? (
          <button
            type="button"
            className={styles.connectButton}
            disabled={isPending}
            data-testid="shopify-billing-retry"
            onClick={verify}
          >
            {t('retry')}
          </button>
        ) : null}
      </div>
    );
  }
  if (check.grantsAccess) {
    return (
      <p className={styles.landing} data-outcome="ok" role="status" data-testid="shopify-billing">
        {t('connected')}
      </p>
    );
  }
  return (
    <div className={styles.landing} data-outcome="problem" data-testid="shopify-billing">
      <span>{t(stateKey(check.state, check.declined))}</span>
      {check.planSelectionUrl ? (
        <a
          href={check.planSelectionUrl}
          className={styles.connectButton}
          data-testid="shopify-billing-plan"
        >
          {t('choosePlan')}
        </a>
      ) : null}
    </div>
  );
}

/** A verified state without access, as a sentence; one we do not know is said as such. */
function stateKey(state: string, declined: boolean) {
  switch (state) {
    case 'PLAN_SELECTION_REQUIRED':
      return declined ? 'state.declined' : 'state.planNeeded';
    case 'APPROVAL_PENDING':
      return 'state.approvalPending';
    case 'PAST_DUE':
      return 'state.pastDue';
    case 'FROZEN':
      return 'state.frozen';
    case 'CANCELLED':
      return 'state.cancelled';
    default:
      return 'state.other';
  }
}

/**
 * Back with `pending=1` and nothing to claim: the approval expired or was
 * used (`read`), or it could not be checked. Said either way - an arrival
 * that draws nothing looks like the install never happened.
 */
export function ShopifyPendingGone({
  read,
  helpUrl,
}: {
  readonly read: boolean;
  readonly helpUrl: string | null;
}) {
  const t = useTranslations('capabilities.shopify.pending');
  return (
    <p className={styles.landing} data-outcome="problem" data-testid="shopify-pending-gone">
      {read ? t('gone') : t('unread')}{' '}
      {helpUrl ? (
        <a
          href={helpUrl}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="shopify-pending-help"
        >
          {t('listing')}
        </a>
      ) : null}
    </p>
  );
}
