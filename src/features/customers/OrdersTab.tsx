import { getFormatter, getTranslations } from 'next-intl/server';

import { ShoppingBag } from 'lucide-react';

import {
  anythingPossible,
  isTroubled,
  orderToExpand,
  ordersIn,
  shopifyAdminHref,
  type CommerceContextResponse,
  type Money,
  type OrderCard,
  type StatusChip,
} from '@/api/contracts/customer-orders';
import { Link } from '@/i18n/navigation';

import { shortDate } from './CustomerScreen';
import { PromiseCard } from './CustomerSubtabs';
import { OrderActions } from './OrderActions';
import styles from './Customers.module.css';

/**
 * Screen 04d — their orders, as the customer card's tab draws them.
 *
 * ★ A SIBLING OF `CustomerOrders`, NOT ITS REPLACEMENT. The inbox's Copilot
 * side mounts `CustomerOrders` and the inbox is a closed screen; 04d's frame
 * (the open card, the tracker, the one-line rows) lives here, and its CSS is
 * scoped under `.ordersTab` so it cannot reach the inbox's panel. The
 * states and the actions are the same rules, said the same way.
 *
 * (What follows is `CustomerOrders`'s own account of those rules.)
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
export const ORDER_FILTERS = ['all', 'open', 'returns'] as const;
export type OrderFilter = (typeof ORDER_FILTERS)[number];

export function parseOrderFilter(raw: string | undefined): OrderFilter {
  return (ORDER_FILTERS as readonly string[]).includes(raw ?? '') ? (raw as OrderFilter) : 'all';
}

/**
 * 04d's "Open": not cancelled, and not yet with the customer. Read from the
 * platform's own chip KEYS (`commerce-context.service.ts`), never from labels.
 */
export function isOpenOrder(order: OrderCard): boolean {
  if (order.cancelled) return false;
  return order.shipping?.key !== 'delivered' && order.fulfillment?.key !== 'delivered';
}

/** 04d's "Returns": money went back, or the order was cancelled. */
export function isReturnOrder(order: OrderCard): boolean {
  return order.cancelled || order.refund !== null;
}

/**
 * The one chip an order line carries in 02: what happened LAST. A refund
 * outranks delivery, delivery outranks fulfilment. The platform's label and
 * tone, verbatim.
 */
export function statusChipOf(order: OrderCard): StatusChip | null {
  return order.refund ?? order.shipping ?? order.fulfillment ?? null;
}

