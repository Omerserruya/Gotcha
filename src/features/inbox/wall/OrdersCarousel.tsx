'use client';

import { useFormatter, useTranslations } from 'next-intl';

import {
  ACTIONS_NOT_SUPPORTED,
  shopifyAdminHref,
  wooAdminHref,
  type CommerceState,
  type MatchedBy,
  type Money,
  type OrderCard,
  type StatusChip,
} from '@/api/contracts/customer-orders';
import { OrderActions } from '@/features/customers/OrderActions';
import { UserText } from '@/design-system/primitives/text/UserText';
import { Link } from '@/i18n/navigation';

import { useCarousel } from './use-carousel';
import { Pager } from './Pager';
import styles from './Wall.module.css';

/**
 * 02's "Order #1842 · 2 of 6" ‹ ›.
 *
 * This person's orders by contact (Backend e30900fd) — WooCommerce or
 * Shopify, one card shape — or, with no contact to read for, the
 * conversation's own commerce context (04d's read and eight states).
 *
 * ★ WOO IS READ-ONLY. Its cards carry no eligibility (`reasonIfNot:
 *   actions_not_supported_for_store`): Refund and Replace are drawn,
 *   disabled, saying why — and its admin link is WooCommerce's.
 *
 * ⚠ REFUND AND REPLACE ARE REAL. They are 04d's `OrderActions` — permission,
 *   policy, approval and an idempotency key per attempt — and on dev they are
 *   not pressed on a real conversation (Omer, 2026-10-06).
 */
