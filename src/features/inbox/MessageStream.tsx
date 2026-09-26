import { getFormatter, getTranslations } from 'next-intl/server';

import {
  hasTranscript,
  quotedState,
  renderableType,
  systemEventOf,
  type InboxMessage,
} from '@/api/contracts/inbox';

import styles from './Inbox.module.css';

/**
 * Screen 02's message stream.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * FOUR THINGS THE DESIGN PUTS HERE THAT ARE NOT DRAWN
 * ════════════════════════════════════════════════════════════════════════════
 *   "GOTCHA saw damage in this photo"   no vision path exists anywhere
 *   "Read what she said" on a voice note  nothing transcribes audio — see below
 *   reactions                            no model. Left out, not disabled
 *   a 3px intent edge per message        intent persists per CONVERSATION only;
 *                                        the per-message type exists in
 *                                        `ai-assist.service.ts` and nothing
 *                                        writes it
 *
 * ── AND THE READ RECEIPT IS THE CUSTOMER'S ──
 * `Message.readAt` is when the CUSTOMER read our message. It is labelled as
 * that and never as the agent having seen anything: agent-unread has no
 * field at all, and the one that looks like it belongs to the other party.
 */
export async function MessageStream({
  messages,
  channel,
}: {
  /** `null` when the read failed. Never an empty conversation. */
  readonly messages: readonly InboxMessage[] | null;
  /** Drives nothing here yet; carried so the caller cannot forget it exists. */
  readonly channel: string | null;
}) {
  const t = await getTranslations('inbox');
  const format = await getFormatter();

  if (messages === null) {
    return (
      <div className={styles.stream} data-testid="stream-unavailable">
        <p className={styles.note}>{t('stream.unavailable')}</p>
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className={styles.stream} data-testid="stream-empty">
        <p className={styles.note}>{t('stream.empty')}</p>
      </div>
    );
  }

  return (
    <ol className={styles.stream} data-testid="message-stream" data-channel={channel ?? 'unknown'}>
      {messages.map((message) => {
        /*
         * ════════════════════════════════════════════════════════════════
         * ★★ A COLLEAGUE'S ACTION IS NOT A MESSAGE, AND NOT THE CUSTOMER'S
         * ════════════════════════════════════════════════════════════════
         * `createSystemMessage` writes `direction: "INBOUND"` with an empty
         * body, so a claim, a transfer and a return to the AI all arrive
         * looking like the customer sent nothing. Rendered as a bubble they
         * sit on the customer's side of the thread and read as theirs.
         *
         * A divider instead: no side, no timestamp bubble, and it names who
         * did what. This is the visible consequence of the three buttons
         * below the stream — pressing "take control" writes one of these.
         */
        const systemEvent = systemEventOf(message);
        if (systemEvent) {
          return (
            <li
              key={message.id}
              className={styles.divider}
              data-testid={`system-${message.id}`}
              data-event={systemEvent}
            >
              <span className={styles.dividerText}>
                {t(`stream.system.${systemEvent}` as 'stream.system.agent_claimed', {
                  /*
                   * Empty string rather than a placeholder name. The service
                   * writes `agentName: updated.assignedAgent?.name || "Agent"`
                   * — so a missing name already arrives as the word "Agent",
                   * and inventing a second fallback here would hide which of
                   * the two happened. ICU needs the argument present.
                   */
                  name: message.metadata?.agentName ?? '',
                  from: message.metadata?.fromAgentName ?? '',
                  to: message.metadata?.toAgentName ?? '',
                })}
              </span>
            </li>
          );
        }

        const type = renderableType(message);
        const quoted = quotedState(message);
        /*
         * Did any branch above draw the message's content? Recognising a
         * type and rendering it are different things, and only the second
         * one means the agent can see what was sent.
         */
        const rendered =
          type === 'audio' || type === 'image' || type === 'video' || type === 'document';
        return (
          <li
            key={message.id}
            className={styles.message}
            data-testid={`message-${message.id}`}
            data-direction={message.direction}
            /*
              ★ THE TYPE WE COULD ACCOUNT FOR, OR NOTHING.
              `messageType` is an unconstrained String — the observed values
              are whatever writers have written. `renderableType` returns
              null for anything unrecognised, and a null attribute is better
              than a wrong one: a styling hook that said "system" for the
              next type somebody adds would mislabel it silently.
            */
            {...(type ? { 'data-type': type } : {})}
          >
            {/*
              ★★ A REPLY WHOSE QUOTE WE NEVER STORED IS STILL A REPLY.
              `replyToMessageId` can fail to resolve — the quoted message may
              predate GOTCHA or have been deleted — while
              `replyToExternalId` is the provider's and survives. Showing
              nothing would lose the fact that the customer was answering
              something, which is often what makes the message legible.
            */}
            {quoted === 'unresolved' ? (
              <p className={styles.quoted} data-testid={`quoted-missing-${message.id}`}>
                {t('stream.quotedMissing')}
              </p>
            ) : null}

            {type === 'audio' ? (
              /*
                ★★ WE CANNOT READ IT OUT, AND THE DESIGN SAYS WE CAN.
                An inbound voice note is stored as a file. The only
                audio-specific code in the worker is a filename extension,
                and the Deepgram credential exists without a client — "we
                have the key" reads like "we have the feature".

                So the stream says what it is and what it cannot do, rather
                than rendering a player beside an absent transcript and
                letting the agent conclude the transcript failed.
              */
              <p className={styles.mediaNote} data-testid={`voice-${message.id}`}>
                {hasTranscript(message) ? '' : t('stream.voiceNoTranscript')}
              </p>
            ) : null}

            {type === 'image' || type === 'video' || type === 'document' ? (
              <p className={styles.mediaNote} data-testid={`media-${message.id}`}>
                {t(`stream.media.${type}` as 'stream.media.image')}
              </p>
            ) : null}

            {/*
              ════════════════════════════════════════════════════════════════
              ★★ "NOTHING TO SHOW" IS ABOUT WHAT WE RENDERED, NOT ABOUT THE
                 TYPE BEING UNRECOGNISED
              ════════════════════════════════════════════════════════════════
              The first version keyed this on `type === null`, and a test
              caught the hole: `location` is in `KNOWN_MESSAGE_TYPES` and has
              no branch above, so a location with no body rendered as a
              timestamp in an empty bubble. Recognised and unhandled is a
              third case, and it looked like the handled one.

              So the fallback asks what actually got drawn. Every type with
              no body and no branch — location, template, interactive,
              system, and whatever is added next — lands here and says so.
            */}
            {message.body.trim() !== '' ? (
              <p className={styles.body}>{message.body}</p>
            ) : !rendered ? (
              <p className={styles.mediaNote} data-testid={`unknown-${message.id}`}>
                {t('stream.unknownType')}
              </p>
            ) : null}

            <p className={styles.meta}>
              <time dateTime={message.createdAt}>
                {format.dateTime(new Date(message.createdAt), { timeStyle: 'short' })}
              </time>
              {/*
                ★ THE CUSTOMER READ IT. Labelled as theirs, because the same
                word means the agent's queue elsewhere in this product and
                collapsing them would empty a queue as customers open their
                phones.
              */}
              {message.direction === 'OUTBOUND' && message.readAt ? (
                <span data-testid={`read-${message.id}`}>{t('stream.customerRead')}</span>
              ) : message.direction === 'OUTBOUND' && message.deliveredAt ? (
                <span data-testid={`delivered-${message.id}`}>{t('stream.delivered')}</span>
              ) : null}
            </p>
          </li>
        );
      })}
    </ol>
  );
}
