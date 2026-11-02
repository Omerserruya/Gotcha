import { getTranslations } from 'next-intl/server';

import { CustomerSearch } from '@/features/customers/CustomerSearch';
import { loadCustomers } from '@/features/customers/load-customers';
import { peopleToday } from '@/features/customers/people-today';
import { MobileCustomerList } from '@/features/mobile/customers/MobileCustomers';
import styles from '@/features/mobile/customers/mobile-customers.module.css';
import { OnWebsite } from '@/features/mobile/OnWebsite';
import { MobileBar } from '@/shell/mobile/MobileBar';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * The mobile customers: a search and the people, newest word first.
 *
 * ★ The desktop's search and loader: `CustomerSearch` keeps the query in the
 *   URL (`?q=`, replaced as it is typed, never pushed), `loadCustomers` picks
 *   the one field the query is shaped like and asks the store for an order
 *   number, and `peopleToday` collapses identities into people. Segments,
 *   money, duplicates and adding a customer stay on the website.
 *
 * ★ A failed read is said as one - never as an empty workspace.
 */
export default async function Page({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly q?: string }>;
}) {
  const t = await getTranslations('mobile');
  const tc = await getTranslations('customers');
  const { q } = await searchParams;
  const query = q?.trim() ?? '';
  const { rows, truncated, searchedField, orderSearched, conversations, quiet } =
    await loadCustomers(query, { today: true });
  const now = new Date();
  const people = rows === null ? [] : peopleToday(rows, conversations, quiet?.ids ?? null, now);

  return (
    <div className={styles.screen} data-testid="mobile-customers">
      <MobileBar title={t('customers.title')}>
        <div className={styles.search}>
          <CustomerSearch
            query={query}
            label={tc('search.label')}
            placeholder={tc('search.placeholder')}
            busyLabel={tc('search.busy')}
          />
        </div>
      </MobileBar>
      <div className={styles.scroll}>
        {rows === null ? (
          <p className={styles.note} role="status" data-testid="mobile-customers-unavailable">
            {tc('unavailable')}
          </p>
        ) : (
          <>
            <MobileCustomerList
              people={people}
              rowsEmpty={rows.length === 0}
              query={query}
              searchedField={searchedField}
              orderSearched={orderSearched}
              now={now}
            />
            {/*
              People, counted from what is drawn - and only when the list is
              whole: a truncated list's total counts records, not people.
            */}
            {people.length > 0 && !truncated ? (
              <p className={styles.count} data-testid="mobile-customers-count">
                {tc('list.count', { count: people.length })}
              </p>
            ) : null}
          </>
        )}
        <OnWebsite path="/customers" label={t('customers.website')} />
      </div>
    </div>
  );
}

export const generateMetadata = pageMetadata('primary.customers');
