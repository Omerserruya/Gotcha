import {
  ActionFilters,
  ActionsSide,
  CustomerActions,
  parseActionFilter,
} from '@/features/customers/CustomerActions';
import { CustomerNotes } from '@/features/customers/CustomerNotes';
import {
  OrderFilters,
  OrdersSide,
  OrdersTab,
  parseOrderFilter,
} from '@/features/customers/OrdersTab';
import {
  CustomerHeader,
  CustomerSide,
  CustomerTabs,
  CustomerTimelineList,
  parseCustomerTab,
} from '@/features/customers/CustomerScreen';
import {
  ChannelFilters,
  channelsOf,
  ConversationsSide,
  ConversationsTab,
  CustomerTabRow,
  CustomerTopBar,
  parseMore,
  timelineLimit,
} from '@/features/customers/CustomerSubtabs';
import styles from '@/features/customers/Customers.module.css';
import { loadCustomer } from '@/features/customers/load-customer';
import { PageContainer } from '@/shell/PageContainer';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * One customer — screen 04b.
 *
 * ── THE DEFECT THIS ROUTE EXISTS TO FIX ──
 * Screen 04 shipped as a list of people with no `<Link>`, no `href` and no
 * `onClick`. A merchant saw their customers and could not open one, and
 * nothing said why — the rows simply did not respond. A list of people
 * implies a destination, so that is worse than a missing screen.
 *
 * ── AND IT USES A DIFFERENT MEMORY TABLE FROM THE ONE THE LIST RULED OUT ──
 * The list's own note says there is no "GOTCHA remembers" because
 * `AgentCustomerMemory` is per-agent, last-turn-only and advisory by its own
 * comment. That is correct and it is a different table.
 *
 * This page reads `CustomerHistoricalMemory`, which is durable by
 * construction: its model comment keeps *"previously experienced a delayed
 * shipment"* and excludes *"is waiting for a package"*, which "was true for a
 * week in March and would be a lie the moment it is read back". The two
 * conclusions do not conflict, and saying so here stops somebody later
 * reading one as contradicting the other.
 */
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  /** `?tab=` — 04b's tabs: everything, conversations, orders, actions, notes. */
  searchParams?: Promise<{ tab?: string; channel?: string; more?: string; filter?: string }>;
}) {
  const { id } = await params;
  const query = (await searchParams) ?? {};
  const tab = parseCustomerTab(query.tab);
  /*
    `?more=` is 04c's "older conversations below": each step asks the
    timeline for 50 more events. Read only on that tab, so the other tabs
    keep the route's default page.
  */
  const more = tab === 'conversations' ? parseMore(query.more) : 0;
  const detail = await loadCustomer(id, more > 0 ? { limit: timelineLimit(more) } : {});

  if (tab === 'everything') {
    return (
      /*
        04b, measured: its own header across the panel (not the screen
        header — a 64px disc and a 30px name), then a main column and a 340px
        side, each scrolling inside itself.
      */
      <PageContainer layout="screen" flush>
        <div className={styles.cardScreen} data-testid="customer-card">
          <CustomerHeader detail={detail} contactId={id} />
          <div className={styles.cardBody}>
            <div className={styles.cardMain}>
              <CustomerTabs contactId={id} tab={tab} />
              <CustomerTimelineList detail={detail} />
            </div>
            <aside className={styles.cardSide}>
              <CustomerSide detail={detail} />
            </aside>
          </div>
        </div>
      </PageContainer>
    );
  }

  /*
    04c–04f: the compact header, the tab row with that tab's filters, then
    the tab's main column and its side. Each tab's parts are siblings here,
    so the structural test can see them.
  */
  const channels = channelsOf(detail);
  const orderFilter = parseOrderFilter(query.filter);
  const actionFilter = parseActionFilter(query.filter);
  const channel = query.channel && channels.includes(query.channel) ? query.channel : null;
  return (
    <PageContainer layout="screen" flush>
      <div className={styles.cardScreen} data-testid="customer-card" data-tab={tab}>
        <CustomerTopBar detail={detail} contactId={id} />
        <CustomerTabRow
          contactId={id}
          tab={tab}
          filters={
            tab === 'conversations' ? (
              <ChannelFilters contactId={id} channels={channels} current={channel} />
            ) : tab === 'orders' ? (
              <OrderFilters contactId={id} current={orderFilter} />
            ) : tab === 'actions' ? (
              <ActionFilters contactId={id} current={actionFilter} />
            ) : null
          }
        />
        <div className={styles.cardBody}>
          <div className={styles.subMain}>
            {tab === 'conversations' ? (
              <ConversationsTab detail={detail} contactId={id} channel={channel} more={more} />
            ) : null}
            {tab === 'orders' ? (
              <OrdersTab
                orders={detail.orders}
                conversationId={detail.conversationId}
                filter={orderFilter}
              />
            ) : null}
            {tab === 'actions' ? (
              <CustomerActions
                actions={detail.actions}
                approvals={detail.approvals}
                filter={actionFilter}
              />
            ) : null}
            {tab === 'notes' ? (
              /*
                `contactId` comes from the route rather than from the timeline:
                the notes are keyed on the contact we were ASKED for, and the
                timeline resolves merges.
              */
              <CustomerNotes
                notes={detail.notes}
                contactId={id}
                viewerUserId={detail.viewerUserId}
              />
            ) : null}
          </div>
          <aside className={styles.subSide}>
            {tab === 'conversations' ? (
              <ConversationsSide detail={detail} />
            ) : tab === 'orders' ? (
              <OrdersSide orders={detail.orders} />
            ) : tab === 'actions' ? (
              <ActionsSide actions={detail.actions} approvals={detail.approvals} />
            ) : (
              <CustomerSide detail={detail} />
            )}
          </aside>
        </div>
      </div>
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('customers');
