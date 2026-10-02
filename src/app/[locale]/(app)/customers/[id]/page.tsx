import { CustomerActions } from '@/features/customers/CustomerActions';
import { CustomerNotes } from '@/features/customers/CustomerNotes';
import { CustomerOrders } from '@/features/customers/CustomerOrders';
import {
  CustomerHeader,
  CustomerSide,
  CustomerTabs,
  CustomerTimelineList,
  parseCustomerTab,
} from '@/features/customers/CustomerScreen';
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
  searchParams?: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const tab = parseCustomerTab((await searchParams)?.tab);
  const detail = await loadCustomer(id);

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
            {/*
              Each tab's content is a sibling here, so the structural test can
              see it. 04c–04f get their own frames next; until then Orders,
              Actions and Notes are the existing panels, and Conversations the
              timeline's conversations.
            */}
            {tab === 'everything' ? <CustomerTimelineList detail={detail} /> : null}
            {tab === 'conversations' ? (
              <CustomerTimelineList detail={detail} only="conversations" />
            ) : null}
            {tab === 'orders' ? (
              <CustomerOrders orders={detail.orders} conversationId={detail.conversationId} />
            ) : null}
            {tab === 'actions' ? <CustomerActions actions={detail.actions} /> : null}
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
          <aside className={styles.cardSide}>
            <CustomerSide detail={detail} />
          </aside>
        </div>
      </div>
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('customers');
