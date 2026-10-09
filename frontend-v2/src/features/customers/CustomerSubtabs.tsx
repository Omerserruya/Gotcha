import { getFormatter, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';

import type { TimelineEvent } from '@/api/contracts/customer-detail';
import { channelName } from '@/api/contracts/inbox';
import { channelMark } from '@/features/inbox/channel-marks';
import { Link } from '@/i18n/navigation';

import { CUSTOMER_TABS, customerFacts, initialsOf, shortDate } from './CustomerScreen';
import type { CustomerDetail } from './load-customer';
import styles from './Customers.module.css';
import { UserText } from '@/design-system/primitives/text/UserText';

/**
 * 04c-04f's shared shell: a COMPACT header - 04b's large one is the
 * Everything tab's alone - then the tab row with that tab's filter chips on
 * the right, then a main column and a 340px side.
 *
 * Measured on 04c: the header at `padding:22px 44px 18px`, a breadcrumb, a
 * 38px disc, the name at 17/600 over an 11.5px line; the tab row at
 * `padding:16px 44px 0`, `gap:20px`; chips 26px at radius 7, "All" dark.
 */
export async function CustomerTopBar({
  detail,
  contactId,
}: {
  readonly detail: CustomerDetail;
  readonly contactId: string;
}) {
  const t = await getTranslations('customers');
  const contact = detail.timeline?.contact ?? null;
  const name = contact?.displayName ?? contact?.externalId ?? null;
  // 04b's facts, the same words: a lone "-" under a name reads as broken.
  const facts = await customerFacts(detail);

  return (
    <header className={styles.topBar} data-testid="customer-top-bar">
      <Link href="/customers" className={styles.crumb}>
        {t('card.crumb')}
      </Link>
      <span className={styles.crumbSlash} aria-hidden="true">
        /
      </span>
      <span className={styles.topWho}>
        <span className={styles.topDisc} aria-hidden="true">
          {initialsOf(name)}
        </span>
        <span>
          {/* The page's one h1: the person, as 04b's large header has it. */}
          <h1 className={styles.topName}>
            {name ? <UserText>{name}</UserText> : t('list.unnamed')}
          </h1>
          {facts.length > 0 ? (
            <span className={styles.topFacts} data-testid="customer-top-facts">
              {facts.join(' · ')}
            </span>
          ) : null}
        </span>
      </span>
      <span className={styles.cardActions}>
        <Link
          href={{ pathname: `/customers/${contactId}`, query: { tab: 'notes' } }}
          className={styles.cardButton}
          data-testid="customer-add-note"
        >
          {t('card.addNote')}
        </Link>
        {detail.conversationId ? (
          <Link
            href={{ pathname: '/inbox', query: { c: detail.conversationId } }}
            className={styles.cardButtonPrimary}
            data-testid="customer-message"
          >
            {t('card.message')}
          </Link>
        ) : (
          <span
            className={styles.cardButtonPrimary}
            aria-disabled="true"
            data-testid="customer-message"
          >
            {t('card.message')}
          </span>
        )}
      </span>
    </header>
  );
}

/** The tab row, with the open tab's own filters on the right. */
export async function CustomerTabRow({
  contactId,
  tab,
  filters,
}: {
  readonly contactId: string;
  readonly tab: string;
  readonly filters?: ReactNode;
}) {
  const t = await getTranslations('customers');
  return (
    <nav className={styles.tabRow} aria-label={t('card.tabs.everything')}>
      {CUSTOMER_TABS.map((key) => (
        <Link
          key={key}
          href={{
            pathname: `/customers/${contactId}`,
            query: key === 'everything' ? {} : { tab: key },
          }}
          className={styles.cardTab}
          aria-current={key === tab ? 'page' : undefined}
          data-testid={`tab-${key}`}
        >
          {t(`card.tabs.${key}`)}
        </Link>
      ))}
      {filters ? <span className={styles.tabFilters}>{filters}</span> : null}
    </nav>
  );
}

/** 04c's filters: "All channels" and one tinted square per channel they use. */
export async function ChannelFilters({
  contactId,
  channels,
  current,
}: {
  readonly contactId: string;
  readonly channels: readonly string[];
  readonly current: string | null;
}) {
  const t = await getTranslations('customers');
  const names = await getTranslations('channels');
  return (
    <>
      <Link
        href={{ pathname: `/customers/${contactId}`, query: { tab: 'conversations' } }}
        className={styles.filterPill}
        aria-current={current === null ? 'true' : undefined}
        data-testid="filter-all"
      >
        {t('card.allChannels')}
      </Link>
      {channels.map((channel) => {
        const mark = channelMark(channel);
        return (
          <Link
            key={channel}
            href={{ pathname: `/customers/${contactId}`, query: { tab: 'conversations', channel } }}
            className={styles.filterSquare}
            data-tone={mark.tone}
            aria-current={current === channel ? 'true' : undefined}
            aria-label={channelName(channel, names) ?? channel}
            title={channelName(channel, names) ?? channel}
            data-testid={`filter-${channel}`}
          >
            <mark.Icon size={13} strokeWidth={2} />
          </Link>
        );
      })}
    </>
  );
}

/** The channels a customer's conversations came through, in first-seen order. */
export function channelsOf(detail: CustomerDetail): readonly string[] {
  return [
    ...new Set(
      (detail.timeline?.events ?? []).map((e) => e.channel).filter((c): c is string => !!c),
    ),
  ];
}

/**
 * 04c - every conversation as a card on one spine.
 *
 * Measured: a 72px date column (the day, and the time under it), a 24px spine
 * (the channel's 22px square, a 1px `#EDE9E1` line down to the next), and the
 * card - white, radius 12, `padding:13px 16px`, `1px #E6E2DA`; the newest
 * marked with 02's 3px `#C96A4B` edge. In the card: the customer's own words
 * as the title, what was said after as the line, chips of what it held, and
 * "Open it".
 *
 * Not drawn from data we lack: 02's status chip ("Open · frustrated"), who
 * handled it ("Support AI, then you"), media counts ("1 photo") - the
 * timeline carries none of them. The channel stands in the meta slot, and a
 * conversation imported from history says "Imported", which is true.
 */
export async function ConversationsTab({
  detail,
  contactId,
  channel,
  more,
}: {
  readonly detail: CustomerDetail;
  readonly contactId: string;
  readonly channel: string | null;
  /** How many times the page has asked for older ones - see `MAX_MORE`. */
  readonly more: number;
}) {
  const t = await getTranslations('customers');
  const names = await getTranslations('channels');
  const format = await getFormatter();
  const now = new Date();

  const groups = new Map<string, TimelineEvent[]>();
  for (const event of detail.timeline?.events ?? []) {
    if (event.type !== 'message') continue;
    if (channel !== null && event.channel !== channel) continue;
    groups.set(event.conversationId, [...(groups.get(event.conversationId) ?? []), event]);
  }
  const cards = [...groups.entries()]
    .map(([id, messages]) => {
      const sorted = [...messages].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const inbound = sorted.filter((m) => m.direction === 'INBOUND' && m.body?.trim());
      return {
        id,
        at: sorted[0]!.createdAt,
        channel: sorted[0]!.channel,
        title: inbound.at(-1)?.body?.trim() ?? null,
        line: inbound[0] && inbound[0] !== inbound.at(-1) ? inbound[0].body!.trim() : null,
        count: messages.length,
        imported: messages.some((m) => m.origin === 'HISTORICAL_IMPORT'),
      };
    })
    .sort((a, b) => b.at.localeCompare(a.at));

  const day = (iso: string) => shortDate(iso, now, format, t('card.today'));

  /*
   * ★★ THE TOTAL IS THE PERSON'S, NOT THE PAGE'S. The cards are what one
   * page of events holds - 20 of 70 on the measured customer - and the side
   * says 70. The heading says 70 too, and the foot says how many are not
   * drawn yet, as 02 does ("19 older conversations below").
   *
   * With a channel filter the per-channel total is unknown, so the heading
   * counts what is drawn and the foot offers more without a number.
   */
  const total =
    channel === null
      ? Math.max(detail.timeline?.totals.conversations ?? 0, cards.length)
      : cards.length;
  const older = channel === null ? total - cards.length : null;
  const mayLoadMore = (detail.timeline?.page.hasMore ?? false) && more < MAX_MORE;
  const time = (iso: string) =>
    format.dateTime(new Date(iso), { hour: '2-digit', minute: '2-digit', hour12: false });

  return (
    <>
      <p className={styles.tabLead}>
        <span>{t('card.conv.heading', { count: total })}</span>
        {/*
          02's "Summarise all of it". The brief IS the summary, generated on
          its own schedule; there is no "summarise now" route, so the link is
          drawn and not live.
        */}
        <span className={styles.tabLeadLink} aria-disabled="true">
          {t('card.conv.summarise')}
        </span>
      </p>
      {cards.length === 0 ? (
        <p className={styles.timelineEmpty} data-testid="conversations-empty">
          {t('card.empty')}
        </p>
      ) : (
        <ol className={styles.spine} data-testid="conversation-cards">
          {cards.map((card, index) => {
            const mark = channelMark(card.channel);
            return (
              <li key={card.id} className={styles.spineRow} data-testid={`conversation-${card.id}`}>
                <span className={styles.spineWhen}>
                  <span>{day(card.at)}</span>
                  {/* 02 gives the time on today's row only. */}
                  {new Date(card.at).toDateString() === now.toDateString() ? (
                    <span className={styles.spineTime}>{time(card.at)}</span>
                  ) : null}
                </span>
                <span className={styles.spineRail} aria-hidden="true">
                  <span className={styles.spineMark} data-tone={mark.tone}>
                    <mark.Icon size={11} strokeWidth={2.2} />
                  </span>
                  <span className={styles.spineLine} />
                </span>
                <article className={styles.spineCard} data-newest={index === 0 ? '' : undefined}>
                  <span className={styles.spineTop}>
                    <span className={styles.spineTitle}>
                      {card.title ?? t('card.conv.noWords')}
                    </span>
                    {card.imported ? (
                      <span className={styles.spineChip}>{t('card.conv.imported')}</span>
                    ) : null}
                    <span className={styles.spineMeta}>{channelName(card.channel, names)}</span>
                  </span>
                  {card.line ? <span className={styles.spineLineText}>{card.line}</span> : null}
                  <span className={styles.spineFoot}>
                    <span className={styles.spinePill}>
                      {t('card.messages', { count: card.count })}
                    </span>
                    <Link
                      href={{ pathname: '/inbox', query: { c: card.id } }}
                      className={styles.spineOpen}
                      data-testid={`open-${card.id}`}
                    >
                      {t('card.conv.openIt')}
                    </Link>
                  </span>
                </article>
              </li>
            );
          })}
        </ol>
      )}
      {(older !== null && older > 0) || (older === null && mayLoadMore) ? (
        mayLoadMore ? (
          <Link
            href={{
              pathname: `/customers/${contactId}`,
              query: {
                tab: 'conversations',
                more: String(more + 1),
                ...(channel ? { channel } : {}),
              },
            }}
            className={styles.spineOlder}
            scroll={false}
            data-testid="conversations-older"
          >
            {older === null ? t('card.conv.showOlder') : t('card.conv.older', { count: older })}
          </Link>
        ) : (
          <p className={styles.spineOlder} data-testid="conversations-older">
            {t('card.conv.older', { count: older ?? 0 })}
          </p>
        )
      ) : null}
    </>
  );
}

/**
 * How far "older conversations" can reach: the route caps a page at 200
 * events, and each step asks for 50 more - so three steps past the first.
 */
export const MAX_MORE = 3;

/** The timeline limit for `?more=`: 50 a step, never past the route's 200. */
export function timelineLimit(more: number): number {
  return Math.min(200, 50 * (1 + more));
}

/** `?more=` as a step count - anything else is the first page. */
export function parseMore(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? Math.min(n, MAX_MORE) : 0;
}

/** 04c's side: their pattern, how they write, what they ask - and the promise card. */
export async function ConversationsSide({ detail }: { readonly detail: CustomerDetail }) {
  const t = await getTranslations('customers');
  const format = await getFormatter();
  const totals = detail.timeline?.totals ?? null;
  const channels = new Set((detail.timeline?.identityChannels ?? []).map((c) => c.channel)).size;
  const writes = detail.brief?.signals ?? [];
  const figure = (n: number | null | undefined) =>
    n === null || n === undefined ? '-' : format.number(n);

  return (
    <>
      <section className={styles.sideBlock} data-testid="customer-pattern">
        <h2 className={styles.sideEyebrow}>{t('card.pattern.heading')}</h2>
        <dl className={`${styles.worth} ${styles.pattern}`}>
          <div>
            <dt>{t('card.pattern.conversations')}</dt>
            <dd className={styles.worthValue}>{figure(totals?.conversations)}</dd>
          </div>
          <div>
            <dt>{t('card.pattern.channels')}</dt>
            <dd className={styles.worthValue}>{figure(channels || null)}</dd>
          </div>
          <div>
            <dt>{t('card.pattern.neededPerson')}</dt>
            <dd className={styles.worthValue}>{figure(totals?.handovers)}</dd>
          </div>
        </dl>
      </section>
      <section className={styles.sideBlock} data-testid="customer-writes">
        <h2 className={styles.sideEyebrow}>{t('card.pattern.writes')}</h2>
        {writes.length > 0 ? (
          <ul className={styles.remembers}>
            {writes.slice(0, 4).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : (
          <p className={styles.sideNone}>{t('card.pattern.writesNone')}</p>
        )}
      </section>
      {/* No per-customer topic counts exist; the block keeps its place. */}
      <section className={styles.sideBlock} data-testid="customer-asks">
        <h2 className={styles.sideEyebrow}>{t('card.pattern.asks')}</h2>
        <p className={styles.sideNone}>{t('card.pattern.asksNone')}</p>
      </section>
      <PromiseCard heading={t('card.promise.heading')} none={t('card.promise.none')} />
    </>
  );
}

/**
 * 02's "An open promise" card, at the foot of every sub-tab's side.
 *
 * Nothing records a promise as a promise - the notes carry them as text - so
 * the card keeps its place and says there is none to show, in neutral rather
 * than 02's warning pink: a pink card with nothing in it would alarm.
 */
export function PromiseCard({
  heading,
  none,
}: {
  readonly heading: string;
  readonly none: string;
}) {
  // Synchronous, with its words handed in: it sits inside other server
  // components, and a nested async one is what a test cannot render.
  return (
    <section className={styles.promiseCard} data-testid="promise-card">
      <p className={styles.pinnedTitle}>{heading}</p>
      <p className={styles.pinnedBody}>{none}</p>
    </section>
  );
}
