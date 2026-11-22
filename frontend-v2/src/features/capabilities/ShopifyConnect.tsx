'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, useTransition } from 'react';

import type { ConnectFlow } from '@/api/endpoints/registry';
import { Link, useRouter } from '@/i18n/navigation';

import {
  startShopifyInstall,
  verifyShopifyBilling,
  type ShopifyBillingCheck,
  type ShopifyStart,
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
  helpUrl = null,
  connectAllowed = null,
  flow = 'redesign_studio',
  reconnect = false,
}: {
  /** Kept for callers; the button no longer waits on the listing mode (App Review 132211). */
  readonly mode?: string | null;
  readonly helpUrl?: string | null;
  readonly connectAllowed?: boolean | null;
  readonly flow?: ConnectFlow;
  /** A DISCONNECTED or broken store: "Reconnect", to the same start. */
  readonly reconnect?: boolean;
}) {
  const t = useTranslations('capabilities.shopify');
  const tc = useTranslations('billing.connector');

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

  /*
   * ★★ ALWAYS A REAL BUTTON (App Review 132211, 2.1.1): /install/start ends on
   * a Shopify page whatever the listing's state, so "installation starts in
   * Shopify" in words alone is gone - Connect, or Reconnect, starts it here.
   */
  return (
    <div className={styles.connectFoot}>
      <ShopifyStartButton
        label={reconnect ? t('reconnect') : t('connect')}
        flow={flow}
        testId="shopify-start"
        helpUrl={helpUrl}
      />
    </div>
  );
}

/**
 * The one start: asks the server for Shopify's page, then goes there. A
 * refusal is said beside it, by its reason; the button stays.
 */
export function ShopifyStartButton({
  label,
  flow = 'redesign_studio',
  testId,
  note = true,
  helpUrl = null,
}: {
  /** Not published yet: where "How to install" goes. */
  readonly helpUrl?: string | null;
  readonly label: string;
  readonly flow?: ConnectFlow;
  readonly testId: string;
  readonly note?: boolean;
}) {
  const t = useTranslations('capabilities.shopify');
  const [failed, setFailed] = useState<Exclude<ShopifyStart, { ok: true }>['reason'] | null>(null);
  const [isPending, startTransition] = useTransition();
  return (
    <>
      <button
        type="button"
        className={styles.connectButton}
        disabled={isPending}
        data-testid={testId}
        onClick={() => {
          setFailed(null);
          startTransition(async () => {
            const result = await startShopifyInstall(flow);
            if (result.ok) window.location.assign(result.url);
            else setFailed(result.reason);
          });
        }}
      >
        {isPending ? t('opening') : label}
      </button>
      {failed ? (
        <span className={styles.connectProblem} role="alert" data-testid="shopify-problem">
          {t(`error.${failed}`)}
          {failed === 'not_published' && helpUrl ? (
            <>
              {' '}
              <a
                href={helpUrl}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="shopify-help"
              >
                {t('help')}
              </a>
            </>
          ) : null}
        </span>
      ) : note ? (
        <span className={styles.connectNote}>{t('note')}</span>
      ) : null}
    </>
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
    <div className={styles.landing} data-outcome="problem" data-testid="shopify-pending-gone">
      <span>
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
      </span>
      {/* No text-only state (App Review 132211): Connect starts over, on Shopify's page. */}
      <span className={styles.claimActions}>
        <ShopifyStartButton label={t('connectAgain')} testId="shopify-pending-start" note={false} />
      </span>
    </div>
  );
}
