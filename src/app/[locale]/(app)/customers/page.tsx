import { getTranslations } from 'next-intl/server';

import { collapseToPeople } from '@/api/contracts/customers';
import { CustomerList, ReachOut, Segments, WhoTheyAre } from '@/features/customers/CustomerList';
import { AddCustomer } from '@/features/customers/AddCustomer';
import { DuplicateCard } from '@/features/customers/DuplicateCard';
import {
  duplicateSuggestion,
  inSegment,
  peopleToday,
  segmentOf,
} from '@/features/customers/people-today';
import styles from '@/features/customers/Customers.module.css';
import { loadCustomers } from '@/features/customers/load-customers';
import { PageContainer } from '@/shell/PageContainer';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * Customers — screen 04.
 *
 * ── WHAT IS ABSENT, AND WHY ──
 * **No segment bar.** Of the design's five — *talking to you now, unhappy
 * lately, best, gone quiet, wholesale* — three need sources that do not exist
 * (conversation state, sentiment, commerce value), one needs a writer that
 * does not run, and *wholesale* needs tags no contact carries. Five chips that
 * all return zero would be five controls that do nothing. Omer dropped them.
 *
 * **No sort control and no "most recent first".** The route hardcodes
 * `orderBy: { lastSeenAt: "desc" }` on a column nothing writes, so rows arrive
 * in whatever order Postgres returns for all-nulls. A control here would offer
 * an option the server ignores.
 *
 * **No lifetime value and no order count.** They are not on `Contact` at all —
 * they resolve to `shopify.get_customer` + `shopify.get_customer_orders`, two
 * live uncached vendor calls **per customer**. In a list of twenty that is
 * forty round trips, which is the approvals finding at list scale.
 *
 * **No "GOTCHA remembers", no notes.** `AgentCustomerMemory` is per-agent,
 * last-turn-only and advisory by its own comment; there is no `Note` model at
 * all.
 *
 * ── SEARCH ──
 * Name, phone and email all work (the `name` case landed 2026-09-20). Rules
 * are ANDed by the route, so one field is chosen from the shape of the query.
 * **Order number is still unsearchable and always will be** — orders are not
 * local to this platform — so the empty state names what was looked at rather
 * than reporting a bare "no results", which would tell someone their customer
 * does not exist when we never examined what they typed.
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
  const { rows, total, truncated, searchedField, conversations, quiet } = await loadCustomers(
    query,
    { today: true },
  );
  const now = new Date();
  const everyone = rows === null ? [] : peopleToday(rows, conversations, quiet?.ids ?? null, now);
  const shown = everyone.filter((person) => inSegment(person, segment));

  /*
   * ★ 04: the count IS the title — "4,180 customers". People, counted from
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
        <div className={styles.headActions}>
          <form className={styles.search} action="" method="get" data-testid="customer-search">
            <label className="srOnly" htmlFor="customer-q">
              {t('search.label')}
            </label>
            <input
              id="customer-q"
              name="q"
              type="search"
              className={styles.searchInput}
              defaultValue={query}
              placeholder={t('search.placeholder')}
              data-testid="customer-search-input"
            />
          </form>
          {/* 02's "Add a customer" — live: name and phone, never a duplicate. Outside the search form, so Enter there never searches. */}
          <AddCustomer />
        </div>
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
            <CustomerList
              people={shown}
              shownOf={truncated ? total : everyone.length}
              rowsEmpty={rows.length === 0}
              searchedField={searchedField}
              query={query}
              now={now}
            />
            <aside className={styles.side}>
              <ReachOut
                quiet={quiet === null ? null : { count: quiet.count, capped: quiet.capped }}
              />
              <DuplicateCard pair={duplicateSuggestion(rows)} />
              <WhoTheyAre />
            </aside>
          </div>
        </>
      )}
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('primary.customers');
