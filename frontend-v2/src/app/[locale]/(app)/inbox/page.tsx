import { getLocale, getTranslations } from 'next-intl/server';
import { Suspense } from 'react';

import { ConversationHeader } from '@/features/inbox/ConversationHeader';
import { Composer } from '@/features/inbox/Composer';
import { ConversationStream, OrdersChip } from '@/features/inbox/ConversationDetail';
import { ListLive } from '@/features/inbox/ListLive';
import { InboxEscape } from '@/features/inbox/InboxEscape';
import { MarkReadOnOpen } from '@/features/inbox/MarkReadOnOpen';
import { NothingOpen } from '@/features/inbox/NothingOpen';
import { ClearQueueList, ClearQueuePane } from '@/features/inbox/ClearQueue';
import { ConversationList } from '@/features/inbox/ConversationList';
import { ConversationVerbs } from '@/features/inbox/ConversationVerbs';
import { ActivityProvider } from '@/features/inbox/wall/Activity';
import { AskCopilot } from '@/features/inbox/wall/AskCopilot';
import { CopilotWall, WallHeader } from '@/features/inbox/wall/CopilotWall';
import styles from '@/features/inbox/Inbox.module.css';
import {
  INBOX_VIEW_IDS,
  parseChannelFilter,
  parseInboxView,
  shownView,
  parsePeriod,
  retiredView,
} from '@/features/inbox/inbox-views';
import { redirect } from '@/i18n/navigation';
import { loadClearQueue } from '@/features/inbox/load-clear-queue';
import { loadSlaClock, loadSlaSettings } from '@/features/inbox/load-sla';
import { loadInbox, QUEUE_CAP } from '@/features/inbox/load-inbox';
import { PendingPane } from '@/features/inbox/PendingPane';
import { StreamSkeleton } from '@/features/inbox/Skeletons';
import { PageContainer } from '@/shell/PageContainer';
import { RailUnreadCounts } from '@/shell/rail-counts';
import { pageMetadata } from '@/shell/page-metadata';
import { channelName, openReadState } from '@/api/contracts/inbox';
import { SkeletonBubbles, SkeletonCards } from '@/design-system/primitives/skeleton/Skeleton';

/**
 * Inbox - screen 02.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * FOUR PANELS AS PEERS, AND FOUR INDEPENDENT FAILURES
 * ════════════════════════════════════════════════════════════════════════════
 * The design's premise is conversation, commerce, identity and the AI's work
 * side by side rather than a chat window with a sidebar. Peers fail
 * independently: a commerce read that 403s because this agent lacks
 * `customer:commerce:read` must not blank the conversation they were sent
 * here to answer. Every panel below renders its own absence.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ EVERY PANEL IS AN ASYNC SERVER COMPONENT AND THEY ARE ALL SIBLINGS
 * ════════════════════════════════════════════════════════════════════════════
 * `ConversationList` and the streamed parts (`ConversationStream`,
 * `ConversationContext`) are each `async`, and siblings here: the structural
 * test walks this tree without running nested async components, so siblings
 * are what it can see.
 *
 * ⚠ CORRECTED: this used to say a nested async component "renders nothing".
 *   It does not - React Server Components render them, and the stream below
 *   is exactly that, inside `<Suspense>` (measured in a browser, 8bb92d6).
 *
 * ── AND `CustomerOrders` IS 04d's PANEL, GIVEN ITS DATA ──
 * Same component, same contract, loaded once by `loadInbox`. A second
 * commerce contract would be two answers about somebody's money, both
 * rendered confidently, on the same screen.
 */
