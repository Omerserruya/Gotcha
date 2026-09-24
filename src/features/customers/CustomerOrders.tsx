import { getFormatter, getTranslations } from 'next-intl/server';

import {
  anythingPossible,
  isTroubled,
  orderToExpand,
  ordersIn,
  type CommerceContextResponse,
  type Money,
  type StatusChip,
} from '@/api/contracts/customer-orders';

import styles from './Customers.module.css';

/**
 * Screen 04d — her orders.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ EIGHT STATES, RENDERED AS EIGHT. THE PLATFORM ASKED FOR THIS.
 * ════════════════════════════════════════════════════════════════════════════
 * `CommerceContextResponse`'s own comment says the frontend *"renders an
 * explicit UI for each state — it never guesses from a bare error"*, and the
 * union is built so it can. Collapsing them into "we couldn't load orders"
 * would throw away five different repairs:
 *
 *   not_connected         connect a store          (nothing was ever connected)
 *   connection_unhealthy  FIX the store            (the work was done; it broke)
 *   customer_not_linked   nothing to repair        (the shop has no such customer)
 *   verification_required nothing to repair        (we will not show one
 *                                                   person's orders to another)
 *   missing_scopes        grant them, IN SHOPIFY   (the connection is fine)
 *   unavailable           try again                (retryable, and says so)
 *
 * The first two are the distinction this project has made on 13, 14 and 17 —
 * made here by Backend before we arrived.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ AND THIS SCREEN TAKES NO ORDER ACTIONS, THOUGH THEY WOULD WORK
 * ════════════════════════════════════════════════════════════════════════════
 * `POST /api/commerce-context/:conversationId/actions` is the best-guarded
 * write in the platform — permission, ownership re-validation, business
 * policy, optional approval, idempotent adapter call, provider-result
 * validation, post-action verify, audit. *"There is NO second
 * frontend-to-Shopify execution path."*
 *
 * And it is conversation-keyed. `commerce-actions.service.ts:190` writes the
 * audit with `metadata: { conversationId }`, so an action taken from the
 * customer page would be recorded against whichever conversation this page
 * entered through — **a wrong audit trail, on the actions whose whole
 * purpose is leaving a right one.**
 *
 * So eligibility is SHOWN and nothing is offered. A merchant learns what
 * could be done to this order, by them, with their permissions — and does it
 * in the conversation, where the record will be true.
 */
