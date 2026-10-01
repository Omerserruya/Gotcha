import { getTranslations } from 'next-intl/server';

import { CustomerOrders } from '@/features/customers/CustomerOrders';
import { ConversationHeader } from '@/features/inbox/ConversationHeader';
import { Composer } from '@/features/inbox/Composer';
import { CopilotPanel } from '@/features/inbox/CopilotPanel';
import { StreamLive } from '@/features/inbox/StreamLive';
import { ConversationList } from '@/features/inbox/ConversationList';
import { ConversationVerbs } from '@/features/inbox/ConversationVerbs';
import { IdentityPanel } from '@/features/inbox/IdentityPanel';
import styles from '@/features/inbox/Inbox.module.css';
import { parseChannelFilter, parseInboxView } from '@/features/inbox/inbox-views';
import { loadInbox, QUEUE_CAP } from '@/features/inbox/load-inbox';
import { MessageStream } from '@/features/inbox/MessageStream';
import { PageContainer } from '@/shell/PageContainer';
import { pageMetadata } from '@/shell/page-metadata';
import { channelName } from '@/api/contracts/inbox';

/**
 * Inbox — screen 02.
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
 * `ConversationList`, `MessageStream`, `IdentityPanel` and `CustomerOrders`
 * are each `async`. **An async server component nested inside another renders
 * nothing** — silently, with no error and no empty element to notice. It has
 * cost five screens in this project. They are siblings here, and the only
 * thing between them is markup.
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
   *    ten rows — "Resolved" listing open conversations, "Assigned to me"
   *    listing nine that were not.
   */
  readonly searchParams: Promise<{
    readonly c?: string;
    readonly cursor?: string;
    readonly view?: string;
    readonly channel?: string;
  }>;
}) {
  const t = await getTranslations('inbox');
  const channelNames = await getTranslations('channels');
  const { c, cursor, view: rawView, channel: rawChannel } = await searchParams;
  const view = parseInboxView(rawView);
  const channel = parseChannelFilter(rawChannel);
  const data = await loadInbox(c, cursor, view, channel);
  /*
   * One `now` for the whole render. Computed per row, two conversations a
   * second apart could age differently within one screenshot — and the
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
      at the top of the frame — the sidebar already says which screen this is,
      and the space goes to conversations.

      ★ `title` and `description` are optional on `PageContainer`, so this is
        a deletion rather than a new variant.
    */
    /*
      ★ `bleed` — whose own comment names the Inbox as "the obvious one".
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
             are `#FAF8F4` cards on it — light on near-black is the
             separation. On the shell's light surface they were invisible.

          ★ Declared by the content about itself rather than threaded as a
            prop: the shell should not have to know which screens these are.
        */
        data-owns-panels=""
      >
        <section className={styles.queueColumn} aria-label={t('queue.label')}>
          <ConversationList
            rows={data.rows}
            cap={QUEUE_CAP}
            now={now}
            hasMore={data.hasMore}
            undatedCount={data.undatedCount}
            /*
              ⚠ The row for the conversation on screen was visually identical
                to every other row. `c` is the parameter this page already
                reads; passing it back down is what lets the queue say where
                you are.
            */
            /*
              ⚠ THE OPEN CONVERSATION, NOT THE `c` PARAMETER. With no `?c=` the
                loader opens the first row, and passing `c` marked nothing —
                a conversation on screen with no row saying it was the one.
            */
            openId={data.open?.id ?? null}
            meId={data.meId}
            view={view}
            channel={channel}
          />
        </section>

        {/*
          ════════════════════════════════════════════════════════════════════
          ⚠⚠ TWO PANELS, NOT THREE — AND THE COPILOT IS THIS ONE’S WALL
          ════════════════════════════════════════════════════════════════════
          From 02’s computed tree: the chat panel is `[856x876] bg:#FAF8F4
          r:18px ovf:hidden`, and INSIDE it a `[856x809]` flex ROW holds
          `[484x809]` of conversation beside `[372x809]` of Copilot at
          `bg:rgb(23,23,23)` with `r:0 0 18px 18px`.

          ★★ That radius is the giveaway: the Copilot inherits the PANEL’s
             bottom-right corner, which only a CHILD can do. It is not a card
             beside the conversation — it is the right-hand wall of the same
             card, dark against the panel’s light.

          ⚠ And the branch below is one SECTION with two bodies, not two
            sections. It was two, and moving the Copilot into the open one
            silently dropped it from the empty one — the panel vanished on
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
                they have waited — the three facts that decide how the first
                sentence should be written.

                A sibling, not a parent: both are async server components and
                nesting one inside the other renders nothing.
              */}
              {/*
                ★★ ONE BAR, WHICH IS WHAT I SAID AND NOT WHAT SHIPPED.
                I described the header and the verbs as "one bordered bar". They
                were siblings: the header had the border and the verbs sat outside
                it, so "Take control" still read as detached — a walk said so, and
                it was right. The description was of the intent, not the markup.

                A plain `div` again, so both stay siblings of each other and of
                `MessageStream`: all three are async or client components and none
                may contain another.
              */}
              <div className={styles.openBar}>
                <ConversationHeader
                  conversation={data.open}
                  now={now}
                  /* The read the Copilot's orders panel already has — no second fetch. */
                  orders={data.orders}
                />

                <ConversationVerbs
                  conversationId={data.open.id}
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
                   *   and `WAITING` are both live — and `WAITING` most of all,
                   *   since somebody is waiting for a reply.
                   */
                  resolved={data.open.status === 'CLOSED'}
                />
              </div>
            </>
          )}
          <div className={styles.chatBody}>
            <div className={styles.conversationPane}>
              {data.open === null ? (
                <p className={styles.note} data-testid="inbox-nothing-open">
                  {data.rows === null ? t('open.unavailable') : t('open.none')}
                </p>
              ) : (
                <>
                  {/*
                    Renders nothing. It keeps this conversation current as delivery
                    changes, which is what makes the composer's "it will say so if it
                    fails" true rather than a sentence we wrote.
                  */}
                  <StreamLive conversationId={data.open.id} />

                  <MessageStream messages={data.messages} channel={data.open.channel} />

                  {/*
                    ★★ BELOW THE STREAM, AND A SIBLING OF IT.
                    A suggested reply belongs next to where a reply gets written, which
                    is the bottom of this column. And both are async server components,
                    so neither may contain the other.

                    `loadCopilot` is awaited in `loadInbox` alongside every other read:
                    a 402 here is an ordinary commercial state and must not take the
                    conversation down with it.
                  */}
                  <CopilotPanel read={data.copilot} />

                  {/*
                    ⚠⚠ THE ONE CONTROL ON THIS PROJECT WHOSE PURPOSE IS TO BE PRESSED.
                    It sends a message to a real person on a tenant whose WhatsApp
                    channel reaches real handsets, and this platform has no undo
                    anywhere. No automated run presses it; no human presses it on dev
                    until Omer has said so.

                    Last in the column, so the order reading down is: who this is · who
                    is driving · what was said · what GOTCHA would say · what you are
                    about to say.
                  */}
                  <Composer
                    conversationId={data.open.id}
                    channelName={channelName(data.open.channel, channelNames)}
                  />
                </>
              )}
            </div>
            <aside className={styles.contextColumn} aria-label={t('context.label')}>
              {/*
                ⚠ THE COPILOT’S SCROLLING BODY. 02: `[372x693] flex:1 1 0%
                  ovf:hidden`, between a fixed 45px header and a pinned 71px
                  input. Neither of those exists yet; the body is in place so
                  that adding them does not mean restructuring this again.
              */}
              <div className={styles.copilotBody}>
                <IdentityPanel
                  timeline={data.timeline}
                  conversation={
                    data.open
                      ? {
                          contactName: data.open.customerName,
                          channel: data.open.channel,
                          /*
                           * ★ THE HANDLE, WHICH THE PANEL WAS SAYING IT DID NOT HAVE.
                           * It rendered *"No channel handle is recorded for this
                           * person"* beside a row showing a channel, because nothing
                           * passed one. Two true sentences about different things,
                           * reading as a contradiction.
                           */
                          customerExternalId: data.open.customerExternalId,
                        }
                      : null
                  }
                />
                {/*
                04d's panel. `conversationId` is what its actions post to, and it
                is `null` when nothing is open — the controls are then absent
                rather than broken, because the endpoint has nowhere to route.
              */}
                <CustomerOrders orders={data.orders} conversationId={data.open?.id ?? null} />
              </div>
            </aside>
          </div>
        </section>
      </div>
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('primary.inbox');
