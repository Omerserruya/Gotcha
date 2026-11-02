import { MessageCircle, Package, Phone, Sparkles } from 'lucide-react';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';

import { channelHandles } from '@/api/contracts/customer-detail';
import { labelOfPerson } from '@/api/contracts/customers';
import { ChannelMark } from '@/design-system/brand/channel-marks';
import { UserText } from '@/design-system/primitives/text/UserText';
import {
  customerFacts,
  initialsOf,
  shortDate,
  timelineRows,
} from '@/features/customers/CustomerScreen';
import type { CommerceFacts } from '@/features/customers/load-customer-facts';
import type { CustomerDetail } from '@/features/customers/load-customer';
import type { PersonToday, Segment } from '@/features/customers/people-today';
import { PersonName } from '@/features/customers/PersonName';
import { displayHandle } from '@/features/customers/phone';
import { money, valueCell } from '@/features/customers/row-facts';
import { Link } from '@/i18n/navigation';
import { appPath } from '@/lib/base-path';

import ui from '../mobile-ui.module.css';
import styles from './mobile-customers.module.css';
import { phoneOf, worthOf } from './mobile-customers';

/** A phone shows the newest of the history; the rest is the website's. */
const HISTORY_SHOWN = 15;
/** The memory card's lines, as the website's side shows them. */
const MEMORY_SHOWN = 4;

/**
 * The chips over the list: everyone, and who went quiet - the one segment
 * the platform keeps (`dormant-customers`), the design's "at risk".
 *
 * ★ NO VIP, RETURNING OR NEW. Each needs a source that does not exist on
 *   this list - a VIP flag, per-person order history for everyone, a "new"
 *   rule - and a chip that filters on nothing is a control that lies.
 */
export async function MobileCustomerChips({
  segment,
  query,
  quiet,
}: {
  readonly segment: Segment;
  readonly query: string;
  /** `null` when the quiet read failed: the chip, without a count. */
  readonly quiet: { readonly count: number; readonly capped: boolean } | null;
}) {
  const t = await getTranslations('mobile');
  const format = await getFormatter();
  const q = query ? { q: query } : {};
  return (
    <nav
      className={ui.chips}
      aria-label={t('customers.chipsLabel')}
      data-testid="mobile-customer-chips"
    >
      <Link
        href={{ pathname: '/m/customers', query: q }}
        className={ui.chip}
        aria-current={segment === 'everyone' ? 'page' : undefined}
        replace
        data-testid="mobile-customer-chip-everyone"
      >
        {t('customers.chips.everyone')}
      </Link>
      <Link
        href={{ pathname: '/m/customers', query: { ...q, segment: 'quiet' } }}
        className={ui.chip}
        aria-current={segment === 'quiet' ? 'page' : undefined}
        replace
        data-testid="mobile-customer-chip-quiet"
      >
        <span>{t('customers.chips.quiet')}</span>
        {/* Unknown or none: the chip bare, as the design leaves an empty one. */}
        {quiet === null || quiet.count === 0 ? null : (
          <span className={ui.chipCount}>
            {format.number(quiet.count)}
            {quiet.capped ? '+' : ''}
          </span>
        )}
      </Link>
    </nav>
  );
}

/**
 * The customers as the phone lists them: a face, a name and its tag, what
 * they are worth over how many orders, and the channels they write from.
 *
 * ★ PEOPLE, NOT ROWS: `peopleToday` collapses identities by `personId`, as
 *   the website does, so one human on two channels is one row here too.
 * ★ THE SECOND LINE IS THE STORE'S when it answered for them (`valueCell`,
 *   the website's money column); otherwise what they last said. No city:
 *   a contact carries none.
 */
