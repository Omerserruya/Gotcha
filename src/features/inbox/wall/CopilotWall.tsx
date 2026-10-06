import { getFormatter, getTranslations } from 'next-intl/server';

import { orderToExpand, type Money } from '@/api/contracts/customer-orders';
import { UserText } from '@/design-system/primitives/text/UserText';
import { Link } from '@/i18n/navigation';

import { initials } from '../initials';
import type { ConversationDetail } from '../load-inbox';
import { loadWallPerson, type WallMemory, type WallPerson } from './load-wall';
import { ActivityStrip, WorkingState } from './Activity';
import { OrdersCarousel } from './OrdersCarousel';
import { SuggestionCarousel } from './SuggestionCarousel';
import { WallBody } from './WallBody';
import { factLabel, firstOrder, ordersView, refundCount } from './wall-model';
import styles from './Wall.module.css';

/**
 * 02 Inbox's dark right-hand wall, top to bottom (Omer, 2026-10-06):
 *
 *   header      Copilot · Working on this · stop             → WallHeader
 *   what it did steps, dots, results                         → ActivityStrip
 *   answers     Three ways to answer · 1 of 3                → SuggestionCarousel
 *   order       Order #1842 · 2 of 6 ‹ ›                     → OrdersCarousel
 *   person      name, since, Lifetime/Orders/Refunds/Mood     → PersonBlock
 *   history     History across all channels ›                → WallBody
 *   ask         Ask Copilot anything…                        → AskCopilot
 *
 * ★ Where a value has no source yet the element keeps its shape and says
 *   "-", with a title naming what it waits for. Never a zero, never a guess.
 */

/**
 * 02's 45px header: "Copilot", then "Working on this · stop" while a step of
 * the AI's runs (`WorkingState`, from the activity the provider holds).
 */
export async function WallHeader({
  conversationId,
  aiDriving,
}: {
  readonly conversationId: string | null;
  readonly aiDriving: boolean;
}) {
  const t = await getTranslations('inbox.wall');
  return (
    <div className={styles.header} data-testid="wall-header">
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.headerName}>{t('name')}</span>
      <WorkingState conversationId={conversationId} aiDriving={aiDriving} />
    </div>
  );
}

/** The wall's body for one open conversation. */
export async function CopilotWall({
  detail,
  conversation,
}: {
  readonly detail: Promise<ConversationDetail>;
  readonly conversation: {
    readonly id: string;
    /** The row's own (Backend c240bea4); `null` for an unidentified visitor. */
    readonly contactId: string | null;
    readonly customerName: string | null;
    readonly channel: string | null;
  };
}) {
  const { timeline, orders } = await detail;
  const contactId = conversation.contactId ?? timeline?.contact?.id ?? null;
  const t = await getTranslations('inbox.wall.person');

  /*
   * ★ AN UNIDENTIFIED VISITOR (Backend c240bea4): Shopify live chat has no
   *   contact until the visitor is identified - by design, not a failed
   *   read. One line says so, in place of three blocks of "-"; nothing is
   *   read for a person who is not one yet.
   */
  if (contactId === null && conversation.channel === 'SHOPIFY_LIVE_CHAT') {
    return (
      <WallBody history={null} why="" showHistory={false}>
        <ActivityStrip />
        <SuggestionCarousel conversationId={conversation.id} />
        <p className={styles.visitor} data-testid="wall-visitor">
          {t('visitor')}
        </p>
      </WallBody>
    );
  }

  const person = await loadWallPerson(contactId, conversation.id);
  const view = ordersView(person.orders, orders);

  return (
    <WallBody history={person.history} why={contactId === null ? t('noContact') : t('unread')}>
      <ActivityStrip />
      <SuggestionCarousel conversationId={conversation.id} />
      <OrdersCarousel
        source={view.source}
        state={view.state}
        reason={view.reason}
        missing={view.missing}
        orders={view.orders}
        start={firstOrder(view.orders, orderToExpand(view.orders))}
        conversationId={conversation.id}
      />
      <PersonBlock
        name={timeline?.contact?.displayName ?? conversation.customerName}
        contactId={contactId}
        person={person}
        shop={orders?.state === 'ok' ? (orders.data?.summary ?? orders.summary ?? null) : null}
        createdAt={timeline?.contact?.createdAt ?? null}
        refunds={refundCount(
          view.orders,
          orders?.state === 'ok'
            ? (orders.data?.summary?.orderCount ?? null)
            : typeof person.commerce === 'object'
              ? (person.commerce?.orderCount ?? null)
              : null,
        )}
      />
    </WallBody>
  );
}

