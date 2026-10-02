import { getTranslations } from 'next-intl/server';

import { Link } from '@/i18n/navigation';

import {
  collapseToPeople,
  customerLabel,
  isKnownChannel,
  type CustomerRow,
} from '@/api/contracts/customers';

import fill from '@/design-system/styles/fill.module.css';
import { channelMark } from '@/features/inbox/channel-marks';

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
    /*
      ══════════════════════════════════════════════════════════════════════
      ★★ 04's LIST CARD — a window, rows at 67, a footer at its base
      ══════════════════════════════════════════════════════════════════════
      White, `1px #E6E2DA`, radius 14 (`fillCard`). Rows at `13px 18px`,
      `gap:14px`, `#F0EDE7` between them: a 40px initials disc with the
      channel's badge, the name at 14px/600 with the person's first tag as a
      chip, and under it a 12px line of how to reach them. The rows scroll
      inside the card (`fillScroll`); the footer bar sits at its base.

      Not drawn: 02's "what is true about them today" sentence, lifetime
      value, order count and last contact. None is on the list: the route
      returns contact fields only, and `lastInteractionAt` is never written.
    */
    <section className={`${fill.fillCard} ${styles.listCard}`} data-testid="customer-list">
      <ul className={`${fill.fillScroll} ${styles.rows}`}>
        {people.map(({ key, primary: row, channels }) => {
          const label = customerLabel(row);
          const mark = channelMark(channels[0] ?? row.channel ?? null);
          /*
            How to reach them, as one line: the handle we hold and every other
            channel they use. A WhatsApp row's name IS its number, so the
            number is not repeated under it.
          */
          const handle = row.phone ?? row.email ?? row.externalId;
          const reach = [
            handle && handle !== label ? handle : null,
            ...channels.map((channel) =>
              isKnownChannel(channel) ? t(`channel.${channel}` as 'channel.WHATSAPP') : channel,
            ),
          ].filter(Boolean);
          return (
            <li key={key} className={styles.row} data-testid={`customer-${row.id}`}>
              {/*
                ★ THE ROW IS A LINK. `row` is the PRIMARY contact of a person
                group — the rows are collapsed by `personId` — so this opens
                the person, not one of their channel identities.
              */}
              <Link className={styles.rowLink} href={`/customers/${row.id}`}>
                <span className={styles.avatarStack} aria-hidden="true">
                  <span className={styles.avatar}>{initialsOf(label)}</span>
                  <span className={styles.channelBadge} data-tone={mark.tone}>
                    <mark.Icon size={9} strokeWidth={2.4} />
                  </span>
                </span>
                <span className={styles.rowBody}>
                  <span className={styles.rowTop}>
                    <span className={styles.rowName}>{label ?? t('list.unnamed')}</span>
                    {row.tags[0] ? <span className={styles.rowChip}>{row.tags[0]}</span> : null}
                  </span>
                  <span className={styles.rowLine}>
                    {channels.map((channel) => (
                      <span
                        key={channel}
                        className="srOnly"
                        data-testid={`channel-${row.id}-${channel}`}
                      >
                        {isKnownChannel(channel)
                          ? t(`channel.${channel}` as 'channel.WHATSAPP')
                          : channel}
                      </span>
                    ))}
                    <span aria-hidden="true">{reach.join(' · ')}</span>
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>

      {/*
        02's footer bar: how many, and — one line, with the reason as its
        tooltip — the limit of the join. Two entries for one person are why
        a reader needs it, so it is on the card and not under a link.
      */}
      <p className={styles.listFooter}>
        <span data-testid="customer-count">
          {truncated
            ? t('list.footerTruncated', { shown: rows.length, total })
            : t('list.footer', { count: people.length })}
        </span>
        {' · '}
        <span data-testid="identity-limit" title={t('identityLimit')}>
          {t('identityShort')}
        </span>
      </p>
    </section>
  );
}

/** Up to two initials from the label's words; empty when there is none. */
function initialsOf(label: string | null): string {
  if (!label) return '';
  return label
    .split(/\s+/)
    .filter((word) => /\p{L}/u.test(word))
    .slice(0, 2)
    .map((word) => word.match(/\p{L}/u)?.[0]?.toUpperCase() ?? '')
    .join('');
}

/**
 * 04's right-hand "Who your customers are", by the channel they write on —
 * counted from the people on this list. Only when the list is whole: from a
 * truncated one it would describe the first 500, not the business.
 */
export async function Composition({
  rows,
  truncated,
}: {
  readonly rows: readonly CustomerRow[] | null;
  readonly truncated: boolean;
}) {
  if (rows === null || rows.length === 0 || truncated) return null;
  const t = await getTranslations('customers');
  const counts = new Map<string, number>();
  for (const { channels } of collapseToPeople(rows)) {
    for (const channel of channels) counts.set(channel, (counts.get(channel) ?? 0) + 1);
  }
  const max = Math.max(...counts.values());
  const bars = [...counts.entries()].sort((x, y) => y[1] - x[1]);
  return (
    <section className={styles.sideCard} data-testid="customer-composition">
      <h2 className={styles.sideTitle}>{t('composition.heading')}</h2>
      <p className={styles.sideNote}>{t('composition.byChannel')}</p>
      <ul className={styles.bars}>
        {bars.map(([channel, count]) => (
          <li key={channel} className={styles.bar} data-testid={`composition-${channel}`}>
            <span className={styles.barLabel}>
              {isKnownChannel(channel) ? t(`channel.${channel}` as 'channel.WHATSAPP') : channel}
            </span>
            <span className={styles.barTrack} aria-hidden="true">
              <span className={styles.barFill} style={{ inlineSize: `${(count / max) * 100}%` }} />
            </span>
            <span className={styles.barCount}>{count}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
