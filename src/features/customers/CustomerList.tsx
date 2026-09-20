import { getTranslations } from 'next-intl/server';

import {
  collapseToPeople,
  customerLabel,
  isKnownChannel,
  type CustomerRow,
} from '@/api/contracts/customers';

import styles from './Customers.module.css';

/**
 * Screen 04 — the customer list.
 *
 * ── IT SAYS "PEOPLE" NOW, AND ONLY BECAUSE IT CAN ──
 * The design opens with *"People, not rows. One identity per human however
 * many channels they use."* That was unbuildable until 2026-09-20: the
 * endpoint returned neither `personId` nor `mergedIntoId`, so one human on two
 * channels was two rows and a merged-away row was still listed.
 *
 * Both fields now come back and the route filters tombstones itself, so rows
 * collapse by `personId` and the design's first line is finally true. A row
 * with no `personId` is its own person — the unifier assigns one only when a
 * shared identifier is found, so its absence means *"not known to be the same
 * human"*, never *"the same as the others"*.
 *
 * ── THE COUNT IS NOT THE SERVER'S TOTAL ──
 * The route's `count` still includes the merged-away rows its `findMany`
 * excludes, so on a tenant that has ever merged `total` exceeds the list with
 * nothing truncated. The number shown is the one this screen can stand
 * behind: the rows themselves, unless the page was genuinely filled.
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
  searchedField,
  query,
}: {
  readonly rows: readonly CustomerRow[];
  readonly total: number;
  readonly truncated: boolean;
  readonly searchedField: 'name' | 'phone' | 'email' | null;
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
            {/*
              What was searched, and what still cannot be. Name, phone and
              email all work now; **order number does not and cannot** —
              orders are not local to this platform. Saying so beats a bare
              "no results", which would tell someone their customer does not
              exist when we never looked at what they typed.
            */}
            <p className={styles.emptyBody} data-testid="search-fields">
              {t(`search.lookedAt.${searchedField ?? 'name'}` as 'search.lookedAt.name')}
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
        {truncated ? t('list.countApprox', { count: total }) : t('list.count', { count: total })}
      </p>

      <ul className={styles.rows}>
        {collapseToPeople(rows).map(({ key, primary: row, channels }) => {
          const label = customerLabel(row);
          return (
            <li key={key} className={styles.row} data-testid={`customer-${row.id}`}>
              {/*
                `displayName` is often null on a channel like WhatsApp, where
                the number IS how the business knows them. Falling back to the
                handle beats inventing "Unknown", which would be less
                informative than the identifier we hold.
              */}
              <span className={styles.rowName}>{label ?? t('list.unnamed')}</span>

              {/*
                Every channel this person reaches you on, not just the first.
                Channel is a mark on the row and never a section — the design
                is right about that, and collapsing by `personId` is what
                makes it possible to show more than one.
              */}
              {channels.map((channel) => (
                <span
                  key={channel}
                  className={styles.rowChannel}
                  data-testid={`channel-${row.id}-${channel}`}
                >
                  {isKnownChannel(channel)
                    ? t(`channel.${channel}` as 'channel.WHATSAPP')
                    : channel}
                </span>
              ))}

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