async function PersonBlock({
  name,
  contactId,
  person,
  shop,
  createdAt,
  refunds,
}: {
  readonly name: string | null;
  readonly contactId: string | null;
  readonly person: WallPerson;
  /** The store's own summary of this person, through the conversation's link. */
  readonly shop: {
    readonly orderCount: number;
    readonly shopCurrencyTotal?: Money | null;
    readonly customerSince?: string | null;
    readonly defaultAddress?: string | null;
  } | null;
  readonly createdAt: string | null;
  readonly refunds: number | null;
}) {
  const t = await getTranslations('inbox.wall.person');
  const format = await getFormatter();

  const money = (amount: number, currency: string) =>
    format.number(amount, { style: 'currency', currency, maximumFractionDigits: 0 });

  /*
   * The store's summary first: it is the same read as the order carousel
   * above, so the two cannot disagree. The bulk facts only when there is a
   * contact to read them for.
   */
  const facts = typeof person.commerce === 'object' ? person.commerce : null;
  const lifetime =
    shop?.shopCurrencyTotal?.amount != null && shop.shopCurrencyTotal.currency
      ? money(shop.shopCurrencyTotal.amount, shop.shopCurrencyTotal.currency)
      : facts && facts.currency
        ? money(facts.lifetimeValue, facts.currency)
        : null;
  const orders = shop ? shop.orderCount : facts ? facts.orderCount : null;
  const since = shop?.customerSince ?? createdAt;
  const why = contactId === null ? t('noContact') : t('unread');

  return (
    <section className={styles.person} data-testid="wall-person">
      <div className={styles.personHead}>
        <span className={styles.avatar} aria-hidden="true">
          {initials(name)}
        </span>
        <span className={styles.personName}>
          <span>{name?.trim() ? <UserText>{name}</UserText> : t('unnamed')}</span>
          <span className={styles.meta} data-testid="wall-person-since">
            {since ? (
              t('since', {
                date: format.dateTime(new Date(since), { month: 'long', year: 'numeric' }),
              })
            ) : (
              <span title={why}>-</span>
            )}
            {shop?.defaultAddress ? (
              <>
                {' · '}
                <UserText>{shop.defaultAddress}</UserText>
              </>
            ) : null}
          </span>
        </span>
        {contactId ? (
          <Link
            className={styles.violetLink}
            href={`/customers/${contactId}`}
            data-testid="wall-profile"
          >
            {t('profile')}
          </Link>
        ) : (
          <span className={styles.violetLink} data-off="" title={t('noContact')}>
            {t('profile')}
          </span>
        )}
      </div>

      <dl className={styles.stats}>
        <Stat label={t('lifetime')} value={lifetime} why={why} testid="lifetime" />
        <Stat
          label={t('orders')}
          value={orders === null ? null : format.number(orders)}
          why={why}
          testid="orders"
        />
        <Stat
          label={t('refunds')}
          value={refunds === null ? null : refunds === 0 ? t('none') : format.number(refunds)}
          why={t('refundsPartial')}
          testid="refunds"
        />
        <Stat
          label={t('mood')}
          value={person.mood ? t(`moods.${person.mood}`) : null}
          why={contactId === null ? t('noContact') : t('noMood')}
          tone={person.mood ?? undefined}
          testid="mood"
        />
      </dl>

      <Memory memory={person.memory} />
    </section>
  );
}

/**
 * What GOTCHA learned - exactly what the AI is given (Backend cd504002, the
 * prompt's own loaders): the facts it is told not to ask again, each with a
 * quiet word on where it came from; then "From before", an imported
 * history's summary, marked as background rather than confirmed.
 */
async function Memory({ memory }: { readonly memory: WallMemory | null }) {
  const t = await getTranslations('inbox.wall.person');
  if (memory === null) {
    return (
      <p className={styles.note} data-testid="wall-memory-unread" title={t('unread')}>
        {t('learned')} · -
      </p>
    );
  }
  if (memory.facts.length === 0 && memory.historical === null) {
    return (
      <div data-testid="wall-memory-none">
        <p className={styles.note}>{t('noFacts')}</p>
        <p className={styles.note}>{t('howItLearns')}</p>
      </div>
    );
  }
  return (
    <div className={styles.memory} data-testid="wall-memory">
      {memory.facts.length > 0 ? (
        <dl className={styles.facts} aria-label={t('learned')}>
          {memory.facts.map((fact, i) => (
            <div
              key={`${fact.key}-${i}`}
              className={styles.fact}
              data-testid={`wall-fact-${fact.key}`}
            >
              <dt>{factLabel(fact.key)}</dt>
              <dd>
                <UserText>{fact.value}</UserText>
                {fact.source ? (
                  <span className={styles.meta}>
                    {' · '}
                    {t(`source.${fact.source}`)}
                  </span>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {memory.historical ? (
        <div className={styles.fromBefore} data-testid="wall-memory-before">
          <span className={styles.meta} title={t('fromBeforeTitle')}>
            {t('fromBefore')}
          </span>
          {memory.historical.summary ? (
            <p className={styles.note}>
              <UserText>{memory.historical.summary}</UserText>
            </p>
          ) : null}
          {memory.historical.facts.length > 0 ? (
            <ul className={styles.beforeFacts}>
              {memory.historical.facts.map((fact, i) => (
                <li key={i}>
                  <UserText>{fact}</UserText>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Stat({
  label,
  value,
  why,
  tone,
  testid,
}: {
  readonly label: string;
  readonly value: string | null;
  readonly why: string;
  readonly tone?: string;
  readonly testid: string;
}) {
  return (
    <div className={styles.stat}>
      <dt>{label}</dt>
      <dd
        data-testid={`wall-stat-${testid}`}
        data-tone={tone}
        title={value === null ? why : undefined}
      >
        {value ?? '-'}
      </dd>
    </div>
  );
}