export async function OrdersTab({
  orders,
  conversationId,
  filter = 'all',
}: {
  readonly orders: CommerceContextResponse | null;
  /**
   * Where the actions post. `null` when this person has no conversation to
   * act through — and then the controls are absent rather than broken,
   * because the endpoint has nowhere to route.
   */
  readonly conversationId: string | null;
  readonly filter?: OrderFilter;
}) {
  const t = await getTranslations('customers');
  const format = await getFormatter();
  const now = new Date();

  const money = (m: Money | null | undefined): string | null => {
    if (!m || m.amount === null) return null;
    if (!m.currency) return format.number(m.amount, { maximumFractionDigits: 2 });
    return format.number(m.amount, {
      style: 'currency',
      currency: m.currency,
      maximumFractionDigits: 2,
    });
  };
  const day = (iso: string | null) => (iso ? shortDate(iso, now, format, t('card.today')) : null);

  if (orders === null) {
    return (
      <section className={styles.ordersTab} data-testid="customer-orders-tab">
        <p className={styles.unavailable} data-testid="orders-unread">
          {t('orders.unread')}
        </p>
      </section>
    );
  }

  const list = ordersIn(orders);
  const expanded = orderToExpand(list);
  const shown = list.filter((order) =>
    filter === 'open' ? isOpenOrder(order) : filter === 'returns' ? isReturnOrder(order) : true,
  );
  const summary = orders.state === 'ok' ? (orders.data?.summary ?? orders.summary) : orders.summary;
  const fetchedAt = orders.state === 'ok' ? (orders.data?.fetchedAt ?? null) : null;

  /*
    02's lead: "6 orders · ₪2,140 · 1 open". The spend is Shopify's own
    total when it has one, else the per-currency totals — never summed
    across currencies, which is their rule.
  */
  const spend = summary?.shopCurrencyTotal
    ? money(summary.shopCurrencyTotal)
    : (summary?.totalSpentByCurrency ?? [])
        .map((m) => money(m))
        .filter(Boolean)
        .join(' + ') || null;
  const lead = summary
    ? [
        t('orders.count', { count: summary.orderCount }),
        spend,
        summary.openOrderCount ? t('orders.openCount', { count: summary.openOrderCount }) : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : null;

  return (
    <section className={styles.ordersTab} data-testid="customer-orders-tab">
      {lead || fetchedAt ? (
        <p className={styles.tabLead} data-testid="orders-lead">
          <span>{lead}</span>
          {fetchedAt ? (
            <span className={styles.ordersSynced}>
              <ShoppingBag size={12} strokeWidth={2} aria-hidden="true" />
              {t('orders.synced', { when: format.relativeTime(new Date(fetchedAt), now) })}
            </span>
          ) : null}
        </p>
      ) : null}

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

      {list.length > 0 && shown.length === 0 ? (
        <p className={styles.timelineEmpty} data-testid="orders-filter-empty">
          {t('orders.filterEmpty')}
        </p>
      ) : null}

      {shown.length > 0 ? (
        <ul className={styles.orderList} data-testid="order-list">
          {shown.map((order) => {
            const open = order.orderId === expanded?.orderId;
            const status = statusChipOf(order);
            /*
              ★ THE CHIPS ARE THEIRS. Rendered verbatim, already localised,
              with their tone. Payment joins the status only when it is not
              simply paid — "Payment pending" is news; "Paid" is the tracker's.
            */
            const chips = [
              status,
              order.financial && order.financial.tone !== 'positive' ? order.financial : null,
            ].filter((chip): chip is StatusChip => !!chip);
            const chipEls = chips.map((chip) => (
              <span
                key={`${chip.key}-${chip.label}`}
                className={styles.chip}
                data-tone={chip.tone}
                data-testid={`chip-${order.orderId}-${chip.key}`}
              >
                {chip.label}
              </span>
            ));
            const itemsLine = order.items
              .map((item) => item.title)
              .filter(Boolean)
              .join(', ');

            if (!open) {
              /* 02's other orders: one line each, `padding:12px 16px`. */
              return (
                <li
                  key={order.orderId}
                  className={styles.orderRow}
                  data-testid={`order-${order.orderId}`}
                  data-expanded="no"
                  data-troubled={isTroubled(order) ? 'yes' : 'no'}
                >
                  <span className={styles.orderRowNumber}>{order.orderNumber}</span>
                  <span className={styles.orderRowDate}>{day(order.createdAt) ?? '—'}</span>
                  <span className={styles.orderRowItems}>{itemsLine || '—'}</span>
                  {order.extraItemCount > 0 ? (
                    <span
                      className={styles.orderRowNote}
                      data-testid={`order-more-${order.orderId}`}
                    >
                      {t('orders.moreShort', { count: order.extraItemCount })}
                    </span>
                  ) : null}
                  {chipEls}
                  <span className={styles.orderRowTotal}>{money(order.total) ?? '—'}</span>
                </li>
              );
            }

            const lines =
              order.detail && order.detail.lineItems.length > 0
                ? order.detail.lineItems.map((line) => ({
                    key: line.lineItemId,
                    title: line.title,
                    variant: line.variantTitle,
                    quantity: line.quantity,
                    price: money(line.lineTotal),
                    imageUrl: line.imageUrl,
                  }))
                : order.items.map((item, index) => ({
                    key: `${index}-${item.title}`,
                    title: item.title,
                    variant: null,
                    quantity: item.quantity,
                    price: null,
                    imageUrl: item.imageUrl,
                  }));
            const tracking = order.detail?.tracking[0] ?? null;
            const trackingText = tracking
              ? [tracking.number, tracking.company].filter(Boolean).join(' · ') || null
              : null;
            const admin = shopifyAdminHref(order.adminUrl);

            return (
              <li
                key={order.orderId}
                className={styles.orderCard}
                data-testid={`order-${order.orderId}`}
                data-expanded="yes"
                data-troubled={isTroubled(order) ? 'yes' : 'no'}
              >
                <div className={styles.orderHead}>
                  <span className={styles.orderNumber}>{order.orderNumber}</span>
                  <span className={styles.orderDate}>{day(order.createdAt) ?? '—'}</span>
                  {chipEls}
                  <span className={styles.orderTotal}>
                    {money(order.total) ?? t('orders.amountUnknown')}
                  </span>
                </div>

                <div className={styles.orderDetail} data-testid={`order-detail-${order.orderId}`}>
                  <ul className={styles.orderItems}>
                    {lines.map((line) => (
                      <li key={line.key} className={styles.orderItem}>
                        {/* A thumbnail where Shopify gave one; the square stays where it did not. */}
                        <span className={styles.orderThumb} aria-hidden="true">
                          {line.imageUrl ? <img src={line.imageUrl} alt="" /> : null}
                        </span>
                        <span className={styles.orderItemText}>
                          <span className={styles.orderItemTitle}>
                            {[line.title, line.variant].filter(Boolean).join(' · ')}
                          </span>
                          <span className={styles.orderItemQty}>
                            {t('orders.qty', { count: line.quantity })}
                          </span>
                        </span>
                        <span className={styles.orderItemPrice}>{line.price ?? '—'}</span>
                      </li>
                    ))}
                  </ul>

                  {/*
                    ★ "+N items" IS RENDERED. A card listing three of eleven
                    that says nothing looks like an order with three items.
                  */}
                  {order.extraItemCount > 0 ? (
                    <p className={styles.orderMore} data-testid={`order-more-${order.orderId}`}>
                      {t('orders.moreItems', { count: order.extraItemCount })}
                    </p>
                  ) : null}

                  {/* Shopify's milestones, as its service writes them. */}
                  {order.timeline.length > 0 ? (
                    <ol className={styles.tracker} data-testid={`order-tracker-${order.orderId}`}>
                      {order.timeline.map((step, index) => {
                        const next = order.timeline[index + 1];
                        return (
                          <li
                            key={step.key}
                            className={styles.trackerStep}
                            data-state={step.failed ? 'failed' : step.reached ? 'reached' : 'ahead'}
                          >
                            <span className={styles.trackerRail} aria-hidden="true">
                              <span className={styles.trackerDot} />
                              <span
                                className={styles.trackerLine}
                                data-on={next?.reached && !next.failed ? '' : undefined}
                              />
                            </span>
                            <span className={styles.trackerLabel}>{step.label}</span>
                            <span className={styles.trackerDate}>
                              {day(step.at ?? null) ?? '—'}
                            </span>
                          </li>
                        );
                      })}
                    </ol>
                  ) : null}

                  <dl className={styles.orderFacts}>
                    <div>
                      <dt>{t('orders.fact.tracking')}</dt>
                      <dd>{trackingText ?? '—'}</dd>
                    </div>
                    <div>
                      <dt>{t('orders.fact.shipTo')}</dt>
                      <dd>{order.detail?.shippingAddress ?? '—'}</dd>
                    </div>
                    {/* No carrier case is recorded anywhere; the row keeps its place. */}
                    <div>
                      <dt>{t('orders.fact.carrierCase')}</dt>
                      <dd>—</dd>
                    </div>
                    {/*
                      Money already returned, and the ceiling on returning more:
                      "refundable" and "refundable for how much" are different
                      facts, and the second decides whether somebody acts.
                    */}
                    <div>
                      <dt>{t('orders.fact.money')}</dt>
                      {order.refundedAmount.amount ? (
                        <dd data-attention="" data-testid={`order-refunded-${order.orderId}`}>
                          {t('orders.refunded', { amount: money(order.refundedAmount) ?? '' })}
                        </dd>
                      ) : order.eligibility.refundable && order.refundableMaximum.amount ? (
                        <dd data-testid={`order-ceiling-${order.orderId}`}>
                          {t('orders.refundableMax', {
                            amount: money(order.refundableMaximum) ?? '',
                          })}
                        </dd>
                      ) : (
                        <dd>—</dd>
                      )}
                    </div>
                  </dl>
                </div>

                {/*
                  ══════════════════════════════════════════════════════════════
                  ★★ WHAT COULD BE DONE.
                  ══════════════════════════════════════════════════════════════
                  Eligibility is computed from the VIEWER's own permissions:
                  the service's cache key carries a permission signature so two
                  people with different commerce grants do not share an answer.
                  `reasonIfNot` is the platform's own sentence, verbatim.
                */}
                <div className={styles.orderFoot}>
                  {conversationId ? (
                    <OrderActions order={order} conversationId={conversationId} />
                  ) : anythingPossible(order) ? (
                    /*
                     * No conversation to act through, so the actions have nowhere
                     * to route. What COULD be done is still said — it is a fact
                     * about the order — and nothing is drawn that would fail.
                     */
                    <p className={styles.orderCan} data-testid={`order-possible-${order.orderId}`}>
                      {t('orders.possible', {
                        actions: [
                          order.eligibility.cancellable ? t('orders.action.cancel') : null,
                          order.eligibility.refundable ? t('orders.action.refund') : null,
                          order.eligibility.returnable ? t('orders.action.create_return') : null,
                          order.eligibility.exchangeable ? t('orders.action.exchange_item') : null,
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
                  {admin ? (
                    <a
                      href={admin}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={styles.spineOpen}
                      data-testid={`order-admin-${order.orderId}`}
                    >
                      {t('orders.openInShopify')}
                    </a>
                  ) : (
                    <span className={styles.spineOpen} aria-disabled="true">
                      {t('orders.openInShopify')}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      {/*
        ★ THE ACTIONS ARE HERE, and the reason is a sharpened rule rather than
        a reversal: this write carries `targetType: "customer" | "order"` and
        the conversation only as context — acceptable on a record already
        keyed to the person, where `createNote`'s attribution was not.
      */}
      {list.length > 0 && !conversationId ? (
        <p className={styles.timelineLimit} data-testid="orders-no-conversation">
          {t('orders.noConversationToActThrough')}
        </p>
      ) : null}
    </section>
  );
}

/** 04d's filters: All, Open, Returns. */
export async function OrderFilters({
  contactId,
  current,
}: {
  readonly contactId: string;
  readonly current: OrderFilter;
}) {
  const t = await getTranslations('customers');
  return (
    <>
      {ORDER_FILTERS.map((key) => (
        <Link
          key={key}
          href={{
            pathname: `/customers/${contactId}`,
            query: key === 'all' ? { tab: 'orders' } : { tab: 'orders', filter: key },
          }}
          className={styles.filterPill}
          aria-current={current === key ? 'true' : undefined}
          data-testid={`order-filter-${key}`}
        >
          {t(`orders.filter.${key}`)}
        </Link>
      ))}
    </>
  );
}

/**
 * 04d's side: "Across their orders", "What they buy", "On file", and the
 * promise card at the foot.
 *
 * Every figure is the summary's own — Shopify's average order and counts —
 * never computed from the recent page, which is a few orders, not all of
 * them. What nothing records ("arrived on time", payment method, what they
 * buy) keeps its place as "—" or "Nothing yet.".
 */
export async function OrdersSide({ orders }: { readonly orders: CommerceContextResponse | null }) {
  const t = await getTranslations('customers');
  const format = await getFormatter();
  const summary =
    orders?.state === 'ok' ? (orders.data?.summary ?? orders.summary) : (orders?.summary ?? null);
  const money = (m: Money | null | undefined) =>
    m && m.amount !== null
      ? m.currency
        ? format.number(m.amount, {
            style: 'currency',
            currency: m.currency,
            maximumFractionDigits: 0,
          })
        : format.number(m.amount)
      : '—';
  const figure = (n: number | null | undefined) =>
    n === null || n === undefined ? '—' : format.number(n);

  return (
    <>
      <section className={styles.sideBlock} data-testid="orders-across">
        <h2 className={styles.sideEyebrow}>{t('orders.side.heading')}</h2>
        <dl className={`${styles.worth} ${styles.pattern}`}>
          <div>
            <dt>{t('orders.side.average')}</dt>
            <dd className={styles.worthValue}>{money(summary?.averageOrderValue)}</dd>
          </div>
          {/* Nothing records a promised delivery date to compare against. */}
          <div>
            <dt>{t('orders.side.onTime')}</dt>
            <dd className={styles.worthValue}>—</dd>
          </div>
          <div>
            <dt>{t('orders.side.open')}</dt>
            <dd className={styles.worthValue}>{figure(summary?.openOrderCount)}</dd>
          </div>
        </dl>
      </section>
      <section className={styles.sideBlock} data-testid="orders-buys">
        <h2 className={styles.sideEyebrow}>{t('orders.side.buys')}</h2>
        <p className={styles.sideNone}>{t('orders.side.buysNone')}</p>
      </section>
      <section className={styles.sideBlock} data-testid="orders-on-file">
        <h2 className={styles.sideEyebrow}>{t('orders.side.onFile')}</h2>
        <dl className={styles.onFile}>
          <div>
            <dt>{t('orders.side.address')}</dt>
            <dd>{summary?.defaultAddress ?? '—'}</dd>
          </div>
          {/* The order card carries no payment method. */}
          <div>
            <dt>{t('orders.side.payment')}</dt>
            <dd>—</dd>
          </div>
          <div>
            <dt>{t('orders.side.returns')}</dt>
            <dd>
              {summary?.refundedOrCancelledCount === null ||
              summary?.refundedOrCancelledCount === undefined
                ? '—'
                : t('orders.side.returnsValue', { count: summary.refundedOrCancelledCount })}
            </dd>
          </div>
        </dl>
      </section>
      <PromiseCard heading={t('card.promise.heading')} none={t('card.promise.none')} />
    </>
  );
}
