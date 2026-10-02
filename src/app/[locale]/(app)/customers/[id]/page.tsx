import { CustomerActions } from '@/features/customers/CustomerActions';
import { CustomerDetail } from '@/features/customers/CustomerDetail';
import { CustomerNotes } from '@/features/customers/CustomerNotes';
import { CustomerOrders } from '@/features/customers/CustomerOrders';
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
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await loadCustomer(id);

  return (
    <PageContainer>
      <CustomerDetail detail={detail} />
      {/*
        Screen 04d, BESIDE the detail rather than inside it.

        Both are async server components, and nesting one in the other makes
        the outer untestable — awaiting it yields a tree with an unresolved
        async node and nothing renders. Screen 11 hit this with `ScanPanel`
        and placed it the same way.
      */}
      <CustomerOrders orders={detail.orders} conversationId={detail.conversationId} />
      {/*
        Screen 04e, a SIBLING for the same reason 04d is: nested inside
        another async component it would be an unresolved node to the
        structural test, which does not run it. (React renders it —
        the deployed inbox renders nested async components inside `<Suspense>` (8bb92d6, measured in a browser).)
      */}
      <CustomerActions actions={detail.actions} />
      {/*
        Screen 04f. A sibling for the same reason 04d and 04e are: it keeps
        the panel visible to the structural test.

        `contactId` comes from the route rather than from the timeline: the
        notes are keyed on the contact we were ASKED for, and the timeline
        resolves merges. Passing the resolved one would write a note against
        a different id than the page the author is looking at.
      */}
      <CustomerNotes notes={detail.notes} contactId={id} viewerUserId={detail.viewerUserId} />
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('customers');
