import { getFormatter, getTranslations } from 'next-intl/server';

import { channelHandles, type TimelineEvent } from '@/api/contracts/customer-detail';
import { ordersIn } from '@/api/contracts/customer-orders';
import { channelName } from '@/api/contracts/inbox';
import { humanizeTag } from '@/api/contracts/approvals';
import { Link } from '@/i18n/navigation';

import type { CustomerDetail } from './load-customer';
import styles from './Customers.module.css';
import { displayHandle } from './phone';

/**
 * 04b — a person with a history, not a record.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ EVERY ELEMENT OF 02's CARD IS DRAWN; WHAT HAS NO DATA SAYS "—"
 * ════════════════════════════════════════════════════════════════════════════
 * Omer's bar is 1:1 with the design. So the header, the tabs, the timeline,
 * WORTH, GOTCHA REMEMBERS, REACH and the pinned note are all here, in 02's
 * measured boxes; a part the platform cannot fill keeps its shape and says
 * "—" or "nothing yet", never a paragraph about why.
 *
 *   filled      the summary (brief), the memory facts, the handles, the
 *               orders count, the timeline, the newest note
 *   "—"         lifetime value and refunds (only RECENT orders are read),
 *               location, "with you since" when the history is cut
 */

type Tab = 'everything' | 'conversations' | 'orders' | 'actions' | 'notes';
export const CUSTOMER_TABS: readonly Tab[] = [
  'everything',
  'conversations',
  'orders',
  'actions',
  'notes',
];

export function parseCustomerTab(raw: string | undefined): Tab {
  return (CUSTOMER_TABS as readonly string[]).includes(raw ?? '') ? (raw as Tab) : 'everything';
}

/** Up to two initials, from words that have letters. */
function initialsOf(name: string | null): string {
  if (!name) return '';
  return name
    .split(/\s+/)
    .filter((word) => /\p{L}/u.test(word))
    .slice(0, 2)
    .map((word) => word.match(/\p{L}/u)?.[0]?.toUpperCase() ?? '')
    .join('');
}

/**
 * 02's facts line — "with you since …", "reaches you on …" — for 04b's
 * header and 04c–04f's compact one alike, so the two cannot drift.
 *
 * "With you since" only when the history is whole: the oldest event of a
 * page that has more would be a date that is merely the edge of the page.
 */
export async function customerFacts(detail: CustomerDetail): Promise<readonly string[]> {
  const t = await getTranslations('customers');
  const channels = await getTranslations('channels');
  const format = await getFormatter();
  const reaches = [
    ...new Set(
      (detail.timeline?.identityChannels ?? []).map((c) => channelName(c.channel, channels)),
    ),
  ].filter(Boolean) as string[];
  const events = detail.timeline?.events ?? [];
  const oldest =
    detail.timeline && !detail.timeline.page.hasMore && events.length > 0
      ? events.reduce((min, e) => (e.createdAt < min ? e.createdAt : min), events[0]!.createdAt)
      : null;
  return [
    oldest
      ? t('card.since', {
          when: format.dateTime(new Date(oldest), { month: 'long', year: 'numeric' }),
        })
      : null,
    reaches.length > 0 ? t('card.reaches', { channels: format.list(reaches) }) : null,
  ].filter((fact): fact is string => fact !== null);
}

/**
 * 02's short dates, day first: "Today", "25 Aug" this year, "Mar 24" for an
 * earlier one. Built from parts, because `{ day, month }` in `en` is
 * "Aug 25" — month first, which is not what 02 writes.
 */
export function shortDate(
  iso: string,
  now: Date,
  format: Awaited<ReturnType<typeof getFormatter>>,
  today: string,
): string {
  const at = new Date(iso);
  if (at.toDateString() === now.toDateString()) return today;
  return at.getFullYear() === now.getFullYear()
    ? `${format.dateTime(at, { day: 'numeric' })} ${format.dateTime(at, { month: 'short' })}`
    : format.dateTime(at, { month: 'short', year: '2-digit' });
}

/** 02's header: a 64px disc, the name at 30px, a line of facts, the summary in serif italic. */
export async function CustomerHeader({
  detail,
  contactId,
}: {
  readonly detail: CustomerDetail;
  readonly contactId: string;
}) {
  const t = await getTranslations('customers');
  const contact = detail.timeline?.contact ?? null;
  const name = contact?.displayName ?? contact?.externalId ?? null;
  const facts = await customerFacts(detail);
  const summary = detail.brief?.summary?.trim() || null;

  return (
    <header className={styles.cardHeader} data-testid="customer-header">
      <span className={styles.cardDisc} aria-hidden="true">
        {initialsOf(name)}
      </span>
      <div className={styles.cardWho}>
        <h1 className={styles.cardName}>{name ?? t('list.unnamed')}</h1>
        <p className={styles.cardFacts}>{facts.length > 0 ? facts.join(' · ') : '—'}</p>
        {/* The one place in the product that is serif italic: the character summary. */}
        <p
          className={styles.cardSummary}
          data-testid="customer-summary"
          data-empty={summary ? undefined : ''}
        >
          {summary ?? t('card.noSummary')}
        </p>
      </div>
      <div className={styles.cardActions}>
        <Link
          href={{ pathname: `/customers/${contactId}`, query: { tab: 'notes' } }}
          className={styles.cardButton}
          data-testid="customer-add-note"
        >
          {t('card.addNote')}
        </Link>
        {/*
          Message opens their newest conversation. With none to open the
          button is present and disabled — 02's control, not a dead link.
        */}
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
      </div>
    </header>
  );
}

