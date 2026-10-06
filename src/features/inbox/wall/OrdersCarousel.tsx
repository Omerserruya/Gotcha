'use client';

import { useFormatter, useTranslations } from 'next-intl';

import {
  shopifyAdminHref,
  type CommerceState,
  type Money,
  type OrderCard,
  type StatusChip,
} from '@/api/contracts/customer-orders';
import { OrderActions } from '@/features/customers/OrderActions';
import { UserText } from '@/design-system/primitives/text/UserText';

import { useCarousel } from './use-carousel';
import { Pager } from './Pager';
import styles from './Wall.module.css';

/**
 * 02's "Order #1842 · 2 of 6" ‹ ›.
 *
 * The conversation's own commerce context — the same read, contract and
 * eight states as 04d, keyed on this conversation. Orders per contact are
 * Backend's next contract; when it lands this reads that instead.
 *
 * ⚠ REFUND AND REPLACE ARE REAL. They are 04d's `OrderActions` — permission,
 *   policy, approval and an idempotency key per attempt — and on dev they are
 *   not pressed on a real conversation (Omer, 2026-10-06).
 */
export function OrdersCarousel({
  state,
  missing,
  orders,
  start,
  conversationId,
}: {
  /** `null`: the read failed. */
  readonly state: CommerceState | null;
  readonly missing: readonly string[];
  readonly orders: readonly OrderCard[];
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
    return (
      <section className={styles.block} data-testid="wall-orders" data-state={state ?? 'unread'}>
        <h3 className={styles.blockTitle}>{t('title')}</h3>
        <p className={styles.note} data-testid="wall-orders-note">
          {state === null
            ? customers('orders.unread')
            : state === 'missing_scopes'
              ? customers('orders.missingScopes', { scopes: missing.join(', ') })
              : state === 'ok'
                ? customers('orders.state.no_orders')
                : customers(`orders.state.${state}` as 'orders.state.not_connected')}
        </p>
      </section>
    );
  }

  const item = order.items[0] ?? null;
  const image = item?.imageUrl ?? order.detail?.lineItems.find((l) => l.imageUrl)?.imageUrl ?? null;
  const tracking = order.detail?.tracking.find((x) => x.url)?.url ?? null;
  const admin = shopifyAdminHref(order.adminUrl);
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
        </div>
      </div>

      <div className={styles.orderRow}>
        <OrderActions
          order={order}
          conversationId={conversationId}
          only={['refund', 'exchange_item']}
          label={(action) => (action === 'refund' ? t('refund') : t('replace'))}
          buttonClassName={styles.outlineSmall}
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
            data-testid="wall-order-shopify"
          >
            {t('shopify')}
          </a>
        ) : (
          <span className={styles.violetLink} data-off="" title={t('noShopify')}>
            {t('shopify')}
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
