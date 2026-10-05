import { getLocale, getTranslations } from 'next-intl/server';

import { Link } from '@/i18n/navigation';

import { customerLabel, isKnownChannel } from '@/api/contracts/customers';

import fill from '@/design-system/styles/fill.module.css';
import { channelMark } from '@/features/inbox/channel-marks';

import type { CommerceSegments, Insight } from '@/api/contracts/customer-facts';

import type { CommerceFacts } from './load-customer-facts';
import { sinceWords, type PersonToday, type Segment } from './people-today';
import { chipOf, insightOf, money, reasonKey, situationLine, valueCell } from './row-facts';
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
  people,
  shownOf,
  rowsEmpty,
  searchedField,
  orderSearched = false,
  query,
  commerce = null,
  insights = null,
  now = new Date(),
}: {
  /** Today's people, filtered to the segment and sorted by last contact. */
  readonly people: readonly PersonToday[];
  /** "Showing N of M": everyone the list holds. */
  readonly shownOf: number;
  /** The read returned nobody (as opposed to a segment that holds nobody). */
  readonly rowsEmpty: boolean;
  readonly searchedField: 'name' | 'phone' | 'email' | null;
  /** The store's order numbers were searched too. */
  readonly orderSearched?: boolean;
  readonly query: string;
  /** What each is worth (04's right column); `null` when the read failed. */
  readonly commerce?: CommerceFacts | null;
  /** Each one's open conversation, said; `null` when unread. */
  readonly insights?: ReadonlyMap<string, Insight | null> | null;
  readonly now?: Date;
}) {
  const t = await getTranslations('customers');
  const locale = await getLocale();

  if (rowsEmpty) {
    return (
      <div className={styles.empty} data-testid="customers-empty">
        {query ? (
          <>
            <p className={styles.emptyLead}>{t('search.noneLead', { query })}</p>
            <p className={styles.emptyBody} data-testid="search-fields">
              {orderSearched
                ? t('search.lookedAt.order')
                : t(`search.lookedAt.${searchedField ?? 'name'}` as 'search.lookedAt.name')}
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
      04's list card: rows at 66, `13px 18px`, gap 14. Each leads with what
      is true today — their last word, waiting on you or not — then, on the
      right, what they are worth and when they last wrote. The handle moved
      to the row's title: it is how to reach them, not what is true.
    */
    <section className={`${fill.fillCard} ${styles.listCard}`} data-testid="customer-list">
      <ul className={`${fill.fillScroll} ${styles.rows}`}>
        {people.map(
          ({ key, primary: row, members, channels, lastContactAt, situation, waiting, faded }) => {
            const label = customerLabel(row);
            const mark = channelMark(channels[0] ?? row.channel ?? null);
            const handle = row.phone ?? row.email ?? row.externalId;
            const since = lastContactAt ? sinceWords(lastContactAt, now) : null;
            const person = { primary: row, members, waiting };
            const insight = insightOf(person, insights);
            const chip = chipOf(person, insight);
            const said = situationLine(insight);
            const value = valueCell(person, commerce);
            return (
              <li
                key={key}
                className={styles.row}
                data-testid={`customer-${row.id}`}
                data-faded={faded ? 'yes' : undefined}
                // For the selection: the person, and every identity a message can reach.
                data-person={key}
                data-contacts={members.map((m) => m.id).join(',')}
              >
                <Link
                  className={styles.rowLink}
                  href={`/customers/${row.id}`}
                  title={handle ? t('today.phone', { handle }) : undefined}
                >
                  <span className={styles.avatarStack} aria-hidden="true">
                    <span className={styles.avatar}>{initialsOf(label)}</span>
                    <span className={styles.channelBadge} data-tone={mark.tone}>
                      <mark.Icon size={9} strokeWidth={2.4} />
                    </span>
                  </span>
                  <span className={styles.rowBody}>
                    <span className={styles.rowTop}>
                      <span className={styles.rowName}>{label ?? t('list.unnamed')}</span>
                      {/*
                        02's state chip: a mood when the AI read one in their
                        open conversation (01bb7b6e), else waiting on you,
                        else a tag the merchant set ("Wholesale").
                      */}
                      {chip?.kind === 'frustrated' || chip?.kind === 'about_to_buy' ? (
                        <span
                          className={styles.rowChip}
                          data-tone={chip.kind}
                          data-testid={`mood-${row.id}`}
                        >
                          {t(`today.mood.${chip.kind}`)}
                        </span>
                      ) : chip?.kind === 'waiting' ? (
                        <span
                          className={styles.rowChip}
                          data-tone="waiting"
                          data-testid={`waiting-${row.id}`}
                        >
                          {t('today.waiting')}
                        </span>
                      ) : chip?.kind === 'tag' ? (
                        <span className={styles.rowChip} dir="auto">
                          {chip.tag}
                        </span>
                      ) : null}
                    </span>
                    <span className={styles.rowLine} data-testid={`situation-${row.id}`}>
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
                      {/*
                        Only the situation sits in its own direction: the
                        whole line in a bdi turned RTL on a Hebrew first
                        word and put "wrote 2 times" first (measured on dev).
                      */}
                      {said ? (
                        <>
                          <bdi dir="auto">{said.situation}</bdi>
                          {said.wrote === null
                            ? null
                            : ` · ${t('today.wrote', { count: said.wrote })}`}
                        </>
                      ) : situation ? (
                        <bdi>{situation}</bdi>
                      ) : (
                        <span title={t('today.noWord')} aria-label={t('today.noWord')}>
                          —
                        </span>
                      )}
                    </span>
                  </span>
                  {/* 02: the amount over how many orders — or "—" with why. */}
                  <span
                    className={styles.rowValue}
                    title={
                      value.kind === 'unknown'
                        ? t(`today.valueWhy.${value.why}`)
                        : value.kind === 'mixed'
                          ? t('today.valueWhy.mixed')
                          : undefined
                    }
                    data-testid={`value-${row.id}`}
                  >
                    <span className={styles.rowAmount}>
                      {value.kind === 'amount' ? money(value.amount, value.currency, locale) : '—'}
                    </span>
                    {value.kind === 'amount' || value.kind === 'mixed' ? (
                      <span className={styles.rowOrders}>
                        {t('today.orders', { count: value.orders })}
                      </span>
                    ) : value.kind === 'none' ? (
                      <span className={styles.rowOrders}>{t('today.noOrders')}</span>
                    ) : null}
                  </span>
                  <span className={styles.rowWhen} data-testid={`since-${row.id}`}>
                    {since ? t(`since.${since.key}` as 'since.days', { n: since.n ?? 0 }) : '—'}
                  </span>
                </Link>
              </li>
            );
          },
        )}
      </ul>

      {/* With a pick, the selection bar takes this place (CustomerSelection). */}
      <div className={styles.listFooter} data-select-slot="">
        {/* 02's foot; why one person can show twice rides on its title. */}
        <span className={styles.footText} data-testid="customer-count" title={t('identityLimit')}>
          {t('footerToday', { shown: people.length, total: shownOf })}
        </span>
      </div>
    </section>
  );
}

/** 02's three chips — everyone, talking now, gone quiet — each a live count, or none when unread. */
export async function Segments({
  segment,
  everyone,
  talking,
  quiet,
}: {
  readonly segment: Segment;
  readonly everyone: number;
  /** `null` when the conversations were not read: no count, never zero. */
  readonly talking: number | null;
  readonly quiet: { readonly count: number; readonly capped: boolean } | null;
}) {
  const t = await getTranslations('customers.segments');
  const chips: { key: Segment; label: string }[] = [
    { key: 'everyone', label: t('everyone') },
    {
      key: 'talking',
      label: talking === null ? t('talking') : t('count', { label: t('talking'), count: talking }),
    },
    {
      key: 'quiet',
      label:
        quiet === null
          ? t('quiet')
          : t(quiet.capped ? 'countCapped' : 'count', { label: t('quiet'), count: quiet.count }),
    },
  ];
  return (
    <div className={styles.segmentBar}>
      <nav className={styles.segments} aria-label={t('label')} data-testid="segments">
        {chips.map((chip) => (
          <Link
            key={chip.key}
            href={
              chip.key === 'everyone'
                ? '/customers'
                : { pathname: '/customers', query: { segment: chip.key } }
            }
            className={styles.segmentChip}
            aria-current={segment === chip.key ? 'page' : undefined}
            data-testid={`segment-${chip.key}`}
          >
            {chip.label}
          </Link>
        ))}
      </nav>
      <span className={styles.sorted}>{t('sorted')}</span>
      <span className="srOnly">{everyone}</span>
    </div>
  );
}

/** 02's dark card: who went quiet, and the way to them. */
export async function ReachOut({
  quiet,
}: {
  readonly quiet: { readonly count: number; readonly capped: boolean } | null;
}) {
  const t = await getTranslations('customers.reach');
  return (
    <section className={styles.reachCard} data-testid="reach-out">
      <p className={styles.reachEyebrow}>{t('eyebrow')}</p>
      <p className={styles.reachBody}>
        {quiet === null
          ? t('unread')
          : quiet.count === 0
            ? t('none')
            : quiet.capped
              ? t('bodyCapped', { count: quiet.count })
              : t('body', { count: quiet.count })}
      </p>
      {quiet !== null && quiet.count > 0 ? (
        <div className={styles.reachActions}>
          <Link
            href={{ pathname: '/outreach', query: { create: 'campaign' } }}
            className={styles.reachPrimary}
            data-testid="reach-write"
          >
            {t('write')}
          </Link>
          <Link
            href={{ pathname: '/customers', query: { segment: 'quiet' } }}
            className={styles.reachSecondary}
            data-testid="reach-list"
          >
            {t('seeList')}
          </Link>
        </div>
      ) : null}
    </section>
  );
}

const WHO = [
  { key: 'bought', count: 'bought_once' },
  { key: 'came', count: 'came_back' },
  { key: 'wholesale', count: 'wholesale' },
  { key: 'never', count: 'never_bought' },
] as const;

/**
 * 02's "Who your customers are" (backend 63985641): four counts, each bar a
 * share of everyone. No store, or a failed read: "—" with why, never zeros.
 */
export async function WhoTheyAre({
  segments = null,
}: {
  readonly segments?: CommerceSegments | null;
} = {}) {
  const t = await getTranslations('customers.who');
  const locale = await getLocale();
  const n = new Intl.NumberFormat(locale);
  const counts = segments?.source ? segments.counts : null;
  const why =
    segments === null
      ? t('reason.unread')
      : counts === null
        ? t(`reason.${reasonKey(segments.reason)}`)
        : segments.truncated
          ? t('capped')
          : undefined;
  return (
    <section className={styles.sideCard} data-testid="who-they-are" title={why}>
      <h2 className={styles.sideTitle}>{t('title')}</h2>
      <ul className={styles.whoRows}>
        {WHO.map(({ key, count }) => {
          const value = counts?.[count] ?? null;
          const share =
            value === null || !segments?.total ? 0 : Math.min(100, (value / segments.total) * 100);
          return (
            <li key={key} className={styles.whoRow} data-testid={`who-${key}`}>
              <span className={styles.whoTop}>
                <span>{t(key)}</span>
                <span className={styles.whoCount}>{value === null ? '—' : n.format(value)}</span>
              </span>
              <span className={styles.whoTrack} aria-hidden="true">
                {value === null ? null : (
                  <span
                    className={styles.whoFill}
                    data-tone={key}
                    style={{ inlineSize: `${share}%` }}
                  />
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

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
