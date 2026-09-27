import { getTranslations } from 'next-intl/server';

import { CustomerOrders } from '@/features/customers/CustomerOrders';
import { ConversationList } from '@/features/inbox/ConversationList';
import { ConversationVerbs } from '@/features/inbox/ConversationVerbs';
import { IdentityPanel } from '@/features/inbox/IdentityPanel';
import styles from '@/features/inbox/Inbox.module.css';
import { loadInbox, QUEUE_CAP } from '@/features/inbox/load-inbox';
import { MessageStream } from '@/features/inbox/MessageStream';
import { PageContainer } from '@/shell/PageContainer';
import { pageMetadata } from '@/shell/page-metadata';

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
  readonly searchParams: Promise<{ readonly c?: string; readonly cursor?: string }>;
}) {
  const t = await getTranslations('inbox');
  const { c, cursor } = await searchParams;
  const data = await loadInbox(c, cursor);
  /*
   * One `now` for the whole render. Computed per row, two conversations a
   * second apart could age differently within one screenshot — and the
   * capture runs at three viewports.
   */
  const now = new Date();

  return (
    <PageContainer title={t('title')} description={t('description')}>
      <div className={styles.screen} data-testid="inbox-screen">
        <section className={styles.queueColumn} aria-label={t('queue.label')}>
          <ConversationList
            rows={data.rows}
            cap={QUEUE_CAP}
            now={now}
            hasMore={data.hasMore}
            undatedCount={data.undatedCount}
          />
        </section>

        {data.open === null ? (
          /*
           * ★ NOTHING IS OPEN, WHICH IS NOT AN ERROR AND NOT AN EMPTY QUEUE.
           * `rows === null` is a failed queue read and `ConversationList`
           * has already said so on the left. This is the other case: the
           * queue answered and there is nothing in it, or the id in the URL
           * is not on this page.
           */
          <section className={styles.conversationColumn}>
            <p className={styles.note} data-testid="inbox-nothing-open">
              {data.rows === null ? t('open.unavailable') : t('open.none')}
            </p>
          </section>
        ) : (
          <section className={styles.conversationColumn} aria-label={t('open.label')}>
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
            />

            <MessageStream messages={data.messages} channel={data.open.channel} />
          </section>
        )}

        <aside className={styles.contextColumn} aria-label={t('context.label')}>
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
        </aside>
      </div>
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('primary.inbox');
