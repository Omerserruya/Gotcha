import { getTranslations } from 'next-intl/server';

import { collapseToPeople } from '@/api/contracts/customers';
import { CustomerList, ReachOut, Segments, WhoTheyAre } from '@/features/customers/CustomerList';
import { CustomerSelection } from '@/features/customers/CustomerSelection';
import { CustomersActions } from '@/features/customers/CustomersActions';
import { DuplicateCard } from '@/features/customers/DuplicateCard';
import { inSegment, peopleToday, segmentOf } from '@/features/customers/people-today';
import styles from '@/features/customers/Customers.module.css';
import { loadCommerce, loadInsights, loadSegments } from '@/features/customers/load-customer-facts';
import { loadCustomers } from '@/features/customers/load-customers';
import { loadSuggestions } from '@/features/customers/load-suggestions';
import { PageContainer } from '@/shell/PageContainer';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * Customers - screen 04.
 *
 * ── WHAT IS ABSENT, AND WHY ──
 * **No segment bar.** Of the design's five - *talking to you now, unhappy
 * lately, best, gone quiet, wholesale* - three need sources that do not exist
 * (conversation state, sentiment, commerce value), one needs a writer that
 * does not run, and *wholesale* needs tags no contact carries. Five chips that
 * all return zero would be five controls that do nothing. Omer dropped them.
 *
 * **No sort control and no "most recent first".** The route hardcodes
 * `orderBy: { lastSeenAt: "desc" }` on a column nothing writes, so rows arrive
 * in whatever order Postgres returns for all-nulls. A control here would offer
 * an option the server ignores.
 *
 * **Value, orders, situation and mood are read in bulk** (backend 63985641,
 * 01bb7b6e): one commerce read and one insights read per hundred people
 * shown, never a vendor call per row. A store that is absent or unreachable
 * is "-" with its reason, never "no orders yet".
 *
 * **No "GOTCHA remembers", no notes.** `AgentCustomerMemory` is per-agent,
 * last-turn-only and advisory by its own comment; there is no `Note` model at
 * all.
 *
 * ── SEARCH ──
 * Name, phone and email all work (the `name` case landed 2026-09-20). Rules
 * are ANDed by the route, so one field is chosen from the shape of the query.
 * A query shaped like an order number also asks the store (`by-order`), and
 * the customer it finds is ADDED to the phone match, never instead of it. The
 * empty state names what was looked at rather than a bare "no results".
 */
export default async function Page({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly q?: string; readonly segment?: string }>;
}) {
  const t = await getTranslations('customers');
  const { q, segment: rawSegment } = await searchParams;
  const query = q?.trim() ?? '';
  const segment = segmentOf(rawSegment);
  const [
    { rows, total, truncated, searchedField, orderSearched, conversations, quiet },
    segments,
    suggestions,
  ] = await Promise.all([loadCustomers(query, { today: true }), loadSegments(), loadSuggestions()]);
  // The server's pairs only (Backend 83579ac8); none, or an unread list, is no card.
  const suggestion = suggestions?.[0] ?? null;
  const now = new Date();
  const everyone = rows === null ? [] : peopleToday(rows, conversations, quiet?.ids ?? null, now);
  const shown = everyone.filter((person) => inSegment(person, segment));
  // What each shown person is worth and what is going on - every identity, in bulk.
  const shownIds = shown.flatMap((person) => person.members.map((member) => member.id));
  const [commerce, insights] = await Promise.all([loadCommerce(shownIds), loadInsights(shownIds)]);

  /*
   * ★ 04: the count IS the title - "4,180 customers". People, counted from
   *   the rows collapsed by `personId`, and only when the list is whole: a
   *   truncated list's `total` counts records, and attaching it to "customers"
   *   is the mismatch this screen once had.
   */
  const people = rows === null ? null : collapseToPeople(rows).length;
  const title =
    people !== null && people > 0 && !truncated ? t('titleCount', { count: people }) : t('title');

  return (
    <PageContainer
      layout="screen"
      /* A window: the header stays, the list scrolls inside its card. */
      fill
      title={title}
      description={t('subline')}
      actions={
        /*
          A plain GET form: the query lives in the URL, so a search is
          linkable and survives a reload, and the page stays a server
          component. 02's search field, 260 wide; Enter searches.
        */
        <CustomersActions query={query} />
      }
    >
      {rows === null ? (
        // A failed read and an empty tenant are opposite facts: one means
        // nobody has talked to you, the other means you do not know.
        <p data-testid="customers-unavailable">{t('unavailable')}</p>
      ) : (
        <>
          <Segments
            segment={segment}
            everyone={everyone.length}
            talking={conversations === null ? null : everyone.filter((p) => p.talking).length}
            quiet={quiet === null ? null : { count: quiet.count, capped: quiet.capped }}
          />
          <div className={styles.columns}>
            <CustomerSelection>
              <CustomerList
                people={shown}
                shownOf={truncated ? total : everyone.length}
                rowsEmpty={rows.length === 0}
                searchedField={searchedField}
                orderSearched={orderSearched}
                query={query}
                commerce={commerce}
                insights={insights}
                now={now}
              />
            </CustomerSelection>
            <aside className={styles.side}>
              <ReachOut
                quiet={quiet === null ? null : { count: quiet.count, capped: quiet.capped }}
              />
              {/* Keyed by the pair: the next one opens fresh, never under the last one's result. */}
              {suggestion ? <DuplicateCard key={suggestion.id} suggestion={suggestion} /> : null}
              <WhoTheyAre segments={segments} />
            </aside>
          </div>
        </>
      )}
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('primary.customers');
