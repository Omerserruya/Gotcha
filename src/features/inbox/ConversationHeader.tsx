import { getTranslations } from 'next-intl/server';

import {
  channelName,
  waitingMinutes,
  waitingScale,
  type ConversationRow,
} from '@/api/contracts/inbox';
import { UserText } from '@/design-system/primitives/text/UserText';

import styles from './Inbox.module.css';

/**
 * Who this conversation is with — screen 02's missing header.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THE STREAM OPENED WITH NO SUBJECT
 * ════════════════════════════════════════════════════════════════════════════
 * A browser walk found the conversation column starting at the verbs and then
 * going straight into messages. So an agent arriving from the queue, or from a
 * link, read a wall of text with no statement of **who it is with, on what
 * channel, and how long they have been waiting** — the three facts that decide
 * how the first sentence should be written.
 *
 * Every field here is already loaded for the queue row beside it. Nothing new is
 * read; the screen simply said none of it once the row was opened.
 *
 * ── AND IT SITS WITH THE VERBS, WHICH WERE FLOATING ──
 * "Take control" and its siblings were loose above the stream with no
 * surrounding block, so they read as the first thing in the conversation rather
 * than as controls over it. Header and verbs are now one bar. The verbs stay
 * BELOW the identity, because the answer to "who is driving" is only meaningful
 * once you know who you are driving for.
 */
export async function ConversationHeader({
  conversation,
  now,
}: {
  readonly conversation: ConversationRow;
  /** One `now` for the whole render — the capture runs at three viewports. */
  readonly now: Date;
}) {
  const t = await getTranslations('inbox');
  const channels = await getTranslations('channels');

  const minutes = waitingMinutes(conversation, now);
  const waiting = minutes === null ? null : waitingScale(minutes);

  return (
    <header className={styles.openHeader} data-testid="conversation-header">
      <div className={styles.openWho}>
        {/*
          The customer's own name, isolated. A Hebrew name in an English page
          reorders the line around it without `bdi`, which is the defect that
          shipped on five other surfaces.
        */}
        <h2 className={styles.openName} data-testid="conversation-who">
          {conversation.customerName?.trim() ? (
            <UserText>{conversation.customerName}</UserText>
          ) : (
            /*
             * ★★ NOT `identity.unnamed`, WHICH IS THE STRING "Someone".
             * The first version of this used that key while the comment beside
             * it said the heading "says the plain truth rather than inventing
             * Someone" — a comment describing behaviour the code did not have,
             * which is the second time today I have written one of those.
             *
             * No name is an ordinary state: a first message from a number
             * nobody has met. The handle below identifies them, so the heading
             * says there is no name instead of supplying a person.
             */
            <span className={styles.openUnnamed}>{t('open.noName')}</span>
          )}
        </h2>

        <p className={styles.openFacts} data-testid="conversation-facts">
          {[
            channelName(conversation.channel, channels),
            /*
             * The handle, which is what makes two unnamed people tellable
             * apart. Already on screen 04's rows, so this is not new exposure.
             */
            conversation.customerExternalId,
            t(`open.status.${conversation.status}` as 'open.status.OPEN'),
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </div>

      {/*
        ★★ HOW LONG THEY HAVE BEEN WAITING, AND SILENCE WHEN WE CANNOT SAY.
        `waitingMinutes` is `null` when `lastMessageAt` is absent — a
        denormalised cache maintained by convention, so its absence is real and
        common. A row we cannot age says nothing rather than "0m", which would
        sort it as the freshest thing on the screen and read as just-arrived.
      */}
      {waiting ? (
        <p
          className={styles.openWaiting}
          data-testid="conversation-waiting"
          data-scale={waiting.scale}
        >
          {t(`queue.waitingFor.${waiting.scale}` as 'queue.waitingFor.minutes', {
            value: waiting.value,
          })}
        </p>
      ) : (
        <p className={styles.openWaitingUnknown} data-testid="conversation-waiting-unknown">
          {t('open.waitingUnknown')}
        </p>
      )}
    </header>
  );
}
