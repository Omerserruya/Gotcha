'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import type { BlockedReason, PendingInstall } from '@/api/contracts/shopify-install';
import { Dialog, DialogClose, DialogContent } from '@/design-system/primitives/overlay/Dialog';
import { Link, useRouter } from '@/i18n/navigation';
import { useSupport } from '@/support/support-context';

import { ShopifyStartButton } from './ShopifyConnect';
import { claimShopifyInstall, dismissShopifyPending, type ShopifyClaim } from './shopify-actions';
import styles from './Capabilities.module.css';

type Refusal = Extract<ShopifyClaim, { ok: false }>['reason'];

/**
 * ★★ A STORE INSTALLED FROM SHOPIFY IS CLAIMED ON ANY PAGE (App Review
 * 132211, 2.1.1). Whenever the pending read answers, this prompt is drawn
 * above whatever page the person landed on - after onboarding included -
 * not only on the Systems page with `pending=1`.
 *
 * - `attach`: "Connect <shop>?" and "Not now".
 * - `replace`, or a claim answered 409 replace_required: Omer's question in a
 *   dialog - "This workspace supports one Shopify store. Replace <old> with
 *   <new>?". Cancel dismisses the pending install and touches no store.
 * - `blocked`, and every refusal: its own sentence. An expired one offers
 *   Connect again (a real button to Shopify), never only words.
 */
export function ShopifyClaimPrompt({ pending }: { readonly pending: PendingInstall }) {
  const t = useTranslations('capabilities.shopify.claim');
  const router = useRouter();
  const [outcome, setOutcome] = useState<
    | { readonly kind: 'claimed' }
    | { readonly kind: 'dismissed' }
    | { readonly kind: 'refused'; readonly reason: Refusal }
    | null
  >(null);
  const [asking, setAsking] = useState(false);
  const [current, setCurrent] = useState<string | null>(pending.current?.shopDomain ?? null);
  const [isPending, startTransition] = useTransition();
  const shop = pending.shopDomain;
  // Support mode: connecting a store (and its billing) is the merchant's own, never support's.
  const supported = useSupport().refuses('billing');

  const claim = (replace: boolean) =>
    startTransition(async () => {
      const done = await claimShopifyInstall(replace);
      if (done.ok) {
        setAsking(false);
        if (done.planSelectionUrl) {
          window.location.assign(done.planSelectionUrl);
          return;
        }
        /*
         * The claim spent the cookie, so the refreshed layout draws no prompt
         * (revalidate re-renders, and "connected" would vanish with it): the
         * person goes to the store's own page, which shows it connected.
         */
        setOutcome({ kind: 'claimed' });
        // Connected, the features not yet enabled: the store's page says so (a fixed marker).
        router.push(
          done.awaitingGrant
            ? '/studio/capabilities?system=shopify&claimed=awaiting_grant'
            : '/studio/capabilities?system=shopify',
        );
        return;
      }
      if (done.reason === 'replace_required') {
        if (done.currentShop) setCurrent(done.currentShop);
        setAsking(true);
        return;
      }
      setAsking(false);
      setOutcome({ kind: 'refused', reason: done.reason });
    });

  const dismiss = () =>
    startTransition(async () => {
      await dismissShopifyPending();
      setAsking(false);
      setOutcome({ kind: 'dismissed' });
    });

  if (supported || outcome?.kind === 'dismissed') return null;
  if (outcome?.kind === 'claimed') {
    return (
      <p className={styles.landing} data-outcome="ok" role="status" data-testid="shopify-claimed">
        {t('done', { shop })}
      </p>
    );
  }

  const blocked: BlockedReason | 'blocked' | null =
    pending.action === 'blocked' ? (pending.blockedReason ?? 'blocked') : null;
  const refusal = outcome?.kind === 'refused' ? outcome.reason : null;

  if (refusal !== null || blocked !== null) {
    const reason = refusal ?? blocked;
    return (
      <div
        className={styles.landing}
        data-outcome="problem"
        role={refusal ? 'alert' : undefined}
        data-testid="shopify-claim-problem"
        data-reason={reason}
      >
        <span>{t(`error.${reason ?? 'failed'}`, { shop })}</span>
        <span className={styles.claimActions}>
          {reason === 'core_plan_required' ? (
            <Link
              href="/settings/billing/plan"
              className={styles.connectButton}
              data-testid="shopify-claim-plan"
            >
              {t('choosePlan')}
            </Link>
          ) : reason === 'expired' ? (
            <ShopifyStartButton
              label={t('connectAgain')}
              testId="shopify-claim-start"
              note={false}
            />
          ) : reason === 'failed' || reason === 'billing_unavailable' ? (
            <button
              type="button"
              className={styles.connectButton}
              disabled={isPending}
              data-testid="shopify-claim-retry"
              onClick={() => claim(pending.action === 'replace')}
            >
              {t('retry')}
            </button>
          ) : null}
          {reason === 'expired' ? null : (
            <button
              type="button"
              className={styles.claimSecondary}
              disabled={isPending}
              data-testid="shopify-claim-dismiss"
              onClick={dismiss}
            >
              {t('close')}
            </button>
          )}
        </span>
      </div>
    );
  }

  const replacing = pending.action === 'replace';
  return (
    <div
      className={styles.claimPrompt}
      data-testid="shopify-claim-prompt"
      data-action={pending.action}
    >
      <span data-testid="shopify-claim-lead">
        {replacing
          ? current
            ? t('replaceLead', { shop, current })
            : t('replaceLeadUnnamed', { shop })
          : current && pending.current?.status === 'DISCONNECTED'
            ? t('attachLeadUninstalled', { shop, current })
            : t('attachLead', { shop })}
      </span>
      <span className={styles.claimActions}>
        <button
          type="button"
          className={styles.connectButton}
          disabled={isPending}
          data-testid="shopify-claim-go"
          onClick={() => (replacing ? setAsking(true) : claim(false))}
        >
          {replacing ? t('replaceOpen') : t('connect', { shop })}
        </button>
        <button
          type="button"
          className={styles.claimSecondary}
          disabled={isPending}
          data-testid="shopify-claim-not-now"
          onClick={dismiss}
        >
          {t('notNow')}
        </button>
      </span>

      <Dialog open={asking} onOpenChange={(next) => (isPending ? null : setAsking(next))}>
        <DialogContent
          title={
            current
              ? t('replaceQuestion', { shop, current })
              : t('replaceQuestionUnnamed', { shop })
          }
          data-testid="shopify-replace-dialog"
        >
          <div className={styles.claimActions}>
            <DialogClose asChild>
              <button
                type="button"
                className={styles.claimSecondary}
                disabled={isPending}
                data-testid="shopify-replace-cancel"
                // Cancel forgets the pending install; no store is touched.
                onClick={dismiss}
              >
                {t('replaceCancel')}
              </button>
            </DialogClose>
            <button
              type="button"
              className={styles.connectButton}
              disabled={isPending}
              data-testid="shopify-replace-go"
              onClick={() => claim(true)}
            >
              {t('replaceGo')}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
