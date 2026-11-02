import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';

import { channelName, openReadState } from '@/api/contracts/inbox';
import { Composer } from '@/features/inbox/Composer';
import { ConversationStream } from '@/features/inbox/ConversationDetail';
import { ConversationVerbs } from '@/features/inbox/ConversationVerbs';
import { initials } from '@/features/inbox/initials';
import { ListLive } from '@/features/inbox/ListLive';
import { loadInbox } from '@/features/inbox/load-inbox';
import { MarkReadOnOpen } from '@/features/inbox/MarkReadOnOpen';
import { StreamSkeleton } from '@/features/inbox/Skeletons';
import styles from '@/features/mobile/inbox/mobile-inbox.module.css';
import { PersonName } from '@/features/customers/PersonName';
import { MobileBar } from '@/shell/mobile/MobileBar';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * One conversation on the phone: who, the stream, the reply.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THE DESKTOP'S PARTS, NOT COPIES OF THEM
 * ════════════════════════════════════════════════════════════════════════════
 * The stream, the verbs (take over, hand back, resolve, transfer), the
 * composer with its reply window and templates, mark-read and the live
 * refresh are the inbox's own components, so the phone sends through the same
 * actions and refuses what the website refuses. What is not here is the
 * Copilot wall and the commerce panel: there is no room beside the stream on
 * a phone, and they stay on the website.
 *
 * ⚠⚠ THE COMPOSER SENDS TO A REAL PERSON. Nothing automated presses it, on
 *    dev or anywhere, without Omer's word: the same rule as the desktop.
 */
export default async function Page({ params }: { readonly params: Promise<{ readonly id: string }> }) {
  const { id } = await params;
  const t = await getTranslations('mobile');
  const channelNames = await getTranslations('channels');
  const inbox = await getTranslations('inbox');
  const data = await loadInbox(id);
  const open = data.open;
  const back = { href: '/m/inbox', label: t('inbox.back') } as const;

  if (open === null) {
    return (
      <div className={styles.screen}>
        <MobileBar back={back} />
        <p className={styles.note} data-testid="mobile-thread-missing">
          {data.missing === 'unavailable' ? t('inbox.notAvailable') : t('inbox.openFailed')}
        </p>
      </div>
    );
  }

  const channel = channelName(open.channel, channelNames);
  return (
    <div className={styles.screen} data-testid="mobile-thread">
      {/* Renders nothing: re-reads the stream and the delivery marks when the platform says so. */}
      <ListLive openId={open.id} />
      {/* Renders nothing: opening it reads it, for this person, once per open. */}
      <MarkReadOnOpen conversationId={open.id} readState={openReadState(open)} />
      <MobileBar
        back={back}
        lead={
          <span className={styles.barAvatar} aria-hidden="true">
            {initials(open.customerName)}
          </span>
        }
        title={
          <span className={styles.barTitle}>
            <span className={styles.barName}>
              {open.customerName === null ? (
                inbox('queue.unnamed')
              ) : (
                <PersonName name={open.customerName} />
              )}
            </span>
            {channel === null ? null : <span className={styles.barMeta}>{channel}</span>}
          </span>
        }
      />
      <div className={styles.thread}>
        <div className={styles.verbs}>
          <ConversationVerbs
            conversationId={open.id}
            meKnown={data.meId !== null}
            mine={data.meId !== null && open.assignedAgentId === data.meId}
            handedOver={open.isHandedOver}
            hasAiEmployee={open.assignedAiAgentId !== null}
            greeting={data.greeting}
            colleagues={data.colleagues}
            resolved={open.status === 'CLOSED'}
          />
        </div>
        <div className={styles.stream}>
          {data.detail ? (
            <Suspense key={open.id} fallback={<StreamSkeleton />}>
              <ConversationStream detail={data.detail} conversationId={open.id} channel={open.channel} />
            </Suspense>
          ) : null}
        </div>
        <div className={styles.composer}>
          <Composer
            conversationId={open.id}
            channelName={channel}
            replyWindow={open.replyWindow}
            customerName={open.customerName}
            resolved={open.status === 'CLOSED'}
          />
        </div>
      </div>
    </div>
  );
}

export const generateMetadata = pageMetadata('primary.inbox');
