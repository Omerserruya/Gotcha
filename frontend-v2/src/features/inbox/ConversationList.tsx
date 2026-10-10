import { getFormatter, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';

import {
  channelName,
  queueOrder,
  waitingMinutes,
  waitingScale,
  type ConversationRow,
} from '@/api/contracts/inbox';

import { channelMark } from './channel-marks';
import { initials } from './initials';
import { quoteOf } from './media';
import { QueueMenu } from './QueueMenu';
import { QueueRowLink } from './QueueRowLink';
import styles from './Inbox.module.css';
import { UserText } from '@/design-system/primitives/text/UserText';

import { Link } from '@/i18n/navigation';

import {
  inboxQuery,
  QUEUE_CHANNEL_FILTERS,
  type InboxPeriod,
  type InboxView,
  type QueueChannelFilter,
} from './inbox-views';
import { PersonName } from '@/features/customers/PersonName';

/**
 * Screen 02's queue.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ ONE PAGE, AND NO SCROLL, UNTIL THE KEYSET ENDPOINT EXISTS
 * ════════════════════════════════════════════════════════════════════════════
 * The list endpoint paginates by `page + limit`. On a list ordered by
 * recency that is the worst case for offset: a new message reorders rows
 * between page 1 and page 2, so an agent scrolling sees a duplicate and
 * **silently skips a row.**
 *
 * A skipped conversation in an inbox is not cosmetic - it is somebody
 * waiting who never appears, with no symptom the agent could notice. The
 * queue is the one list in this product where completeness IS the feature.
 *
 * Deduplicating by id was the obvious workaround and is worse: it hides the
 * duplicate and **not** the skip, removing the only visible tell of an
 * invisible fault. **Do not suppress the artefact you would have used to
 * detect the problem.**
 *
 * So: the most recent N, captioned as exactly that, and no promise that the
 * rest are reachable.
 *
 * ── AND THE ORDERING IS WORTH LESS THAN IT LOOKS ──
 * `lastMessageAt` is a denormalised cache maintained by convention across
 * ten call sites, with writers that bypass it. The caption does not promise
 * more ordering than that column can carry, and rows that admit they do not
 * know get their own group rather than the floor of the list.
 */
export async function ConversationList({
  rows,
  cap,
  now,
  hasMore,
  undatedCount,
  viewTotal,
  openId,
  meId = null,
  role = null,
  colleagues = [],
  greeting = null,
  view = 'queue',
  channel = null,
  period = null,
  periodInvalid = false,
  clear = null,
}: {
  /** 02b: drawn in place of the empty note when the queue is clear. */
  readonly clear?: ReactNode;
  /** `null` when the read failed. Never an empty queue. */
  readonly rows: readonly ConversationRow[] | null;
  /**
   * The conversation currently open, so its row can say so.
   *
   * ⚠ In the capture, the open conversation's row was VISUALLY IDENTICAL to
   *   the other nine. A queue that cannot show you where you are is a list
   *   you have to re-read after every reply.
   */
  readonly openId?: string | null;
  /**
   * The viewer, so a row can say "You".
   *
   * ★ `loadInbox` already fetches it - it is one of the four calls in round
   *   one - and the conversation header already uses it. The queue was the
   *   one place that had the fact and did not show it.
   */
  readonly meId?: string | null;
  /**
   * The viewer's role, colleagues and greeting - what the right-click menu
   * needs to offer only what the routes will do. See `menuPlan`.
   */
  readonly role?: string | null;
  readonly colleagues?: readonly { readonly id: string; readonly name: string }[];
  readonly greeting?: boolean | null;
  /**
   * Which view this list is, so the header names it.
   *
   * ⚠ The header said "Waiting in queue" on every view - including Resolved,
   *   whose rows are by definition not waiting. A heading that contradicts
   *   the list under it is the same defect as a list that ignores the view.
   */
  readonly view?: InboxView;
  /** The channel filter in force; `null` is "All". */
  readonly channel?: QueueChannelFilter | null;
  /** The period the list is narrowed to (`?from=&to=`); kept by every link here. */
  readonly period?: InboxPeriod | null;
  /** The link asked for a period that is not one: said, never quietly "all". */
  readonly periodInvalid?: boolean;
  /** How many the page holds. Stated on screen, not implied. */
  readonly cap: number;
  readonly now: Date;
  /**
   * Whether the server says more pages exist.
   *
   * ★ IT DECIDES WHAT THE UNDATED GROUP CAN CLAIM. Undated rows sort last,
   * so only on the final page is "these are the undated ones" a statement
   * about the queue rather than about this page.
   */
  readonly hasMore: boolean;
  /**
   * Undated conversations across the whole view, cursor-blind.
   *
   * ★ `undefined` MEANS NOBODY LOOKED. The running service may predate the
   * count, or the read may have failed. Either way the screen must not say
   * zero - that is the instrument reporting all-clear because it is absent.
   */
  readonly undatedCount?: number;
  /** The whole view's size from the route; absent on an older service. */
  readonly viewTotal?: number;
}) {
  const t = await getTranslations('inbox');
  /* The configured zone is `Asia/Jerusalem`; the server's is not. */
  const format = await getFormatter();
  /*
   * The view's name, from the RAIL's own keys - so the header and the
   * highlighted rail item cannot disagree about what this list is.
   */
  const nav = await getTranslations('navigation');
  /*
    A period in the reader's words: days as days (the route's are workspace days - no
    shift), and said as WHEN THEY STARTED - the route filters on createdAt, so a
    September conversation with a message today is in "Started Sep 1 to Sep 30".
  */
  const day = (iso: string) =>
    format.dateTime(new Date(`${iso}T00:00:00Z`), {
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    });
  const periodWords = (p: InboxPeriod) =>
    p.from && p.to
      ? p.from === p.to
        ? t('queue.period.day', { day: day(p.from) })
        : t('queue.period.range', { from: day(p.from), to: day(p.to) })
      : p.from
        ? t('queue.period.from', { from: day(p.from) })
        : t('queue.period.to', { to: day(p.to!) });
  /*
   * The channel labels live in `channels`, where screen 13 already maintains
   * them in both languages. Reading them from there rather than copying ten
   * names into `inbox` keeps one set of words for one set of things.
   */
  const channelNames = await getTranslations('channels');

  if (rows === null) {
    return (
      <div className={styles.queue} data-testid="queue-unavailable">
        <p className={styles.note}>{t('queue.unavailable')}</p>
      </div>
    );
  }

  const { dated, undated } = queueOrder(rows);

  /*
   * ★ A COUNT WITH NO ROWS ON THIS PAGE IS STILL WORTH SAYING.
   *
   * Undated rows sort last, so on any page but the final one the count can
   * be non-zero while this page holds none of them. That is exactly the
   * case the count was added for, and hiding the group because the page is
   * clean would reinstate the defect it fixes.
   */
  const showUndated = undated.length > 0 || (undatedCount !== undefined && undatedCount > 0);

  const row = (conversation: ConversationRow, testid: string) => {
    const waiting = waitingMinutes(conversation, now);
    const mark = channelMark(conversation.channel);
    return (
      <li key={conversation.id} className={styles.queueItem}>
        {/*
          ════════════════════════════════════════════════════════════════════
          ⚠⚠ THE ROWS WERE NOT CLICKABLE. AT ALL.
          ════════════════════════════════════════════════════════════════════
          Measured on the deployed build: a `DIV`, no role, no tabindex, zero
          links or buttons inside, `cursor: auto`, no hover, and nothing on
          right-click. **The only way into a conversation was to type
          `?c=<id>` in the address bar** - on the screen whose entire job is
          choosing which conversation to open.

          ★ A LINK, NOT THE DESIGN'S `<button onClick>`. The prototype uses a
            button because a static mock has no routing; we have a real URL.
            An anchor gives middle-click, open-in-new-tab, the browser's own
            context menu, keyboard focus and a status-bar preview - all of
            which a button reimplements badly or not at all. That is the same
            reading as the code field's caret: when the mock draws something
            the platform provides, it is describing an outcome.

          ⚠ AND THE PARAMETER IS `c`, NOT `conversation`. The only reader is
            `inbox/page.tsx`, which destructures `c`. A walk URL quoted
            `?conversation=` and it was the harness's, not ours.
        */}
        <QueueRowLink
          href={{
            pathname: '/inbox',
            query: inboxQuery({ view, channel, period, c: conversation.id }),
          }}
          className={styles.queueRow}
          data-testid={testid}
          /*
            ★★ MARKED ON CLICK, NOT ON THE SERVER'S ANSWER. `open` is what the
            server rendered; the link follows a pending click until the new
            page lands - see `QueueRowLink`. What the pane shows meanwhile
            comes from this row, which is already loaded.
          */
          open={conversation.id === openId}
          pending={{
            id: conversation.id,
            name: conversation.customerName,
            channelLabel: channelName(conversation.channel, channelNames),
          }}
          /*
            ★★ 02 DRAWS A SETTLED ROW QUIETER IN FIVE SEPARATE WAYS - name
            weight, name colour, preview colour, avatar tint and time colour.
            We drew every row identically, which is why the column read flat.

            ⚠ `CLOSED` is the only one of the three statuses that means
              settled. `OPEN` and `WAITING` are both live and are NOT
              distinguished here: the design's third state is "unread", which
              needs a field the contract does not have.
          */
          data-settled={conversation.status === 'CLOSED' ? '' : undefined}
        >
          {/*
            ════════════════════════════════════════════════════════════════
            ★★ THE DESIGN'S ROW IS THREE LINES BESIDE AN AVATAR
            ════════════════════════════════════════════════════════════════
            02's template, verbatim: a 40×40 initials circle, then
            `flex-direction:column; gap:4px` carrying name+time, preview+
            unread, and a tag row.

            We drew name · channel · waiting-age on one baseline - three
            facts, none of them the message.
          */}
          {/*
            ★★ THE AVATAR IS A STACK, NOT A CIRCLE. 02: a 42×42 disc with an
            18×18 channel badge at `right:-2 bottom:-2`, bordered `2px solid`
            in the CARD's own colour so it punches out of the disc rather
            than sitting on it.
          */}
          <span
            className={styles.avatarStack}
            /*
              ⚠ NOT `aria-hidden` ANY MORE. The initials are decorative, but
                the badge is now the only thing saying which channel this is -
                it was a visible word a moment ago. Hiding the stack would
                remove that fact from anybody using a screen reader.
            */
            title={channelName(conversation.channel, channelNames) ?? t('queue.unknownChannel')}
          >
            <span
              className={styles.avatar}
              data-settled={conversation.status === 'CLOSED' ? '' : undefined}
            >
              {initials(conversation.customerName)}
            </span>
            <span className={styles.channelBadge} data-tone={mark.tone}>
              <mark.Icon size={10} strokeWidth={2.4} />
            </span>
          </span>

          <span className={styles.rowBody}>
            <span className={styles.rowTop}>
              {/*
                ★★ THE CUSTOMER'S NAME, WHICH WAS "Someone" ON EVERY ROW.
                The contract named a field the platform does not send, so the
                real `customerName` was stripped and the invented one
                defaulted to null.
              */}
              <span className={styles.who}>
                {conversation.customerName === null ? (
                  t('queue.unnamed')
                ) : (
                  /* A name is the data's direction, not the layout's. */
                  <PersonName name={conversation.customerName} />
                )}
              </span>

              {/*
                ★ THE TIME OF THE LAST MESSAGE, which is what the design puts
                  here - and waiting-age has moved to the tag row, which is
                  where the design puts THAT. Both facts kept, each in its
                  own slot, rather than one standing in for the other.

                ⚠ Through `next-intl`'s formatter, so it renders in the
                  configured `Asia/Jerusalem` rather than the server's zone.
                  A time formatted on the server in UTC is wrong for every
                  reader and looks right to whoever deployed it.
              */}
              {conversation.lastMessageAt === null ? null : (
                <span className={styles.rowTime} data-testid={`time-${conversation.id}`}>
                  {format.dateTime(new Date(conversation.lastMessageAt), {
                    hour: '2-digit',
                    minute: '2-digit',
                    /*
                     * ⚠⚠ 24-HOUR, STATED RATHER THAN INHERITED. `hour12`
                     *   follows the LOCALE by default, so `en` rendered
                     *   "07:48 PM" and `he` would render "19:48" - the two
                     *   locales disagreeing about a thing 02 states once, on
                     *   every row, as `09:29`.
                     *
                     * ★ Pinning the zone was right and was not enough: the
                     *   zone and the format are two separate defaults, and
                     *   only one of them was wrong at a time.
                     */
                    hour12: false,
                  })}
                </span>
              )}
            </span>

            {/*
              ════════════════════════════════════════════════════════════════
              ⚠⚠ THE MESSAGE PREVIEW - IN THE CONTRACT ALL ALONG, NEVER DRAWN
              ════════════════════════════════════════════════════════════════
              `lastMessageBody` is parsed by `conversationRowSchema` and
              appeared NOWHERE outside it. The row's whole purpose - what the
              person actually said - was being fetched on every page load and
              discarded.

              ★ The fourth value today that existed and had no reader.
            */}
            {/*
              ★ BY TYPE, NEVER THE FILLER. The body of a photo is the
                adapter's "[Image]", of a voice note "[Voice message]", of a
                location "[Shared location: …]". `quoteOf` is what the reply
                quote already reads, so the row and the quote say one word for
                one kind: a caption is shown as the caption, filler as the
                kind, and a body that is only "[Image]" still reads as a photo
                from an older service that sends no `lastMessageType`.

              ⚠ AN EMPTY PREVIEW KEEPS ITS LINE. With no text and no known
                kind there is nothing true to write - but dropping the line
                made those rows 69 tall in a column of 82s. The line stays,
                empty; no text is invented.
            */}
            {(() => {
              const said = quoteOf({
                body: conversation.lastMessageBody ?? '',
                messageType: conversation.lastMessageType,
              });
              return (
                <span
                  className={styles.preview}
                  data-testid={`preview-${conversation.id}`}
                  data-empty={said === null ? '' : undefined}
                  data-kind={said !== null && 'kind' in said ? said.kind : undefined}
                >
                  {said === null ? null : 'text' in said ? (
                    /* Somebody else's words: their direction, not the layout's. */
                    <UserText>{said.text}</UserText>
                  ) : (
                    t(`stream.quote.kind.${said.kind}`)
                  )}
                </span>
              );
            })()}

            <span className={styles.rowTags}>
              {/*
                ★ NULL IS NOT ZERO. A row we cannot age says nothing rather
                  than claiming it has been waiting no time at all, which
                  would sort it alongside the freshest thing in the queue.
              */}
              {waiting === null ? null : (
                <span className={styles.waiting} data-testid={`waiting-${conversation.id}`}>
                  {/*
                    ★★ AT A SCALE SOMEBODY CAN READ. This printed raw minutes,
                    so the capture showed `47061m` - thirty-two days, on the
                    column an agent triages on.
                  */}
                  {(() => {
                    const { scale, value } = waitingScale(waiting);
                    return t(`queue.waitingFor.${scale}` as 'queue.waitingFor.minutes', { value });
                  })()}
                </span>
              )}

              {/*
                ★★ THE CHANNEL'S NAME, NOT ITS ENUM. `SHOPIFY_LIVE_CHAT` was
                on screen; `channels.name.SHOPIFY_LIVE_CHAT` has said "Shopify
                live chat" in both languages all along.

                ⚠ THE DESIGN DRAWS A LOGO BADGE HERE AND WE DRAW THE NAME.
                  Its template is `background: url({{ c.chIcon }})` - a brand
                  image per channel, and this product has no such assets. A
                  lucide glyph would be a different mark, not that one, so the
                  name stays until the logos exist.
              */}
              {/*
                ⚠⚠ THE CHANNEL TAG IS GONE, AND THE BADGE IS WHY. The avatar
                   now carries a tinted channel mark, so printing the name
                   here spent the row's ONE coloured slot on a duplicate -
                   and 02 puts status in that slot, not provenance.

                ★ `channelName` is still read for the badge's accessible
                  name: the mark is a tint and a glyph, and neither says
                  "WhatsApp" to somebody who cannot see it.
              */}
              {/*
                ════════════════════════════════════════════════════════════
                ★★ TWO TAGS ON REAL DATA, NOT SIX WHERE FOUR ARE FICTION
                ════════════════════════════════════════════════════════════
                The design renders nine tag texts across the inbox screens.
                They split three ways:

                  buildable   "You" (assignedAgentId === me), "Flow"
                              (handledBy === 'flow' - an EXACT match for
                              HANDLED_BY's literal word)
                  needs a     "Support AI" / "Sales AI" - the row carries
                  name        `assignedAiAgentId`, an id with no name
                  no field    "Shipping issue", "High intent", "Waiting on
                              returns", "Approval needed" - a classification
                              nobody stores

                ⚠ The last four are NOT approximations of `status`. "Waiting
                  on returns" is not `WAITING`, and a mapping that looks
                  right on three rows is the kind of invention that reads as
                  working.
              */}
              {meId !== null && conversation.assignedAgentId === meId ? (
                <span className={styles.tagMine} data-testid={`tag-you-${conversation.id}`}>
                  {t('queue.tag.you')}
                </span>
              ) : null}

              {conversation.handledBy === 'flow' ? (
                <span className={styles.tagNeutral} data-testid={`tag-flow-${conversation.id}`}>
                  {t('queue.tag.flow')}
                </span>
              ) : null}
            </span>
          </span>
        </QueueRowLink>
      </li>
    );
  };

  return (
    <div className={styles.queue} data-testid="conversation-list">
      {/*
        ════════════════════════════════════════════════════════════════════
        ★★ THE PANEL'S OWN HEADER. 02: `padding:14px 18px`, a bottom hairline,
           "Waiting in queue" and a count.
        ════════════════════════════════════════════════════════════════════
        ★ THE COUNT IS THE VIEW'S TOTAL when the route sends it (`viewTotal`,
          Backend 7b12ac06 - for the queue, Home's own number). A service that
          predates it reports no grand count, and then the count is what this
          page holds: printing a page size as a queue size would be the cap
          defect the footer sentence exists to prevent, moved into a number.

        ★ So the header counts the view when it is told it, else what is
          here, and the footer says what the page holds. Two slots, one honest
          fact each.
      */}
      <header className={styles.queueHeader}>
        {/* 02: the title left, the count pushed hard right. */}
        <div className={styles.queueTitleRow}>
          <span className={styles.queueHeading}>{nav(`inbox.${view}`)}</span>
          {/*
            ⚠⚠ NEVER A PAGE'S COUNT AS A TOTAL (dev: "All conversations · 50"
            for September's 81 - the page's cap, read as the view's size). The
            route's total when it sends one; the page's count when the page is
            all there is; otherwise what is shown, and that more follow.
          */}
          <span
            className={styles.queueCount}
            data-testid="queue-count"
            data-partial={viewTotal === undefined && hasMore ? '' : undefined}
          >
            {viewTotal !== undefined
              ? viewTotal
              : hasMore
                ? t('queue.shownMore', { count: rows?.length ?? 0 })
                : (rows?.length ?? 0)}
          </span>
        </div>

        {/*
          ════════════════════════════════════════════════════════════════════
          ★★ 02's FILTER ROW - AND EVERY CHIP IN IT FILTERS
          ════════════════════════════════════════════════════════════════════
          "All" as a dark pill, then one tinted square per channel. Links, not
          buttons, for the same reason the rows are: the filter is a URL, so
          it survives a reload, a shared link and the back button.

          ⚠ "FILTERS" IS NOT HERE. 02 ends the row with it, and its prose says
            what it opens: "intent, team, agent, owner type, wait time,
            customer attributes". None of that panel exists, and a word that
            promises it would be the screen describing a feature it does not
            have. Its slot stays empty until the panel is built.
        */}
        <nav
          className={styles.queueFilters}
          aria-label={t('queue.filter.label')}
          data-testid="queue-filters"
        >
          <Link
            href={{ pathname: '/inbox', query: inboxQuery({ view, channel: null, period }) }}
            className={styles.filterAll}
            aria-current={channel === null ? 'true' : undefined}
            data-testid="filter-all"
          >
            {t('queue.filter.all')}
          </Link>
          {QUEUE_CHANNEL_FILTERS.map((filter) => {
            const mark = channelMark(filter);
            return (
              <Link
                key={filter}
                href={{ pathname: '/inbox', query: inboxQuery({ view, channel: filter, period }) }}
                className={styles.filterChannel}
                data-tone={mark.tone}
                aria-current={channel === filter ? 'true' : undefined}
                /* The glyph is the only thing on the chip; the name is its label. */
                aria-label={channelName(filter, channelNames) ?? filter}
                title={channelName(filter, channelNames) ?? filter}
                data-testid={`filter-${filter}`}
              >
                <mark.Icon size={14} strokeWidth={2} />
              </Link>
            );
          })}
        </nav>
        {/*
          The period the list is narrowed to (an assistant's source links here,
          "Conversations in September") - said, with the way out of it. The ×
          clears the period only; the view and the channel stay.
        */}
        {period ? (
          <Link
            href={{ pathname: '/inbox', query: inboxQuery({ view, channel, period: null }) }}
            className={styles.periodChip}
            aria-label={t('queue.period.clear', { period: periodWords(period) })}
            data-testid="queue-period"
          >
            <span>{periodWords(period)}</span>
            <span aria-hidden="true">×</span>
          </Link>
        ) : null}
        {periodInvalid ? (
          <p className={styles.periodNote} role="status" data-testid="queue-period-invalid">
            {t('queue.period.invalid')}
          </p>
        ) : null}
      </header>

      {/*
        ⚠⚠ THE SCROLLING REGION, AND IT IS THE WHOLE OF "A WINDOW YOU SCROLL
           INSIDE". The header above and the footer below are `flex: none`;
           this is `flex: 1` with `min-block-size: 0`, so the panel stays the
           frame's height and the LIST moves inside it.

        ★ Without the wrapper the list is a direct child of the panel and
          pushes it taller - which is the bottom edge running off the screen.
      */}
      <div className={styles.queueScroll}>
        {/*
          ★★ 02's RIGHT-CLICK MENU, AND SHIFT-CLICK TO PICK SEVERAL - over the
          rows, inside the scroll region. A client component around the rows:
          the rows stay server-rendered, and the menu learns which one was
          right-clicked from the row's own `data-conversation-id`.
        */}
        <QueueMenu
          rows={rows.map((it) => ({
            id: it.id,
            status: it.status,
            assignedAgentId: it.assignedAgentId,
            assignedAiAgentId: it.assignedAiAgentId,
            isHandedOver: it.isHandedOver,
            handledBy: it.handledBy,
          }))}
          meId={meId}
          role={role}
          colleagues={colleagues}
          greeting={greeting}
        >
          {/*
          ★★ THE CAP IS STATED, NOT IMPLIED. A list that stops at N and says
          nothing teaches an agent that N is all there is.
        */}

          {dated.length === 0 && undated.length === 0 && clear ? (
            clear
          ) : dated.length === 0 && undated.length === 0 ? (
            <p className={styles.note} data-testid="queue-empty">
              {channel === null ? t('queue.empty') : t('queue.filter.emptyFiltered')}
            </p>
          ) : (
            <ol className={styles.queueList}>{dated.map((c) => row(c, `conversation-${c.id}`))}</ol>
          )}

          {/*
          ════════════════════════════════════════════════════════════════════
          ★★ THE ROWS THE ORDERING CANNOT PLACE, SHOWN RATHER THAN SUNK
          ════════════════════════════════════════════════════════════════════
          `lastMessageAt` is maintained by convention and some writers skip it.
          A null sinks to the floor of a recency list and is never seen - the
          same defect as the pagination skip, and the reason this list is
          capped in the first place.

          Its own group says the true thing: open, and we cannot tell where
          they belong. The count makes a growing problem visible instead of
          gradual - if writers that forget are common, that number rising is
          how anybody would ever find out, and it rises in front of the person
          using the screen rather than only in an audit.

          ════════════════════════════════════════════════════════════════════
          ⚠ AND THIS COVERS THE VISIBLE TENTH OF THE PROBLEM
          ════════════════════════════════════════════════════════════════════
          **We can refuse to bury the rows that ADMIT they do not know. We
          cannot find the ones that are quietly wrong.** A stale
          `lastMessageAt` - a plausible timestamp from before the newest
          message, written by a forgetful path - is indistinguishable from a
          correct one at every layer we control. Nothing on the row disagrees
          with it and the list looks entirely normal.

          This is written here rather than only in a message because **a
          partial fix that looks complete is how a known problem stops being
          tracked**, and this one is shaped to look complete: a named group, a
          count, a true sentence, all correct, covering the minority case.

          The majority case is with the write-path audit and is not solvable
          from this file.

          ════════════════════════════════════════════════════════════════════
          ⚠ AND THE GROUP ITSELF IS PER PAGE, BECAUSE NULLS SORT LAST
          ════════════════════════════════════════════════════════════════════
          The server orders `{ lastMessageAt: desc, nulls: last }`, so every
          undated row sits at the **very end of the whole queue**. On a tenant
          with more conversations than one page holds, this group is empty on
          every page but the last - and an empty group reads as "none".

          Found when the keyset endpoint landed and made the paging real. It
          was already true of the capped list and I had not seen it: the group
          I built to make a hidden problem visible was itself hidden by the
          ordering, for exactly the tenants with enough conversations to have
          the problem.

          So the caption says which it is. A whole-queue count needs an
          endpoint nobody offers yet.
        */}
          {showUndated ? (
            <section data-testid="queue-undated">
              {/*
              ★★ THE VIEW-WIDE COUNT SUPERSEDES THE PER-PAGE ONE.

              `undatedCount` is scoped to this view's filters and is
              cursor-blind, so it answers the question the per-page group could
              only gesture at. When it is absent - an older service, or a
              failed read - the caption falls back to what this page can see
              and says that is what it is.
            */}
              <p className={styles.note}>
                {undatedCount !== undefined
                  ? t('queue.undatedInView', { count: undatedCount })
                  : hasMore
                    ? t('queue.undatedThisPage', { count: undated.length })
                    : t('queue.undated', { count: undated.length })}
              </p>
              <ol className={styles.queueList}>{undated.map((c) => row(c, `undated-${c.id}`))}</ol>
            </section>
          ) : null}
        </QueueMenu>
      </div>

      {/*
        ════════════════════════════════════════════════════════════════════
        ★★ THE DESIGN'S FOOTER BAR, CARRYING OUR SENTENCE RATHER THAN ITS OWN
        ════════════════════════════════════════════════════════════════════
        02 ends the queue card with a bar - `#F5F2EC`, radius `0 0 18px 18px`,
        `border-top 1px #EDE9E1` - reading *"Shift-click to pick several ·
        right-click for actions"*.

        ⚠ WE DO NOT SHIP THAT SENTENCE. It is the only thing that tells anyone
          the context menu exists, and it promises multi-select the menu then
          acts on. Neither is built, so printing it would be the screen
          describing a feature it does not have.

        ★ But the BAR is the home the cap caption never had. It used to sit
          above the list, where the design puts the column header; it says
          something true about the list and now it says it from the design's
          own slot. One structural question answered without deleting the
          sentence it was about.
      */}
      {/* 02b: on a clear queue the bar carries what the queue is, not a count of nothing. */}
      <p className={styles.queueFooter} data-testid="queue-cap">
        {clear && rows !== null && rows.length === 0
          ? t('clear.foot')
          : hasMore
            ? t('queue.cap', { count: cap })
            : t('queue.capAll', { count: rows.length })}
      </p>
    </div>
  );
}
