import { getTranslations } from 'next-intl/server';

import { customerLabel, isKnownChannel, type CustomerRow } from '@/api/contracts/customers';

import styles from './Customers.module.css';

/**
 * Screen 04 — the customer list.
 *
 * ── WHY THIS DOES NOT SAY "PEOPLE" ──
 * The design opens with *"People, not rows. One identity per human however
 * many channels they use."* **The endpoint returns rows, not people.**
 *
 * `Contact` carries `personId` — *"multiple contact rows sharing the same
 * personId represent one real human across WA/IG/Gmail/Messenger"* — and
 * `mergedIntoId`, a soft-merge pointer whose row is deliberately kept so
 * webhook lookups still resolve. **The segment endpoint's `select` returns
 * neither, and its `where` does not filter merged rows.**
 *
 * So one person on two channels is two rows here, and after a merge both the
 * survivor and the tombstone appear. Nothing on this side can collapse or hide
 * them. The screen therefore counts **contacts**, says so, and does not imply
 * a row is a human — which is the honest version until those two fields are
 * added to the select.
 *
 * ── AND WHY THERE IS NO SORT CONTROL ──
 * The route hardcodes `orderBy: { lastSeenAt: "desc" }` on a column nothing
 * writes. A sort control would offer an option the server ignores, and a
 * "most recent first" label would claim an order that is not there.
 */
export async function CustomerList({
  rows,
  total,
  truncated,
  searchedFields,
  query,
}: {
  readonly rows: readonly CustomerRow[];
  readonly total: number;
  readonly truncated: boolean;
  readonly searchedFields: readonly string[];
  readonly query: string;
}) {
  const t = await getTranslations('customers');

  if (rows.length === 0) {
    return (
      <div className={styles.empty} data-testid="customers-empty">
        {query ? (
          <>
            <p className={styles.emptyLead}>{t('search.noneLead', { query })}</p>
            {/*
              Which fields were actually searched, because the vocabulary has
              no name case. Reporting a bare "no results" for a name query
              would be telling someone their customer does not exist when the
              truth is that we never looked at the field they typed into.
            */}
            <p className={styles.emptyBody} data-testid="search-fields">
              {searchedFields.includes('email')
                ? t('search.lookedAtEmail')
                : t('search.lookedAtPhone')}
            </p>
          </>
        ) : (
          <p className={styles.emptyLead}>{t('list.none')}</p>
        )}
      </div>
    );
  }

  return (
    <div className={styles.list} data-testid="customer-list">
      {/*
        "Contacts", not "people" — see the note above. The count is the route's
        real `prisma.contact.count`, so it is the number that match rather than
        the number on screen.
      */}
      <p className={styles.count} data-testid="customer-count">
        {t('list.count', { count: total })}
      </p>

      <ul className={styles.rows}>
        {rows.map((row) => {
          const label = customerLabel(row);
          return (
            <li key={row.id} className={styles.row} data-testid={`customer-${row.id}`}>
              {/*
                `displayName` is often null on a channel like WhatsApp, where
                the number IS how the business knows them. Falling back to the
                handle beats inventing "Unknown", which would be less
                informative than the identifier we hold.
              */}
              <span className={styles.rowName}>{label ?? t('list.unnamed')}</span>

              <span className={styles.rowChannel} data-testid={`channel-${row.id}`}>
                {isKnownChannel(row.channel)
                  ? t(`channel.${row.channel}` as 'channel.WHATSAPP')
                  : row.channel}
              </span>

              {row.email && row.email !== label ? (
                <span className={styles.rowDetail}>{row.email}</span>
              ) : null}

              {row.tags.length > 0 ? (
                <ul className={styles.tags}>
                  {row.tags.map((tag) => (
                    <li key={tag} className={styles.tag}>
                      {tag}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>

      {/*
        The route counts everything and returns at most 500. A list that shows
        fewer than it counted must say so rather than letting the count read as
        a description of what is on screen.
      */}
      {truncated ? (
        <p className={styles.truncated} data-testid="customers-truncated">
          {t('list.truncated', { shown: rows.length, total })}
        </p>
      ) : null}
    </div>
  );
}