export function OrdersCarousel({
  source,
  state,
  reason = null,
  missing,
  orders,
  start,
  conversationId,
}: {
  /** The store read: `shopify`, `woocommerce`, or `null` when none was. */
  readonly source: string | null;
  /** Shopify's state. `null` with no `reason`: the read failed. */
  readonly state: CommerceState | null;
  /** Why no store was read (`source: null`). */
  readonly reason?: string | null;
  readonly missing: readonly string[];
  readonly orders: readonly (OrderCard & { readonly matchedBy?: MatchedBy | null })[];
  readonly start: number;
  readonly conversationId: string;
}) {
  const t = useTranslations('inbox.wall.orders');
  const customers = useTranslations('customers');
  const format = useFormatter();
  const { index, go, region, first, last } = useCarousel(orders.length, start);
  const order = orders[index];

  const money = (m: Money): string | null => {
    if (m.amount === null) return null;
    return m.currency
      ? format.number(m.amount, {
          style: 'currency',
          currency: m.currency,
          maximumFractionDigits: 2,
        })
      : format.number(m.amount, { maximumFractionDigits: 2 });
  };

  if (!order) {
    const woo = source === 'woocommerce';
    return (
      <section
        className={styles.block}
        data-testid="wall-orders"
        data-state={reason ?? (woo ? 'woocommerce' : (state ?? 'unread'))}
      >
        <h3 className={styles.blockTitle}>{t('title')}</h3>
        <p className={styles.note} data-testid="wall-orders-note">
          {reason === 'store_not_chosen' ? (
            <>
              {t('storeNotChosen')}{' '}
              <Link
                href="/settings/systems"
                className={styles.inlineLink}
                data-testid="wall-orders-choose"
              >
                {t('chooseStore')}
              </Link>
            </>
          ) : reason === 'no_store_connected' ? (
            customers('orders.state.not_connected')
          ) : reason === 'store_unreachable' ? (
            t('storeUnreachable')
          ) : reason === 'no_identifiers' ? (
            t('noIdentifiers')
          ) : reason !== null ? (
            customers('orders.unread')
          ) : woo ? (
            t('noWooOrders')
          ) : state === null ? (
            customers('orders.unread')
          ) : state === 'missing_scopes' ? (
            customers('orders.missingScopes', { scopes: missing.join(', ') })
          ) : state === 'ok' ? (
            customers('orders.state.no_orders')
          ) : (
            customers(`orders.state.${state}` as 'orders.state.not_connected')
          )}
        </p>
      </section>
    );
  }

  const item = order.items[0] ?? null;
  const image = item?.imageUrl ?? order.detail?.lineItems.find((l) => l.imageUrl)?.imageUrl ?? null;
  const tracking = order.detail?.tracking.find((x) => x.url)?.url ?? null;
  const woo = source === 'woocommerce';
  const admin = woo ? wooAdminHref(order.adminUrl) : shopifyAdminHref(order.adminUrl);
  const readOnly = order.eligibility.reasonIfNot === ACTIONS_NOT_SUPPORTED;
  const placed = order.createdAt
    ? format.dateTime(new Date(order.createdAt), { day: 'numeric', month: 'short' })
    : null;
  const progress: StatusChip | null = order.shipping ?? order.fulfillment;

  return (
    <section className={styles.block} data-testid="wall-orders" data-state="ok">
      <div className={styles.blockHead}>
        <h3 className={styles.blockTitle} data-testid="wall-order-number">
          {t('number', { number: order.orderNumber.replace(/^#/, '') })}
        </h3>
        <span className={styles.meta} data-testid="wall-orders-position">
          {t('position', { at: index + 1, count: orders.length })}
        </span>
        <Pager first={first} last={last} go={go} testid="wall-orders" />
      </div>

      <div className={styles.order} {...region} aria-roledescription={t('carousel')}>
        {image ? (
          // A store's own image, of any host: not worth an optimiser's allow-list.
          // eslint-disable-next-line @next/next/no-img-element
          <img className={styles.orderImage} src={image} alt="" data-testid="wall-order-image" />
        ) : (
          <span className={styles.orderImage} data-empty="" title={t('noImage')} />
        )}
        <div className={styles.orderFacts}>
          <span className={styles.orderTitle}>
            {item ? <UserText>{item.title}</UserText> : '—'}
            {order.extraItemCount > 0 ? ` ${t('more', { count: order.extraItemCount })}` : null}
          </span>
          <span className={styles.orderLine}>
            <span className={styles.meta}>
              {[placed ?? '—', money(order.total) ?? '—'].join(' · ')}
            </span>
            {order.financial ? <Chip chip={order.financial} /> : null}
          </span>
          <span className={styles.orderLine}>
            <span className={styles.meta}>{progress?.label ?? '—'}</span>
            {order.cancelled ? (
              <span className={styles.chipText} data-tone="danger">
                {t('cancelled')}
              </span>
            ) : order.refund ? (
              <Chip chip={order.refund} />
            ) : null}
          </span>
          {/* How the store's customer was found. Verified needs no word. */}
          {order.matchedBy === 'email' || order.matchedBy === 'phone' ? (
            <span className={styles.meta} data-testid="wall-order-matched">
              {t(`matchedBy.${order.matchedBy}`)}
            </span>
          ) : null}
        </div>
      </div>

      <div className={styles.orderRow}>
        <OrderActions
          order={order}
          conversationId={conversationId}
          only={['refund', 'exchange_item']}
          label={(action) => (action === 'refund' ? t('refund') : t('replace'))}
          buttonClassName={styles.outlineSmall}
          // The platform's reason is a code here, not a sentence.
          whyNot={readOnly ? t('readOnly') : undefined}
          key={order.orderId}
        />
        {tracking ? (
          <a
            className={styles.outlineSmall}
            href={tracking}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="wall-order-track"
          >
            {t('track')}
          </a>
        ) : (
          <button
            type="button"
            className={styles.outlineSmall}
            disabled
            title={t('noTracking')}
            data-testid="wall-order-track"
          >
            {t('track')}
          </button>
        )}
        {admin ? (
          <a
            className={styles.violetLink}
            href={admin}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="wall-order-admin"
          >
            {woo ? t('woo') : t('shopify')}
          </a>
        ) : (
          <span className={styles.violetLink} data-off="" title={t('noAdmin')}>
            {woo ? t('woo') : t('shopify')}
          </span>
        )}
      </div>
    </section>
  );
}

function Chip({ chip }: { readonly chip: StatusChip }) {
  return (
    <span className={styles.chipText} data-tone={chip.tone}>
      {chip.label}
    </span>
  );
}
