import { CustomerDetail } from '@/features/customers/CustomerDetail';
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
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('customers');