export async function CustomerOrders({
  orders,
}: {
  readonly orders: CommerceContextResponse | null;
}) {
  const t = await getTranslations('customers');
  const format = await getFormatter();

  const money = (m: Money): string | null => {
    if (m.amount === null) return null;
    if (!m.currency) return format.number(m.amount, { maximumFractionDigits: 2 });
    return format.number(m.amount, {
      style: 'currency',
      currency: m.currency,
      maximumFractionDigits: 2,
    });
  };

  if (orders === null) {
    return (
      <section className={styles.orders} data-testid="customer-orders">
        <h2 className={styles.detailHeading}>{t('orders.heading')}</h2>
        <p className={styles.unavailable} data-testid="orders-unread">
          {t('orders.unread')}
        </p>
      </section>
    );
  }

  const list = ordersIn(orders);
  const expanded = orderToExpand(list);

  return (
    <section className={styles.orders} data-testid="customer-orders">
      <h2 className={styles.detailHeading}>{t('orders.heading')}</h2>

      {/*
        Each state its own sentence. `data-state` is on the block so a capture
        can assert WHICH one was rendered rather than that something was.
      */}
      {orders.state !== 'ok' ? (
        <p
          className={styles.briefNone}
          data-testid={`orders-${orders.state}`}
          data-state={orders.state}
        >
          {orders.state === 'missing_scopes'
            ? /*
                The scopes are NAMED. "Permissions are missing" sends somebody
                to look for a setting; the list tells them which to grant, and
                the repair is in Shopify rather than here.
              */
              t('orders.missingScopes', { scopes: orders.missing.join(', ') })
            : t(`orders.state.${orders.state}` as 'orders.state.not_connected')}
        </p>
      ) : null}

      {list.length > 0 ? (
        <ul className={styles.orderList} data-testid="order-list">
          {list.map((order) => (
            <li
              key={order.orderId}
              className={styles.order}
              data-testid={`order-${order.orderId}`}
              data-expanded={order.orderId === expanded?.orderId ? 'yes' : 'no'}
              data-troubled={isTroubled(order) ? 'yes' : 'no'}
            >
              <div className={styles.orderHead}>
                <span className={styles.orderNumber}>{order.orderNumber}</span>
                {order.createdAt ? (
                  <span className={styles.orderDate}>
                    {format.dateTime(new Date(order.createdAt), { dateStyle: 'medium' })}
                  </span>
                ) : null}
                <span className={styles.orderTotal}>
                  {money(order.total) ?? t('orders.amountUnknown')}
                </span>
              </div>

              {/*
                ★ THE CHIPS ARE THEIRS. Rendered verbatim, already localised,
                with their tone. A paraphrase would be a second, vaguer copy
                of a sentence they wrote — and re-deciding the tone would make
                this screen disagree with the Inbox about the same order.
              */}
              <div className={styles.chips}>
                {(
                  [order.financial, order.fulfillment, order.shipping, order.refund] as (
                    StatusChip | null | undefined
                  )[]
                )
                  .filter((chip): chip is StatusChip => !!chip)
                  .map((chip) => (
                    <span
                      key={`${chip.key}-${chip.label}`}
                      className={styles.chip}
                      data-tone={chip.tone}
                      data-testid={`chip-${order.orderId}-${chip.key}`}
                    >
                      {chip.label}
                    </span>
                  ))}
              </div>

              {/*
                The design opens ONE order — the open or troubled one — and
                leaves the rest as a line each. More than one expanded is none
                expanded.
              */}
              {order.orderId === expanded?.orderId ? (
                <div className={styles.orderDetail} data-testid={`order-detail-${order.orderId}`}>
                  {order.items.length > 0 ? (
                    <ul className={styles.orderItems}>
                      {order.items.map((item) => (
                        <li key={`${item.title}-${item.quantity}`}>
                          {t('orders.item', { title: item.title, quantity: item.quantity })}
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  {/*
                    ★ "+N items" IS RENDERED. A card listing three of eleven
                    that says nothing looks like an order with three items.
                  */}
                  {order.extraItemCount > 0 ? (
                    <p className={styles.orderMore} data-testid={`order-more-${order.orderId}`}>
                      {t('orders.moreItems', { count: order.extraItemCount })}
                    </p>
                  ) : null}

                  {/*
                    Money already returned, and the ceiling on returning more.
                    The ceiling is shown even with no refund control here: it
                    is the difference between "refundable" and "refundable for
                    how much", and the second is what decides whether somebody
                    opens the conversation.
                  */}
                  {order.refundedAmount.amount ? (
                    <p
                      className={styles.orderMoney}
                      data-testid={`order-refunded-${order.orderId}`}
                    >
                      {t('orders.refunded', { amount: money(order.refundedAmount) ?? '' })}
                    </p>
                  ) : null}
                  {order.eligibility.refundable && order.refundableMaximum.amount !== null ? (
                    <p className={styles.orderMoney} data-testid={`order-ceiling-${order.orderId}`}>
                      {t('orders.refundableMax', { amount: money(order.refundableMaximum) ?? '' })}
                    </p>
                  ) : null}
                </div>
              ) : null}

              {/*
                ══════════════════════════════════════════════════════════════
                ★★ WHAT COULD BE DONE — SAID, NOT OFFERED.
                ══════════════════════════════════════════════════════════════
                Eligibility is computed from the VIEWER's own permissions:
                the service's cache key carries a permission signature so two
                people with different commerce grants do not share an answer.
                So this really is "the same permissions as the AI", and it is
                already decided server-side.

                The controls are absent because the write is conversation-
                keyed and would file its audit against the wrong conversation.
                `reasonIfNot` is the platform's own sentence for why an
                ineligible order is ineligible, rendered rather than
                paraphrased.
              */}
              {anythingPossible(order) ? (
                <p className={styles.orderCan} data-testid={`order-possible-${order.orderId}`}>
                  {t('orders.possible', {
                    actions: [
                      order.eligibility.cancellable ? t('orders.action.cancel') : null,
                      order.eligibility.refundable ? t('orders.action.refund') : null,
                      order.eligibility.returnable ? t('orders.action.return') : null,
                      order.eligibility.exchangeable ? t('orders.action.exchange') : null,
                    ]
                      .filter(Boolean)
                      .join(', '),
                  })}
                </p>
              ) : order.eligibility.reasonIfNot ? (
                <p className={styles.orderCan} data-testid={`order-why-not-${order.orderId}`}>
                  {order.eligibility.reasonIfNot}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {/*
        Said once, under the list, in every state that has one. A merchant who
        reads "a refund is possible" and finds no button is owed the reason —
        and the reason is ours, not theirs.
      */}
      {list.length > 0 ? (
        <p className={styles.timelineLimit} data-testid="orders-no-actions">
          {t('orders.noActionsHere')}
        </p>
      ) : null}
    </section>
  );
}
