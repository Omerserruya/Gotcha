import { getFormatter, getTranslations } from 'next-intl/server';

import { channelHandles } from '@/api/contracts/customer-detail';
import { labelOfPerson } from '@/api/contracts/customers';
import { channelName } from '@/api/contracts/inbox';
import { ChannelPlate } from '@/design-system/brand/channel-plate';
import { UserText } from '@/design-system/primitives/text/UserText';
import { customerFacts, initialsOf, shortDate } from '@/features/customers/CustomerScreen';
import type { CustomerDetail } from '@/features/customers/load-customer';
import { sinceWords, type PersonToday } from '@/features/customers/people-today';
import { PersonName } from '@/features/customers/PersonName';
import { displayHandle } from '@/features/customers/phone';
import { Link } from '@/i18n/navigation';

import styles from './mobile-customers.module.css';
import { recentConversations } from './mobile-customers';

/** A phone shows the newest conversations; the rest are the website's. */
const CONVERSATIONS_SHOWN = 10;

/**
 * The customers as a phone list: a face, a name, what they last said and
 * when - the desktop row's facts (`CustomerList`) without its money column,
 * which needs a bulk commerce read the phone does not pay for.
 *
 * ★ PEOPLE, NOT ROWS: `peopleToday` collapses identities by `personId`, as
 *   the website does, so one human on two channels is one row here too.
 */
export async function MobileCustomerList({
  people,
  rowsEmpty,
  query,
  searchedField,
  orderSearched,
  now,
}: {
  readonly people: readonly PersonToday[];
  /** The read returned nobody - as opposed to a failed read, which never reaches here. */
  readonly rowsEmpty: boolean;
  readonly query: string;
  readonly searchedField: 'name' | 'phone' | 'email' | null;
  readonly orderSearched: boolean;
  readonly now: Date;
}) {
  const t = await getTranslations('customers');
  const tin = await getTranslations('inbox');

  if (rowsEmpty || people.length === 0) {
    // The desktop's empty state: what was looked at, never a bare "no results".
    return (
      <div className={styles.empty} data-testid="mobile-customers-empty">
        {query ? (
          <>
            <p className={styles.note}>{t('search.noneLead', { query })}</p>
            <p className={styles.noteBody}>
              {orderSearched
                ? t('search.lookedAt.order')
                : t(`search.lookedAt.${searchedField ?? 'name'}` as 'search.lookedAt.name')}
            </p>
          </>
        ) : (
          <p className={styles.note}>{t('list.none')}</p>
        )}
      </div>
    );
  }

  return (
    <ul className={styles.list} data-testid="mobile-customers-list">
      {people.map(
        ({
          key,
          primary: row,
          members,
          channels,
          lastContactAt,
          situation,
          situationKind,
          waiting,
          faded,
        }) => {
          const named = labelOfPerson(members);
          const label = named && 'name' in named ? named.name : null;
          const generic = named && 'generic' in named ? named.generic : null;
          const since = lastContactAt ? sinceWords(lastContactAt, now) : null;
          return (
            <li key={key}>
              <Link
                href={`/m/customers/${row.id}` as '/m/customers'}
                className={styles.row}
                data-faded={faded ? '' : undefined}
                data-testid={`mobile-customer-${row.id}`}
              >
                <span className={styles.avatarStack} aria-hidden="true">
                  <span className={styles.avatar}>{initialsOf(label)}</span>
                  <span className={styles.channelBadge}>
                    <ChannelPlate
                      channel={channels[0] ?? row.channel ?? null}
                      size="xs"
                      decorative
                    />
                  </span>
                </span>
                <span className={styles.body}>
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
                    {since ? (
                      <span className={styles.time}>
                        {t(`since.${since.key}` as 'since.days', { n: since.n ?? 0 })}
                      </span>
                    ) : null}
                  </span>
                  <span className={styles.bottom}>
                    <span className={styles.preview} data-kind={situationKind ?? undefined}>
                      {situation ? (
                        <bdi dir="auto">{situation}</bdi>
                      ) : situationKind ? (
                        tin(`stream.quote.kind.${situationKind}`)
                      ) : (
                        t('today.noWord')
                      )}
                    </span>
                    {waiting ? (
                      <span className={styles.chip} data-testid={`mobile-waiting-${row.id}`}>
                        {t('today.waiting')}
                      </span>
                    ) : null}
                  </span>
                </span>
              </Link>
            </li>
          );
        },
      )}
    </ul>
  );
}

/**
 * One customer on the phone: who they are, how to reach them, their recent
 * conversations and the team's notes - read only.
 *
 * ★ The desktop's loader (`loadCustomer`) and its own sentences:
 *   `customerFacts` for "with you since · reaches you on", the brief as the
 *   summary, `channelHandles` for the handles. Each read fails on its own,
 *   and a failed one is said as failed - never as "nothing here".
 */
