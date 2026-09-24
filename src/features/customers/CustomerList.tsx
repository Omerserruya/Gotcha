import { getTranslations } from 'next-intl/server';

import { Link } from '@/i18n/navigation';

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
 * ── WHAT THE COLLAPSE ACTUALLY JOINS ──
 * **Not two channels.** The unifier that populates `personId` matches on
 * **phone only**, and Instagram contacts have no phone: `externalId` there is
 * an opaque page-scoped id. So a person who writes from WhatsApp and from
 * Instagram is two rows and will stay two rows.
 *
 * The phone-only rule is a safety argument rather than an oversight — nothing
 * customer-typed can reach `Contact.phone`, so phone matching structurally
 * cannot merge two strangers, where email matching could. What it does join
 * is a WhatsApp contact and a staff-entered contact carrying the same number,
 * which is real and worth having.
 *
 * So the screen **states the limit**, because the alternative is a reader
 * closing it believing cross-channel identity works. *"One identity per
 * human, however many channels they use"* is a missing capability, not a bug,
 * and the screen says what it does rather than what the design hoped.
 *
 * ── IT SAYS "PEOPLE", AND THAT PART IS STILL TRUE ──
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
 * ── THE COUNT COUNTS PEOPLE, WHICH IS NOT THE SAME AS ROWS ──
 * This screen's whole claim is *"People, not rows"*, so the header is the one
 * place that must not confuse the two — and it is the place that did: the
 * count was the number of contact ROWS under a label reading "people", while
 * the list below it showed the collapsed set. Two people on screen, three in
 * the header.
 *
 * So the number is now `collapseToPeople(rows).length` — it counts exactly
 * what is rendered, and it is exact because it is derived from the same array.
 *
 * **The server's `total` never appears beside the word "people".** It counts
 * rows before collapsing (and, until Backend moves the tombstone filter onto
 * it, rows that are not customers at all). When the page is genuinely full it
 * appears in its own sentence, called *records*, which is what it is.
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
  const people = collapseToPeople(rows);

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
      {/*
        People, counted from the same array that is rendered below — so the
        header and the list cannot disagree. That is the invariant, and the
        capture asserts it rather than asserting a number.
      */}
      {/*
        The limit, stated before the list rather than under it. A reader who
        sees two rows for one person needs to know why BEFORE concluding the
        product is broken — or, worse, concluding it worked.
      */}
      <p className={styles.identityLimit} data-testid="identity-limit">
        {t('identityLimit')}
      </p>

      <p className={styles.count} data-testid="customer-count">
        {t('list.count', { count: people.length })}
      </p>

      <ul className={styles.rows}>
        {people.map(({ key, primary: row, channels }) => {
          const label = customerLabel(row);
          return (
            <li key={key} className={styles.row} data-testid={`customer-${row.id}`}>
              {/*
                `displayName` is often null on a channel like WhatsApp, where
                the number IS how the business knows them. Falling back to the
                handle beats inventing "Unknown", which would be less
                informative than the identifier we hold.
              */}
              {/*
                ★ THE ROW IS A LINK, AND IT WAS NOT.

                This list shipped with no `<Link>`, no `href` and no
                `onClick`. A merchant saw a list of their customers and could
                not open one — which is worse than a missing screen, because
                a list of people implies a destination and this one had none.
                Nothing said so; it simply did not respond.

                `row` is the PRIMARY contact of a person group — the rows are
                collapsed by `personId` — so this opens the person, not one
                of their channel identities.
              */}
              <Link className={styles.rowName} href={`/customers/${row.id}`}>
                {label ?? t('list.unnamed')}
              </Link>

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
        The route returns at most 500 rows. Said in its own sentence and in
        RECORDS, never people — `total` counts rows before collapsing, so
        attaching it to "people" is the mismatch this screen just had.
      */}
      {truncated ? (
        <p className={styles.truncated} data-testid="customers-truncated">
          {t('list.truncated', { shown: rows.length, total })}
        </p>
      ) : null}
    </div>
  );
}