export default async function Page({
  searchParams,
}: {
  /*
   * ⚠⚠ `view` WAS NOT HERE, AND THAT WAS THE WHOLE BUG. The rail writes
   *    `?view=resolved` and highlights the right item; this type declared only
   *    `c` and `cursor`, so the page ignored it and every view showed the same
   *    ten rows - "Resolved" listing open conversations, "Assigned to me"
   *    listing nine that were not.
   */
  readonly searchParams: Promise<{
    readonly c?: string;
    /**
     * The same as `c`, for a link written before Home's queue was fixed
     * (it sent `?conversation=` and the inbox read only `?c=`). `c` wins.
     */
    readonly conversation?: string;
    readonly cursor?: string;
    readonly view?: string;
    readonly channel?: string;
    /** A period (workspace days, `to` inclusive) - the assistant's sources link here. */
    readonly from?: string;
    readonly to?: string;
  }>;
}) {
  const t = await getTranslations('inbox');
  const channelNames = await getTranslations('channels');
  const common = await getTranslations('common');
  const params = await searchParams;
  const { cursor, view: rawView, channel: rawChannel, from, to } = params;
  const c = params.c ?? params.conversation;
  /*
   * `?view=ai` and `?view=flow` are one view now, "Handled by GOTCHA". An old
   * link lands there with the rest of its address kept, and the address says
   * `gotcha` - so the rail lights the view the list is showing. Not the
   * cursor: a new view starts at page one, as every inbox link does.
   */
  const retired = retiredView(rawView);
  if (retired !== null) {
    const kept = Object.fromEntries(
      Object.entries(params).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === 'string' && entry[0] !== 'view' && entry[0] !== 'cursor',
      ),
    );
    redirect({
      href: { pathname: '/inbox', query: { ...kept, view: retired } },
      locale: await getLocale(),
    });
  }
  const askedView = parseInboxView(rawView);
  const channel = parseChannelFilter(rawChannel);
  const asked = parsePeriod(from, to);
  // A period the route would refuse is not sent - and the list says it is not applied.
  const period = asked === 'invalid' ? null : asked;
  // Named in the address, or the default standing in for an absent or unknown one.
  const explicit = rawView === askedView;
  const [data, slaSettings] = await Promise.all([
    loadInbox(c, cursor, askedView, channel, period, explicit),
    loadSlaSettings(),
  ]);
  // W2: the departments' own targets, only for the departments on this page.
  const sla = await loadSlaClock(
    slaSettings,
    (data.rows ?? []).flatMap((row) => (row.departmentId === null ? [] : [row.departmentId])),
  );
  // The view the rows are of - "Active" when the default could not know who "me" is.
  const view = shownView(askedView, explicit, data.meId !== null);
  /*
    02b: the queue is clear - the default view, unfiltered, read and empty.
    Its own reads only then, so a busy inbox pays for nothing.
  */
  const clear =
    data.rows !== null &&
    data.rows.length === 0 &&
    view === 'queue' &&
    channel === null &&
    // A conversation opened by link on an empty queue is open, not "all clear".
    data.open === null &&
    data.missing === null
      ? await loadClearQueue()
      : null;
  /*
   * One `now` for the whole render. Computed per row, two conversations a
   * second apart could age differently within one screenshot - and the
   * capture runs at three viewports.
   */
  const now = new Date();

  return (
    /*
      ════════════════════════════════════════════════════════════════════════
      ⚠⚠ NO PAGE HEADER. THE DESIGN HAS NONE, AND IT COSTS ~100px OF CHROME.
      ════════════════════════════════════════════════════════════════════════
      We drew "Inbox" and "Every conversation, and what GOTCHA knows about the
      person on the other end." above the three columns. 02 starts the queue
      at the top of the frame - the sidebar already says which screen this is,
      and the space goes to conversations.

      ★ `title` and `description` are optional on `PageContainer`, so this is
        a deletion rather than a new variant.
    */
    /*
      ★ `bleed` - whose own comment names the Inbox as "the obvious one".
        It removes the 40px gutters and the 1120px cap so the three panels
        reach the dark frame's edges, as 02 draws them. Without it they sit
        inside a document's margins and the frame shows as a border rather
        than as the ground.
    */
    <PageContainer bleed>
      <div
        className={styles.screen}
        data-testid="inbox-screen"
        /*
          ⚠⚠ THIS SCREEN DRAWS ITS OWN PANELS, SO THE SHELL'S LIGHT SURFACE
             STEPS ASIDE. 02's page is `rgb(18,18,18)` and the three columns
             are `#FAF8F4` cards on it - light on near-black is the
             separation. On the shell's light surface they were invisible.

          ★ Declared by the content about itself rather than threaded as a
            prop: the shell should not have to know which screens these are.
        */
        data-owns-panels=""
      >
        {/*
          Renders nothing. It re-reads this page when the platform says a
          message arrived or a conversation changed - the list (rows, order,
          previews, new conversations, the total) and the open conversation's
          delivery, which is what makes the composer's "it will say so if it
          fails" true. Mounted whether or not a conversation is open.
        */}
        <ListLive openId={data.open?.id ?? null} />
        {/*
          Renders nothing: the rail's unread count per view - one read on
          load, then one per burst of events, never one per page render.
        */}
        <RailUnreadCounts views={INBOX_VIEW_IDS} />
        <section className={styles.queueColumn} aria-label={t('queue.label')}>
          <ConversationList
            rows={data.rows}
            cap={QUEUE_CAP}
            now={now}
            hasMore={data.hasMore}
            undatedCount={data.undatedCount}
            viewTotal={data.viewTotal}
            /*
              ⚠ The row for the conversation on screen was visually identical
                to every other row. `c` is the parameter this page already
                reads; passing it back down is what lets the queue say where
                you are.
            */
            /*
              ⚠ THE OPEN CONVERSATION, NOT THE `c` PARAMETER. With no `?c=` the
                loader opens the first row, and passing `c` marked nothing -
                a conversation on screen with no row saying it was the one.
            */
            openId={data.open?.id ?? null}
            meId={data.meId}
            role={data.role}
            colleagues={data.colleagues}
            greeting={data.greeting}
            view={view}
            channel={channel}
            period={period}
            periodInvalid={asked === 'invalid'}
            clear={clear ? <ClearQueueList clear={clear} /> : null}
            sla={sla}
          />
        </section>

        {/*
          ════════════════════════════════════════════════════════════════════
          ⚠⚠ TWO PANELS, NOT THREE - AND THE COPILOT IS THIS ONE’S WALL
          ════════════════════════════════════════════════════════════════════
          From 02’s computed tree: the chat panel is `[856x876] bg:#FAF8F4
          r:18px ovf:hidden`, and INSIDE it a `[856x809]` flex ROW holds
          `[484x809]` of conversation beside `[372x809]` of Copilot at
          `bg:rgb(23,23,23)` with `r:0 0 18px 18px`.

          ★★ That radius is the giveaway: the Copilot inherits the PANEL’s
             bottom-right corner, which only a CHILD can do. It is not a card
             beside the conversation - it is the right-hand wall of the same
             card, dark against the panel’s light.

          ⚠ And the branch below is one SECTION with two bodies, not two
            sections. It was two, and moving the Copilot into the open one
            silently dropped it from the empty one - the panel vanished on
            the state where somebody has nothing selected.
        */}
        <section className={styles.conversationColumn} aria-label={t('open.label')}>
          {/*
            ⚠⚠ THE HEADER SPANS THE WHOLE PANEL, AND THE COPILOT STARTS BELOW IT.
            02: header `[856x67]` across the full chat panel, THEN the split
            `[856x809]` = conversation `[484]` + Copilot `[372]` at y=79.
            Ours had the header inside the conversation pane, so the dark
            Copilot ran to the top of the panel and cut through the name and
            the three buttons. Order matters: header first, then the split.
          */}
          {data.open === null ? null : (
            <>
              {/*
                ★★ WHO IS DRIVING, ABOVE THE STREAM.
                It is the first question an agent has on opening a conversation
                and the controls that change it are the same answer. Below the
                stream they would be read as "reply", which is the one thing
                they are not.

                `mine` is false whenever we could not read who is looking: the
                transfer route would refuse it anyway, and a control that always
                403s is worse than one that is absent.
              */}
              {/*
                ★★ WHO THIS IS, ABOVE WHO IS DRIVING.
                The column used to begin at the verbs and go straight into
                messages, so an agent arriving from the queue read a wall of text
                with no statement of who it is with, on what channel, or how long
                they have waited - the three facts that decide how the first
                sentence should be written.

                A sibling, not a parent - which keeps both visible to the
                structural test (it does not run nested async components).
              */}
              {/*
                ★★ ONE BAR, WHICH IS WHAT I SAID AND NOT WHAT SHIPPED.
                I described the header and the verbs as "one bordered bar". They
                were siblings: the header had the border and the verbs sat outside
                it, so "Take control" still read as detached - a walk said so, and
                it was right. The description was of the intent, not the markup.

                A plain `div` again, so both stay siblings of each other and of
                `MessageStream`: all three are async or client components and none
                may contain another.
              */}
              <div className={styles.openBar}>
                <ConversationHeader
                  conversation={data.open}
                  now={now}
                  /*
                    The chip needs the order read, which is the second round, so
                    it streams in beside the name; the header does not wait.
                  */
                  chip={
                    data.detail ? (
                      <Suspense key={data.open.id} fallback={null}>
                        <OrdersChip detail={data.detail} />
                      </Suspense>
                    ) : null
                  }
                />

                <ConversationVerbs
                  conversationId={data.open.id}
                  meKnown={data.meId !== null}
                  mine={data.meId !== null && data.open.assignedAgentId === data.meId}
                  handedOver={data.open.isHandedOver}
                  /*
                   * Two-state rather than three, and only because it was
                   * checked: the list route puts no `select` on the conversation,
                   * so `assignedAiAgentId` is genuinely on the wire and `null`
                   * means no AI employee rather than "not sent".
                   */
                  hasAiEmployee={data.open.assignedAiAgentId !== null}
                  greeting={data.greeting}
                  colleagues={data.colleagues}
                  /*
                   * ⚠ `CLOSED` is the only status that means resolved. `OPEN`
                   *   and `WAITING` are both live - and `WAITING` most of all,
                   *   since somebody is waiting for a reply.
                   */
                  resolved={data.open.status === 'CLOSED'}
                />
              </div>
            </>
          )}
          <div className={styles.chatBody}>
            <div className={styles.conversationPane}>
              {data.open === null && clear ? (
                <ClearQueuePane clear={clear} />
              ) : data.open === null && data.missing === null && data.rows !== null ? (
                /* Nothing picked yet, or Esc closed it: pick one, as WhatsApp asks. */
                <NothingOpen />
              ) : data.open === null ? (
                <p className={styles.note} data-testid="inbox-nothing-open">
                  {data.missing === 'unavailable'
                    ? t('open.notAvailable')
                    : data.missing === 'failed'
                      ? t('open.openFailed')
                      : t('open.unavailable')}
                </p>
              ) : (
                <>
                  {/* Renders nothing: Esc closes this conversation (see `InboxEscape`). */}
                  <InboxEscape conversationId={data.open.id} />
                  {/*
                    Renders nothing: opening it reads it, for this person, once
                    per open. The list re-renders only if its row was unread.
                  */}
                  <MarkReadOnOpen
                    conversationId={data.open.id}
                    readState={openReadState(data.open)}
                  />
                  {/*
                    ════════════════════════════════════════════════════════
                    ★★ THE STREAM STREAMS. Omer: "I want it to feel instant."
                    ════════════════════════════════════════════════════════
                    It waited for the whole page before; now the frame, the
                    queue, the header and the composer paint, and the stream
                    - with the Copilot's strip under it and the pin to its
                    latest message - arrives when its read does.

                    ★ Keyed by the conversation, so opening another one shows
                      the skeleton again rather than the last one's messages
                      under the new one's name.
                  */}
                  {data.detail ? (
                    <Suspense key={data.open.id} fallback={<StreamSkeleton />}>
                      <ConversationStream
                        detail={data.detail}
                        conversationId={data.open.id}
                        channel={data.open.channel}
                      />
                    </Suspense>
                  ) : null}

                  {/*
                    ⚠⚠ THE ONE CONTROL ON THIS PROJECT WHOSE PURPOSE IS TO BE PRESSED.
                    It sends a message to a real person on a tenant whose WhatsApp
                    channel reaches real handsets, and this platform has no undo
                    anywhere. No automated run presses it; no human presses it on dev
                    until Omer has said so.

                    Outside the boundary: it needs nothing from the second round,
                    so it is there to type into before the messages are.
                  */}
                  <Composer
                    conversationId={data.open.id}
                    channelName={channelName(data.open.channel, channelNames)}
                  />
                </>
              )}
            </div>
            {/*
              ★★ THE WALL IS DRAWN ONLY BESIDE AN OPEN CONVERSATION (Omer,
              2026-10-07): with none - nothing picked, or Esc closed it, or a
              clear queue (02b) - there is no customer for it to know about,
              so it is not rendered at all and the pane takes its width, as
              WhatsApp does. A question not about a customer is the separate
              Copilot proposal, not this panel.
            */}
            {data.open === null ? null : (
              <aside className={styles.contextColumn} aria-label={t('context.label')}>
                {/*
                  02's wall: a fixed 45px header, the scrolling body, and the
                  pinned "Ask Copilot anything…". Only the body waits for the
                  second round; the other two paint with the frame.

                  ★ The provider draws nothing: it holds the AI's steps, read
                    once and updated by event, for the header's "Working on
                    this" and the body's "What it did" alike. Keyed, so the
                    next conversation starts from its own read.
                */}
                <ActivityProvider key={data.open.id} conversationId={data.open.id}>
                  <WallHeader
                    conversationId={data.open.id}
                    /*
                     * "stop" is Stop AI, so only where the AI answers: an AI
                     * employee bound, and no person has taken over.
                     */
                    aiDriving={data.open.assignedAiAgentId !== null && !data.open.isHandedOver}
                  />
                  <div className={styles.copilotBody}>
                    {data.detail ? (
                      <Suspense
                        key={data.open.id}
                        // The wall's shape, light on the dark: an answer card, then the thread.
                        fallback={
                          <div data-testid="copilot-skeleton">
                            <SkeletonCards
                              label={common('loading')}
                              tone="light"
                              count={1}
                              columns={1}
                              height={140}
                            />
                            <SkeletonBubbles label={common('loading')} tone="light" count={3} />
                          </div>
                        }
                      >
                        <CopilotWall
                          detail={data.detail}
                          conversation={{
                            id: data.open.id,
                            contactId: data.open.contactId,
                            customerName: data.open.customerName,
                            channel: data.open.channel,
                          }}
                        />
                      </Suspense>
                    ) : null}
                  </div>
                  {/* Keyed: a question half-typed about one person is not asked about the next. */}
                  <AskCopilot key={data.open.id} conversationId={data.open.id} />
                </ActivityProvider>
              </aside>
            )}
          </div>

          {/*
            ★★ THE CLICK'S ANSWER, BEFORE THE SERVER'S. Over the panel: the
            clicked row's name and the stream's skeleton, from the moment of the
            click until the new page lands. Renders nothing otherwise.
          */}
          <PendingPane openId={data.open?.id ?? null} />
        </section>
      </div>
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('primary.inbox');