export async function MobileCustomerCard({
  detail,
  now,
}: {
  readonly detail: CustomerDetail;
  readonly now: Date;
}) {
  const t = await getTranslations('customers');
  const m = await getTranslations('mobile');
  const channels = await getTranslations('channels');
  const format = await getFormatter();
  const contact = detail.timeline?.contact ?? null;
  const name = contact?.displayName ?? contact?.externalId ?? null;
  const facts = await customerFacts(detail);
  const summary = detail.brief?.summary?.trim() || null;
  const handles = channelHandles(detail.timeline);
  const conversations = recentConversations(detail.timeline?.events ?? [], CONVERSATIONS_SHOWN);
  const total = Math.max(detail.timeline?.totals.conversations ?? 0, conversations.length);
  const notes = detail.notes === null ? null : detail.notes.filter((note) => !note.deletedAt);

  return (
    <div className={styles.card} data-testid="mobile-customer-card">
      <header className={styles.head}>
        <span className={styles.disc} aria-hidden="true">
          {initialsOf(name)}
        </span>
        <h1 className={styles.name}>{name ? <PersonName name={name} /> : t('list.unnamed')}</h1>
        {facts.length > 0 ? <p className={styles.facts}>{facts.join(' · ')}</p> : null}
        <p className={styles.summary} data-empty={summary ? undefined : ''}>
          {summary ? <UserText>{summary}</UserText> : t('card.noSummary')}
        </p>
        {detail.conversationId ? (
          <Link
            href={`/m/inbox/${detail.conversationId}` as '/m/inbox'}
            className={styles.message}
            data-testid="mobile-customer-message"
          >
            {t('card.message')}
          </Link>
        ) : null}
      </header>

      <section className={styles.section} data-testid="mobile-customer-reach">
        <h2 className={styles.heading}>{t('card.reach')}</h2>
        {handles.length > 0 ? (
          <dl className={styles.reach}>
            {handles.map((handle) => (
              <div key={`${handle.channel}-${handle.externalId}`}>
                <dt>{channelName(handle.channel, channels) ?? handle.channel}</dt>
                {/* A phone in a Hebrew page lays out backwards unless it is its own island. */}
                <dd>
                  <bdi dir="ltr">{displayHandle(handle.channel, handle.externalId)}</bdi>
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className={styles.none}>{t('card.reachNone')}</p>
        )}
      </section>

      <section className={styles.section} data-testid="mobile-customer-conversations">
        <h2 className={styles.heading}>
          {conversations.length > 0
            ? t('card.conv.heading', { count: total })
            : m('customers.conversations')}
        </h2>
        {conversations.length === 0 ? (
          <p className={styles.none}>{t('card.empty')}</p>
        ) : (
          <ul className={styles.conversations}>
            {conversations.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/m/inbox/${c.id}` as '/m/inbox'}
                  className={styles.conversation}
                  data-testid={`mobile-customer-conversation-${c.id}`}
                >
                  <ChannelPlate channel={c.channel} size="md" decorative />
                  <span className={styles.conversationBody}>
                    <span className={styles.conversationSaid}>
                      {c.said ? <bdi dir="auto">{c.said}</bdi> : t('card.conv.noWords')}
                    </span>
                    <span className={styles.conversationMeta}>
                      {[
                        shortDate(c.at, now, format, t('card.today')),
                        channelName(c.channel, channels),
                        t('card.messages', { count: c.count }),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.section} data-testid="mobile-customer-notes">
        <h2 className={styles.heading}>{t('teamNotes.title')}</h2>
        {notes === null ? (
          // A failed read, not an empty one: "nobody wrote anything" would be a claim.
          <p className={styles.none} data-testid="mobile-customer-notes-unread">
            {t('teamNotes.unread')}
          </p>
        ) : notes.length === 0 ? (
          <p className={styles.none}>{t('teamNotes.none')}</p>
        ) : (
          <ol className={styles.notes}>
            {notes.map((note) => (
              <li key={note.id} className={styles.noteItem} data-testid={`mobile-note-${note.id}`}>
                <p className={styles.noteHead}>
                  <span className={styles.noteAuthor}>{note.authorName}</span>
                  <time dateTime={note.createdAt}>
                    {shortDate(note.createdAt, now, format, t('card.today'))}
                  </time>
                  <span className={styles.noteChip} data-ai={note.aiUsable ? '' : undefined}>
                    {note.aiUsable ? t('teamNotes.mayUse') : t('teamNotes.teamOnly')}
                  </span>
                </p>
                <p className={styles.noteText}>
                  <UserText>{note.body}</UserText>
                </p>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