export async function MobileCustomerList({
  people,
  commerce,
}: {
  readonly people: readonly PersonToday[];
  /** The bulk commerce read for these people; `null` when it failed. */
  readonly commerce: CommerceFacts | null;
}) {
  const t = await getTranslations('customers');
  const m = await getTranslations('mobile');
  const tin = await getTranslations('inbox');
  const locale = await getLocale();

  return (
    <ul className={styles.list} data-testid="mobile-customers-list">
      {people.map((person) => {
        const {
          key,
          primary: row,
          members,
          channels,
          situation,
          situationKind,
          waiting,
          faded,
        } = person;
        const named = labelOfPerson(members);
        const label = named && 'name' in named ? named.name : null;
        const generic = named && 'generic' in named ? named.generic : null;
        const value = valueCell(person, commerce);
        const tag = row.tags[0] ?? null;
        const worth =
          value.kind === 'amount'
            ? [
                t('today.orders', { count: value.orders }),
                money(value.amount, value.currency, locale),
              ].join(' · ')
            : value.kind === 'mixed'
              ? t('today.orders', { count: value.orders })
              : null;
        return (
          <li key={key}>
            <Link
              href={`/m/customers/${row.id}` as '/m/customers'}
              className={ui.row}
              data-faded={faded ? '' : undefined}
              data-testid={`mobile-customer-${row.id}`}
            >
              <span className={ui.avatar} aria-hidden="true">
                {initialsOf(label)}
              </span>
              <span className={ui.rowBody}>
                <span className={styles.top}>
                  <span className={styles.who}>
                    {label ? (
                      <PersonName name={label} />
                    ) : generic ? (
                      t(`list.generic.${generic}`)
                    ) : (
                      t('list.unnamed')
                    )}
                  </span>
                  {waiting ? (
                    <span
                      className={ui.tag}
                      data-tone="warn"
                      data-testid={`mobile-waiting-${row.id}`}
                    >
                      {t('today.waiting')}
                    </span>
                  ) : tag ? (
                    <span className={ui.tag} dir="auto">
                      {tag}
                    </span>
                  ) : null}
                </span>
                <span className={ui.rowSub} data-testid={`mobile-customer-sub-${row.id}`}>
                  {worth ??
                    (situation ? (
                      <bdi dir="auto">{situation}</bdi>
                    ) : situationKind ? (
                      tin(`stream.quote.kind.${situationKind}`)
                    ) : (
                      t('today.noWord')
                    ))}
                </span>
              </span>
              {channels.length > 0 ? (
                <span
                  className={styles.marks}
                  role="img"
                  aria-label={m('customers.channelsLabel', { count: channels.length })}
                >
                  {channels.slice(0, 3).map((channel) => (
                    <ChannelMark key={channel} channel={channel} size={16} decorative />
                  ))}
                </span>
              ) : null}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * One customer on the phone, as the design's profile: the face and how to
 * reach them, what they can be done for in a tap, their figures, what
 * GOTCHA remembers, their history across every channel, and the newest note
 * - read only.
 *
 * ★ The desktop's loader (`loadCustomer`) and its own sentences:
 *   `customerFacts` for "with you since · reaches you on", `timelineRows`
 *   for the history, the store's summary for the figures. Each read fails on
 *   its own, and a part with nothing true to say is not drawn.
 *
 * ★ THE TILES DO SOMETHING OR ARE NOT THERE: Message opens their newest
 *   conversation, Call dials a number we hold, Orders opens them on the
 *   website. The design's Note tile is not drawn - a note is written on the
 *   website.
 */
export async function MobileCustomerProfile({
  id,
  detail,
  now,
}: {
  readonly id: string;
  readonly detail: CustomerDetail;
  readonly now: Date;
}) {
  const t = await getTranslations('customers');
  const m = await getTranslations('mobile');
  const format = await getFormatter();
  const locale = await getLocale();
  const contact = detail.timeline?.contact ?? null;
  const name = contact?.displayName ?? contact?.externalId ?? null;
  const facts = await customerFacts(detail);
  const phone = phoneOf(channelHandles(detail.timeline));
  const summary =
    detail.orders?.state === 'ok' ? (detail.orders.data?.summary ?? detail.orders.summary) : null;
  const worth = worthOf(summary ?? null);
  const memory = detail.memory?.context ?? null;
  const remembered = (
    memory && memory.facts.length > 0
      ? memory.facts.map((fact) => fact.text)
      : [memory?.summary?.trim() || detail.brief?.summary?.trim() || null]
  )
    .filter((line): line is string => !!line)
    .slice(0, MEMORY_SHOWN);
  const history = (await timelineRows(detail)).slice(0, HISTORY_SHOWN);
  const note = detail.notes === null ? null : (detail.notes.find((n) => !n.deletedAt) ?? null);

  const figures = worth
    ? [
        worth.spent
          ? {
              key: 'spent',
              value: worth.spent.map((s) => money(s.amount, s.currency, locale)).join(' + '),
              label: m('customers.spent'),
            }
          : null,
        { key: 'orders', value: format.number(worth.orders), label: t('card.orders') },
        worth.refunds === null
          ? null
          : { key: 'refunds', value: format.number(worth.refunds), label: t('card.refunds') },
      ].filter((f): f is { key: string; value: string; label: string } => f !== null)
    : [];

  return (
    <div className={styles.profile} data-testid="mobile-customer-card">
      <header className={styles.head}>
        <span className={styles.disc} aria-hidden="true">
          {initialsOf(name)}
        </span>
        <h1 className={styles.name}>{name ? <PersonName name={name} /> : t('list.unnamed')}</h1>
        {phone ? (
          <span className={styles.phone} dir="ltr" data-testid="mobile-customer-phone">
            {displayHandle(phone.channel, phone.externalId)}
          </span>
        ) : null}
        {facts.length > 0 ? <p className={styles.meta}>{facts.join(' · ')}</p> : null}
      </header>

      <nav className={styles.tiles} aria-label={m('customers.actionsLabel')}>
        {detail.conversationId ? (
          <Link
            href={`/m/inbox/${detail.conversationId}` as '/m/inbox'}
            className={styles.tile}
            data-testid="mobile-customer-message"
          >
            <MessageCircle size={21} strokeWidth={2} aria-hidden="true" />
            {t('card.message')}
          </Link>
        ) : null}
        {phone ? (
          <a href={`tel:${phone.dial}`} className={styles.tile} data-testid="mobile-customer-call">
            <Phone size={21} strokeWidth={2} aria-hidden="true" />
            {m('customers.call')}
          </a>
        ) : null}
        {worth && worth.orders > 0 ? (
          // The website, a full load: the native shell opens it in the browser (`OnWebsite`).
          <a
            href={appPath(`/${locale}/customers/${encodeURIComponent(id)}?tab=orders`)}
            className={styles.tile}
            data-testid="mobile-customer-orders"
          >
            <Package size={21} strokeWidth={2} aria-hidden="true" />
            {t('card.orders')}
          </a>
        ) : null}
      </nav>

      {figures.length > 0 ? (
        <dl
          className={styles.figures}
          data-count={figures.length}
          data-testid="mobile-customer-figures"
        >
          {figures.map((figure) => (
            <div key={figure.key} data-testid={`mobile-customer-figure-${figure.key}`}>
              <dt>{figure.label}</dt>
              <dd className={ui.figure}>{figure.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {remembered.length > 0 ? (
        <section className={styles.memory} data-testid="mobile-customer-memory">
          <h2 className={styles.memoryTitle}>
            <Sparkles size={15} strokeWidth={2} aria-hidden="true" />
            {t('card.remembers')}
          </h2>
          {remembered.map((line, index) => (
            <p key={index} className={styles.memoryLine}>
              <UserText>{line}</UserText>
            </p>
          ))}
        </section>
      ) : null}

      <section className={ui.card} data-testid="mobile-customer-history">
        <h2 className={styles.cardHeading}>{m('customers.history')}</h2>
        {history.length === 0 ? (
          <p className={styles.none}>{t('card.empty')}</p>
        ) : (
          <ol className={styles.history}>
            {history.map((row) => {
              const body = (
                <>
                  <time className={styles.date} dateTime={row.at}>
                    {shortDate(row.at, now, format, t('card.today'))}
                  </time>
                  <span className={styles.dot} data-tone={row.tone} aria-hidden="true" />
                  <span className={styles.event}>
                    <span className={styles.eventTitle}>
                      <UserText>{row.title}</UserText>
                    </span>
                    {row.line ? <span className={styles.eventLine}>{row.line}</span> : null}
                  </span>
                </>
              );
              return (
                <li key={row.key} data-testid={`mobile-event-${row.key}`}>
                  {row.conversationId ? (
                    <Link
                      href={`/m/inbox/${row.conversationId}` as '/m/inbox'}
                      className={styles.historyRow}
                    >
                      {body}
                    </Link>
                  ) : (
                    <span className={styles.historyRow}>{body}</span>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {detail.notes === null ? (
        // A failed read, not an empty one: "nobody wrote anything" would be a claim.
        <p className={styles.none} data-testid="mobile-customer-notes-unread">
          {t('teamNotes.unread')}
        </p>
      ) : note ? (
        <section className={`${ui.card} ${ui.cardPadded}`} data-testid={`mobile-note-${note.id}`}>
          <h2 className={styles.noteHead}>
            {t('card.noteCard', {
              author: note.authorName,
              when: format.dateTime(new Date(note.createdAt), { day: 'numeric', month: 'short' }),
            })}
          </h2>
          <p className={styles.noteText}>
            <UserText>{note.body}</UserText>
          </p>
        </section>
      ) : null}
    </div>
  );
}
