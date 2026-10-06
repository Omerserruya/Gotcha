'use client';

import { useTranslations } from 'next-intl';
import { useRef, useState, useTransition } from 'react';

import {
  didExecute,
  isWaitingOnAPerson,
  type OrderAction,
  type OrderActionResult,
  type OrderCard,
  type StatusChip,
} from '@/api/contracts/customer-orders';

import { runOrderAction } from './order-actions';
import styles from './Customers.module.css';

/**
 * Screen 04d's controls — and the state after they run.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ NOTHING HERE IS OPTIMISTIC, AND THE CHIPS PROVE IT
 * ════════════════════════════════════════════════════════════════════════════
 * `commerce-actions.service.ts` runs a post-action verify and returns the
 * provider's own order card. Its header: *"a button click never mutates
 * order state in the UI; the caller updates only from the verified result
 * returned here."*
 *
 * So after a successful action this renders the chips from
 * `result.order` — the provider's verified state — and never from the action
 * that was requested. Pressing Refund does not make a card say "Refunded";
 * the provider saying so makes it say so.
 *
 * ── FIVE OUTCOMES, AND ONLY ONE MEANS IT HAPPENED ──
 * `pending_approval` is the one a screen gets wrong. It is neither a success
 * nor a failure: the action is sitting in the queue screen 03 renders,
 * holding until a person decides. Shown as done, somebody stops watching for
 * it; shown as failed, somebody does it again.
 *
 * ── AND A THROWN ERROR IS NOT A FAILURE ──
 * `null` back from the action means we do not know what happened. On a
 * refund that is the 17d distinction exactly: never invite a retry on an
 * unknown outcome, because money taken twice is not recoverable by pressing
 * something again.
 */
export function OrderActions({
  order,
  conversationId,
  only,
  label,
  buttonClassName,
}: {
  readonly order: OrderCard;
  readonly conversationId: string;
  /**
   * The Inbox wall's fixed set (02: Refund · Replace). Each is drawn whether
   * or not this order allows it — disabled, with the platform's reason as
   * its title, when it does not — so the wall's row has one shape.
   */
  readonly only?: readonly OrderAction[];
  readonly label?: (action: OrderAction) => string;
  readonly buttonClassName?: string;
}) {
  const t = useTranslations('customers');
  const [result, setResult] = useState<OrderActionResult | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [isPending, startTransition] = useTransition();

  /*
   * One key per attempt on this order. The service uses it to make a
   * double-click one operation — the same mechanism as 17d's `intentKey`, and
   * the same trap: minted per click it would be a new operation every time,
   * with identical code and identical appearance.
   *
   * ★★ AND THE CLOCK IS GONE, BECAUSE IT FAILED ON BOTH EDGES.
   * This was `useMemo(() => …Math.floor(Date.now() / 60_000)…)`. A minute
   * bucket collapses two DELIBERATE presses seconds apart into one refund —
   * and lets the same press a minute later through as a second one. Neither
   * edge is where the customer's intent changes, and React may discard the
   * memo and re-cross either edge on its own.
   *
   * A ref seeded once per mount is what "one attempt" actually means here:
   * every button is disabled as soon as anything is attempted (see below), so
   * one mount is one decision. Coming back to the order later and pressing
   * again is a new decision and gets a new key — which is a person deciding,
   * not a clock.
   */
  const idempotencyKeyRef = useRef<string | null>(null);

  const possible: readonly OrderAction[] = [
    order.eligibility.cancellable ? 'cancel' : null,
    order.eligibility.refundable ? 'refund' : null,
    order.eligibility.returnable ? 'create_return' : null,
    order.eligibility.exchangeable ? 'exchange_item' : null,
  ].filter((a): a is OrderAction => a !== null);

  const shown = only ?? possible;

  if (!only && possible.length === 0) {
    return order.eligibility.reasonIfNot ? (
      <p className={styles.orderCan} data-testid={`order-why-not-${order.orderId}`}>
        {order.eligibility.reasonIfNot}
      </p>
    ) : null;
  }

  function run(action: OrderAction) {
    // Minted in the handler, so nothing impure runs during a render, and kept
    // in the ref so a retry — if one ever becomes possible here — carries it.
    idempotencyKeyRef.current ??= `order:${order.orderId}:${crypto.randomUUID()}`;
    const idempotencyKey = idempotencyKeyRef.current;

    setAttempted(true);
    setResult(null);
    startTransition(async () => {
      setResult(await runOrderAction(conversationId, order.orderId, action, idempotencyKey));
    });
  }

  /*
   * ★ THE VERIFIED CARD, IF ONE CAME BACK. The chips below are the
   * provider's, read after the fact — not the ones we would have drawn from
   * knowing which button was pressed.
   */
  const verified = didExecute(result) ? (result?.order ?? null) : null;

  return (
    <div className={styles.orderActions} data-testid={`order-actions-${order.orderId}`}>
      {shown.map((action) => (
        <button
          key={action}
          type="button"
          className={buttonClassName ?? styles.orderAction}
          title={
            possible.includes(action)
              ? undefined
              : (order.eligibility.reasonIfNot ?? t('orders.notPossible'))
          }
          data-testid={`order-action-${order.orderId}-${action}`}
          /*
           * Disabled once anything has been attempted on this order. The
           * outcome may be `pending_approval`, and a second press on an
           * action already waiting for a human is a second request for the
           * same money.
           */
          disabled={isPending || attempted || !possible.includes(action)}
          onClick={() => run(action)}
        >
          {isPending
            ? t('orders.running')
            : (label?.(action) ?? t(`orders.action.${action}` as 'orders.action.cancel'))}
        </button>
      ))}

      {/* ★ The provider's verified state, replacing nothing until it exists. */}
      {verified ? (
        <div className={styles.chips} data-testid={`order-verified-${order.orderId}`}>
          {(
            [verified.financial, verified.fulfillment, verified.shipping, verified.refund] as (
              StatusChip | null | undefined
            )[]
          )
            .filter((chip): chip is StatusChip => !!chip)
            .map((chip) => (
              <span
                key={`${chip.key}-${chip.label}`}
                className={styles.chip}
                data-tone={chip.tone}
                data-testid={`verified-chip-${verified.orderId}-${chip.key}`}
              >
                {chip.label}
              </span>
            ))}
        </div>
      ) : null}

      {isWaitingOnAPerson(result) ? (
        <p className={styles.orderWaiting} data-testid={`order-pending-${order.orderId}`}>
          {t('orders.pendingApproval')}
        </p>
      ) : null}

      {result?.state === 'denied' ? (
        <p className={styles.orderCan} data-testid={`order-denied-${order.orderId}`}>
          {t('orders.denied', { reason: result.reason ?? t('orders.noReason') })}
        </p>
      ) : null}

      {result?.state === 'unavailable' ? (
        <p className={styles.orderCan} data-testid={`order-unavailable-${order.orderId}`}>
          {t('orders.actionUnavailable', { reason: result.reason ?? t('orders.noReason') })}
        </p>
      ) : null}

      {/*
        ★★ WE DO NOT KNOW. Not "it failed" — the request threw, and on a
        refund the honest sentence is the 17d one: do not try again, check,
        and ask. A retry offered here spends somebody's money twice.
      */}
      {attempted && !isPending && result === null ? (
        <p className={styles.orderUnknown} data-testid={`order-unknown-${order.orderId}`}>
          {t('orders.outcomeUnknown')}
        </p>
      ) : null}
    </div>
  );
}
