import { getTranslations } from 'next-intl/server';

import { CustomerList } from '@/features/customers/CustomerList';
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
 * Matched against phone and email only, because the rule vocabulary has
 * thirteen cases and **no name case**. The screen says which fields it looked
 * at rather than reporting a bare "no results" — telling someone their
 * customer does not exist, when we never examined the field they typed into,
 * is the worse of the two failures.
 */
export default async function Page({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly q?: string }>;
}) {
  const t = await getTranslations('customers');
  const { q } = await searchParams;
  const query = q?.trim() ?? '';
  const { rows, total, truncated, searchedFields } = await loadCustomers(query);

  return (
    <PageContainer title={t('title')} description={t('description')}>
      {/*
        A plain GET form: the query lives in the URL, so a search is linkable
        and survives a reload, and the page stays a server component.
      */}
      <form className={styles.search} action="" method="get" data-testid="customer-search">
        <label className={styles.searchLabel} htmlFor="customer-q">
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
        <button type="submit" className={styles.searchSubmit}>
          {t('search.label')}
        </button>
      </form>

      {rows === null ? (
        // A failed read and an empty tenant are opposite facts: one means
        // nobody has talked to you, the other means you do not know.
        <p data-testid="customers-unavailable">{t('unavailable')}</p>
      ) : (
        <CustomerList
          rows={rows}
          total={total}
          truncated={truncated}
          searchedFields={searchedFields}
          query={query}
        />
      )}
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('primary.customers');
