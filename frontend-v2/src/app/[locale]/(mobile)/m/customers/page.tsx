import { getTranslations } from 'next-intl/server';

import { loadCommerce } from '@/features/customers/load-customer-facts';
import { loadCustomers } from '@/features/customers/load-customers';
import { inSegment, peopleToday, segmentOf } from '@/features/customers/people-today';
import { MobileCustomerSearch } from '@/features/mobile/customers/MobileCustomerSearch';
import {
  MobileCustomerChips,
  MobileCustomerList,
} from '@/features/mobile/customers/MobileCustomers';
import styles from '@/features/mobile/customers/mobile-customers.module.css';
import ui from '@/features/mobile/mobile-ui.module.css';
import { OnWebsite } from '@/features/mobile/OnWebsite';
import { MobileBar } from '@/shell/mobile/MobileBar';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * The mobile customers: a search, the segment chips and the people, newest
 * word first - VIEW ONLY, so no "add a customer" button.
 *
 * ★ The desktop's search, loader and segment: the query is the URL's `?q=`,
 *   `loadCustomers` picks the one field the query is shaped like and asks
 *   the store for an order number, `peopleToday` collapses identities into
 *   people, `?segment=quiet` is the website's own, and `loadCommerce` is the
 *   website's bulk read of what each shown person is worth.
 * ★ Not the website's in one way: a website visitor who never left a phone or
 *   an email is not listed (`identified`), since the phone can do nothing
 *   with them. The website still lists them.
 *
 * ★ A failed read is said as one - never as an empty workspace.
 */
export default async function Page({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly q?: string; readonly segment?: string }>;
}) {
  const t = await getTranslations('mobile');
  const tc = await getTranslations('customers');
  const { q, segment: rawSegment } = await searchParams;
  const query = q?.trim() ?? '';
  // Only everyone and the quiet: the phone draws no "talking now" chip.
  const segment = segmentOf(rawSegment) === 'quiet' ? 'quiet' : 'everyone';
  const { rows, truncated, searchedField, orderSearched, conversations, quiet } =
    // Anonymous website visitors left out (Omer, 2026-11-03): nobody to reach on a phone.
    await loadCustomers(query, { today: true, identified: true });
  const now = new Date();
  const everyone = rows === null ? [] : peopleToday(rows, conversations, quiet?.ids ?? null, now);
  const people = everyone.filter((person) => inSegment(person, segment));
  const commerce = await loadCommerce(people.flatMap((p) => p.members.map((member) => member.id)));

  return (
    <div className={ui.screen} data-testid="mobile-customers">
      <MobileBar title={t('customers.title')} />
      <div className={ui.scroll}>
        <MobileCustomerSearch
          query={query}
          label={tc('search.label')}
          placeholder={t('customers.searchPlaceholder')}
          busyLabel={tc('search.busy')}
        />
        {rows === null ? (
          <p className={ui.empty} role="status" data-testid="mobile-customers-unavailable">
            {tc('unavailable')}
          </p>
        ) : (
          <>
            <MobileCustomerChips segment={segment} query={query} quiet={quiet} />
            {people.length === 0 ? (
              // The desktop's empty state: what was looked at, never a bare "no results".
              <div className={ui.empty} data-testid="mobile-customers-empty">
                {query ? (
                  <>
                    <span className={ui.emptyTitle}>{tc('search.noneLead', { query })}</span>
                    <span>
                      {orderSearched
                        ? tc('search.lookedAt.order')
                        : tc(
                            `search.lookedAt.${searchedField ?? 'name'}` as 'search.lookedAt.name',
                          )}
                    </span>
                  </>
                ) : rows.length === 0 ? (
                  <span className={ui.emptyTitle}>{tc('list.none')}</span>
                ) : (
                  <span className={ui.emptyTitle}>{t('customers.noneQuiet')}</span>
                )}
              </div>
            ) : (
              <>
                {/*
                  People, counted from what is drawn - and only when the list
                  is whole: a truncated list's total counts records, not people.
                */}
                {truncated ? null : (
                  <p className={styles.count} data-testid="mobile-customers-count">
                    {t('customers.count', { count: people.length })}
                  </p>
                )}
                <MobileCustomerList people={people} commerce={commerce} />
              </>
            )}
          </>
        )}
        <p className={ui.foot}>
          <OnWebsite path="/customers" label={t('customers.website')} className={ui.footLink} />
        </p>
      </div>
    </div>
  );
}

export const generateMetadata = pageMetadata('primary.customers');