/** 02's tab row: an underline under the open one; "All channels" on the right. */
export async function CustomerTabs({
  contactId,
  tab,
}: {
  readonly contactId: string;
  readonly tab: Tab;
}) {
  const t = await getTranslations('customers');
  return (
    <nav className={styles.cardTabs} aria-label={t('card.tabs.everything')}>
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
      <span className={styles.cardTabsAside}>{t('card.allChannels')}</span>
    </nav>
  );
}

interface Row {
  readonly key: string;
  readonly at: string;
  readonly tone: 'conversation' | 'action' | 'order' | 'note' | 'handover';
  readonly title: string;
  readonly line: string | null;
}

/**
 * 02's timeline: conversations, orders, actions and notes in ONE stream, a
 * date in mono, a coloured dot, a title and a line. Channel is a mark on the
 * line, never a section — 02's own rule.
 */
export async function CustomerTimelineList({
  detail,
  only,
}: {
  readonly detail: CustomerDetail;
  /** Everything, or the conversations alone (04c's tab, until its own frame). */
  readonly only?: 'conversations';
}) {
  const t = await getTranslations('customers');
  const channels = await getTranslations('channels');
  const format = await getFormatter();
  const now = new Date();
  const events = detail.timeline?.events ?? [];

  const rows: Row[] = [];
  // One row per conversation: its latest moment, what the customer last said.
  const byConversation = new Map<string, TimelineEvent[]>();
  for (const event of events.filter((e) => e.type === 'message')) {
    byConversation.set(event.conversationId, [
      ...(byConversation.get(event.conversationId) ?? []),
      event,
    ]);
  }
  for (const [conversationId, messages] of byConversation) {
    const sorted = [...messages].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const said =
      sorted.find((m) => m.direction === 'INBOUND' && m.body?.trim()) ??
      sorted.find((m) => m.body?.trim());
    rows.push({
      key: `c-${conversationId}`,
      at: sorted[0]!.createdAt,
      tone: 'conversation',
      title: said?.body?.trim().slice(0, 90) ?? t('card.messages', { count: messages.length }),
      line: [
        channelName(sorted[0]!.channel, channels),
        t('card.messages', { count: messages.length }),
      ]
        .filter(Boolean)
        .join(' · '),
    });
  }
  if (only !== 'conversations') {
    for (const event of events) {
      if (event.type === 'ai_action' && event.action) {
        rows.push({
          key: `a-${event.id}`,
          at: event.createdAt,
          tone: 'action',
          title: humanizeTag(event.action.tool.split('.').pop() ?? event.action.tool),
          line: event.action.success ? t('card.aiActionDone') : t('card.aiActionFailed'),
        });
      }
      if (event.type === 'handover' && event.handover) {
        rows.push({
          key: `h-${event.id}`,
          at: event.createdAt,
          tone: 'handover',
          title: event.handover.to
            ? t('card.handedTo', { to: event.handover.to })
            : t('card.handover'),
          line: channelName(event.channel, channels),
        });
      }
    }
    /*
      GOTCHA's actions — the approvals it asked for in their conversations.
      The timeline route returns none of these; see `CustomerDetail.approvals`.
    */
    for (const approval of detail.approvals ?? []) {
      rows.push({
        key: `p-${approval.id}`,
        at: approval.createdAt,
        tone: 'action',
        title: approval.summary,
        line: [
          approval.decidedByName &&
          (approval.status === 'APPROVED' || approval.status === 'REJECTED')
            ? t(`card.approval.${approval.status}By`, { name: approval.decidedByName })
            : t(`card.approval.${approval.status}`),
          channelName(
            events.find((e) => e.conversationId === approval.conversationId)?.channel ?? null,
            channels,
          ),
        ]
          .filter(Boolean)
          .join(' · '),
      });
    }
    for (const order of ordersIn(detail.orders)) {
      if (!order.createdAt) continue;
      const total =
        order.total.amount !== null && order.total.currency
          ? format.number(order.total.amount, { style: 'currency', currency: order.total.currency })
          : null;
      rows.push({
        key: `o-${order.orderId}`,
        at: order.createdAt,
        tone: 'order',
        title: [t('card.order', { number: order.orderNumber }), total].filter(Boolean).join(' · '),
        line:
          [
            order.items
              .map((item) => item.title)
              .filter(Boolean)
              .join(', '),
            order.fulfillment?.label ?? order.financial?.label,
          ]
            .filter(Boolean)
            .join(' · ') || null,
      });
    }
    for (const note of detail.notes ?? []) {
      if (note.deletedAt) continue;
      rows.push({
        key: `n-${note.id}`,
        at: note.createdAt,
        tone: 'note',
        title: t('card.note', { author: note.authorName }),
        line: note.body.slice(0, 110),
      });
    }
  }
  rows.sort((a, b) => b.at.localeCompare(a.at));

  const dateOf = (iso: string) => shortDate(iso, now, format, t('card.today'));

  if (rows.length === 0) {
    return (
      <p className={styles.timelineEmpty} data-testid="timeline-empty">
        {t('card.empty')}
      </p>
    );
  }
  return (
    <ol className={styles.timeline} data-testid="customer-timeline">
      {rows.slice(0, 40).map((row) => (
        <li
          key={row.key}
          className={styles.timelineRow}
          data-tone={row.tone}
          data-testid={`event-${row.key}`}
        >
          <time className={styles.timelineDate} dateTime={row.at}>
            {dateOf(row.at)}
          </time>
          <span className={styles.timelineDot} aria-hidden="true" />
          <span className={styles.timelineText}>
            <span className={styles.timelineTitle}>{row.title}</span>
            {row.line ? <span className={styles.timelineLine}>{row.line}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** 02's side: WORTH, GOTCHA REMEMBERS, REACH, and the pinned note. */
export async function CustomerSide({ detail }: { readonly detail: CustomerDetail }) {
  const t = await getTranslations('customers');
  const channels = await getTranslations('channels');
  const format = await getFormatter();
  const summary =
    detail.orders?.state === 'ok' ? (detail.orders.data?.summary ?? detail.orders.summary) : null;
  const orderCount = summary && summary.orderCount > 0 ? format.number(summary.orderCount) : '—';
  const facts = detail.memory?.context?.facts ?? [];
  const handles = channelHandles(detail.timeline);
  const note = (detail.notes ?? []).find((n) => !n.deletedAt) ?? null;

  return (
    <>
      <section className={styles.sideBlock} data-testid="customer-worth">
        <h2 className={styles.sideEyebrow}>{t('card.worth')}</h2>
        <dl className={styles.worth}>
          {/*
            Lifetime and refunds are "—": the commerce read carries RECENT
            orders, and a sum of those is not a lifetime. The order count is
            the store's own total.
          */}
          {/* The label first in the markup, as a `dl` requires; CSS puts the value on top. */}
          <div>
            <dt>{t('card.lifetime')}</dt>
            <dd className={styles.worthValue}>—</dd>
          </div>
          <div data-testid="worth-orders">
            <dt>{t('card.orders')}</dt>
            <dd className={styles.worthValue}>{orderCount}</dd>
          </div>
          <div>
            <dt>{t('card.refunds')}</dt>
            <dd className={styles.worthValue}>—</dd>
          </div>
        </dl>
      </section>

      <section className={styles.sideBlock} data-testid="customer-remembers">
        <h2 className={styles.sideEyebrow}>{t('card.remembers')}</h2>
        {facts.length > 0 ? (
          <ul className={styles.remembers}>
            {facts.slice(0, 4).map((fact, index) => (
              <li key={index}>{fact.text}</li>
            ))}
          </ul>
        ) : (
          <p className={styles.sideNone}>{t('card.remembersNone')}</p>
        )}
      </section>

      <section className={styles.sideBlock} data-testid="customer-reach">
        <h2 className={styles.sideEyebrow}>{t('card.reach')}</h2>
        {handles.length > 0 ? (
          <dl className={styles.reach}>
            {handles.map((handle) => (
              <div key={`${handle.channel}-${handle.externalId}`}>
                <dt>{channelName(handle.channel, channels) ?? handle.channel}</dt>
                <dd>{displayHandle(handle.channel, handle.externalId)}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className={styles.sideNone}>{t('card.reachNone')}</p>
        )}
      </section>

      {/* 02 pins the newest note at the foot of the column. */}
      <section className={styles.pinnedNote} data-testid="customer-pinned-note">
        {note ? (
          <>
            <p className={styles.pinnedTitle}>
              {t('card.noteCard', {
                author: note.authorName,
                when: format.dateTime(new Date(note.createdAt), { day: 'numeric', month: 'short' }),
              })}
            </p>
            <p className={styles.pinnedBody}>{note.body}</p>
          </>
        ) : (
          <p className={styles.sideNone}>{t('card.noNote')}</p>
        )}
      </section>
    </>
  );
}
