import { getLocale, getTranslations } from 'next-intl/server';
import { Suspense } from 'react';

import { aiCarries, channelAccountName, channelName, openReadState } from '@/api/contracts/inbox';
import { ChannelPlate } from '@/design-system/brand/channel-plate';
import { CustomerWho } from '@/features/inbox/CustomerWho';
import { Composer } from '@/features/inbox/Composer';
import { ConversationStream } from '@/features/inbox/ConversationDetail';
import { initials } from '@/features/inbox/initials';
import { ListLive } from '@/features/inbox/ListLive';
import { loadInbox } from '@/features/inbox/load-inbox';
import { MarkReadOnOpen } from '@/features/inbox/MarkReadOnOpen';
import { RelevanceControl } from '@/features/inbox/RelevanceControl';
import { relevanceOverride, relevanceTag } from '@/features/inbox/relevance';
import { inboxRelevanceOn } from '@/api/client/inbox-relevance';
import { StreamSkeleton } from '@/features/inbox/Skeletons';
import styles from '@/features/mobile/inbox/mobile-inbox.module.css';
import { MobileCopilotCard } from '@/features/mobile/inbox/MobileCopilotCard';
import { MobileThreadVerbs } from '@/features/mobile/inbox/MobileThreadVerbs';
import ui from '@/features/mobile/mobile-ui.module.css';
import { MobileBar } from '@/shell/mobile/MobileBar';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * One conversation on the phone (`GOTCHA Mobile App.dc.html`): who and on
 * what, the AI's switch, the stream on its warm ground, Copilot's ready reply
 * and the composer.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THE INBOX'S PARTS, IN THE PHONE'S LOOK
 * ════════════════════════════════════════════════════════════════════════════
 * The stream, the composer with its reply window and templates, mark-read,
 * the live refresh and the suggestions are the inbox's own, drawn with
 * `variant="phone"`, so the phone sends through the same actions and refuses
 * what the website refuses. The commerce panel and the full Copilot wall stay
 * on the website, one tap away in the bar's menu.
 *
 * ★ A RESOLVED CONVERSATION KEEPS ITS COMPOSER (Omer, 2026-11-03). A person
 *   who writes into a CLOSED conversation reopens it and takes it - the send
 *   route's rule (Backend) - so the field is not blocked here, and the
 *   composer re-reads the screen after that send: the status, the owner and
 *   the AI button all change with it.
 *
 * ⚠⚠ THE COMPOSER SENDS TO A REAL PERSON. Nothing automated presses it, on
 *    dev or anywhere, without Omer's word: the same rule as the desktop.
 */
export default async function Page({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  const { id } = await params;
  const t = await getTranslations('mobile');
  const channelNames = await getTranslations('channels');
  const inbox = await getTranslations('inbox');
  const locale = await getLocale();
  const data = await loadInbox(id);
  const open = data.open;
  const back = { href: '/m/inbox', label: t('inbox.back') } as const;

  if (open === null) {
    return (
      <div className={ui.screen}>
        <MobileBar back={back} />
        <p className={styles.note} data-testid="mobile-thread-missing">
          {data.missing === 'unavailable' ? t('inbox.notAvailable') : t('inbox.openFailed')}
        </p>
      </div>
    );
  }

  const channel = channelName(open.channel, channelNames);
  /* Which number, when the workspace has two or more (Omer, 2026-11-16). */
  const account = channelAccountName(open);
  const mine = data.meId !== null && open.assignedAgentId === data.meId;
  const resolved = open.status === 'CLOSED';
  const owner = resolved
    ? t('inbox.owner.resolved')
    : open.isHandedOver
      ? mine
        ? t('inbox.owner.mine')
        : t('inbox.owner.waiting')
      : open.handledBy === 'awaiting_approval'
        ? t('inbox.owner.approval')
        : aiCarries(open.handledBy)
          ? t('inbox.owner.gotcha')
          : null;

  return (
    <div className={ui.screen} data-testid="mobile-thread">
      {/* Renders nothing: re-reads the stream and the delivery marks when the platform says so. */}
      <ListLive openId={open.id} />
      {/* Renders nothing: opening it reads it, for this person, once per open. */}
      <MarkReadOnOpen conversationId={open.id} readState={openReadState(open)} />
      <MobileBar
        back={back}
        edge
        lead={
          <span className={styles.barAvatar}>
            <span className={styles.barAvatarFace} aria-hidden="true">
              {initials(open.customerName)}
            </span>
            {open.channel === null ? null : (
              <span className={styles.barBadge}>
                <ChannelPlate channel={open.channel} label={channel ?? open.channel} size="xs" />
              </span>
            )}
          </span>
        }
        title={
          <span className={styles.barTitle}>
            <span className={styles.barName}>
              <CustomerWho row={open} unnamed={inbox('queue.unnamed')} />
            </span>
            {channel === null && account === null && owner === null ? null : (
              <span className={styles.barMeta}>
                {channel}
                {channel !== null && account !== null ? ' · ' : null}
                {account === null ? null : (
                  <bdi dir="auto" data-testid="mobile-thread-account">
                    {account}
                  </bdi>
                )}
                {(channel !== null || account !== null) && owner !== null ? ' · ' : null}
                {owner}
              </span>
            )}
          </span>
        }
        actions={
          <MobileThreadVerbs
            conversationId={open.id}
            mine={mine}
            handedOver={open.isHandedOver}
            hasAiEmployee={open.assignedAiAgentId !== null}
            greeting={data.greeting}
            colleagues={data.colleagues}
            resolved={resolved}
            websiteHref={`/${locale}/inbox?c=${encodeURIComponent(open.id)}`}
            customerHref={`/m/inbox/${encodeURIComponent(open.id)}/customer`}
          />
        }
      />
      <div className={styles.thread}>
        {/* What it is, and the one-click override (`INBOX_RELEVANCE`). */}
        {inboxRelevanceOn() ? (
          <RelevanceControl
            conversationId={open.id}
            tag={relevanceTag(open)}
            override={relevanceOverride(open)}
            classes={{
              group: styles.relevanceStrip,
              tag: ui.tag,
              button: styles.relevanceButton,
              problem: styles.relevanceProblem,
              note: styles.relevanceNote,
            }}
          />
        ) : null}
        <div className={styles.stream}>
          {data.detail ? (
            <Suspense key={open.id} fallback={<StreamSkeleton />}>
              <ConversationStream
                detail={data.detail}
                conversationId={open.id}
                channel={open.channel}
                variant="phone"
              />
            </Suspense>
          ) : null}
        </div>
        {resolved ? null : <MobileCopilotCard conversationId={open.id} />}
        <div className={styles.composer}>
          <Composer
            conversationId={open.id}
            channelName={channel}
            accountName={account}
            channel={open.channel}
            replyWindow={open.replyWindow}
            customerName={open.customerName}
            resolved={resolved}
            variant="phone"
          />
        </div>
      </div>
    </div>
  );
}

export const generateMetadata = pageMetadata('primary.inbox');
