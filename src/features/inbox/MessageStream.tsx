import { getFormatter, getTranslations } from 'next-intl/server';

import {
  hasTranscript,
  quotedState,
  senderLabel,
  reactionOf,
  renderableType,
  resolveExternal,
  systemEventOf,
  unsupportedType,
  type InboxMessage,
  deliveryOf,
} from '@/api/contracts/inbox';

import styles from './Inbox.module.css';
import { ReplyButton } from './ReplyButton';
import { STREAM_SCROLLER } from './stream-scroller';
import { UserText } from '@/design-system/primitives/text/UserText';

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
    <ol
      className={styles.stream}
      data-testid="message-stream"
      data-channel={channel ?? 'unknown'}
      /* What `StreamPin` scrolls to the latest message. */
      {...{ [STREAM_SCROLLER]: '' }}
    >
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

        /*
          ════════════════════════════════════════════════════════════════
          ★★ A REACTION IS NOT A MESSAGE, AND IT ARRIVES AS ONE
          ════════════════════════════════════════════════════════════════
          There is no reaction model in this platform. WhatsApp sends a type
          the adapter does not model, so it becomes a text message whose body
          is the literal string `[reaction message]` — which is what an agent
          reads today — and the emoji survives only on
          `metadata.unsupported.raw`.

          Drawn as its own thin line rather than attached to the target,
          because that is how it arrives: its own row, in order. Where the
          message it points at is on this page we say which one; where it is
          not, we say it was earlier, the same `resolved` / `unresolved`
          distinction as a quoted reply.

          Inbound only, and not by restraint: `whatsAppOutboundAdapter` has
          no reaction send, so there is nothing a picker could call.
        */
        const reaction = reactionOf(message);
        if (reaction) {
          const target = resolveExternal(reaction.toExternalId, messages);
          const preview = target ? target.body.trim().slice(0, 40) : '';
          return (
            <li
              key={message.id}
              className={styles.reaction}
              data-testid={`reaction-${message.id}`}
              data-kind={reaction.kind}
            >
              {reaction.kind === 'removed'
                ? t('stream.reaction.removed')
                : preview !== ''
                  ? t('stream.reaction.toMessage', { emoji: reaction.emoji, preview })
                  : t('stream.reaction.toEarlier', { emoji: reaction.emoji })}
            </li>
          );
        }

        const type = renderableType(message);
        const quoted = quotedState(message);
        /*
          ★ AND ANYTHING ELSE THE PROVIDER COULD NOT GIVE US PROPERLY.
          `[revoke message]`, `[edit message]`, `[unsupported message]` — an
          agent reading a bracketed token cannot tell whether it is the
          customer's words or ours. Naming the provider's own type is all we
          can honestly do: for every type but `reaction`, we do not know what
          happened.
        */
        const unsupported = unsupportedType(message);
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
              ★★ 02 DRAWS THE BUBBLE AND ITS TIME LINE AS TWO THINGS: the
              message in a card, and `09:12 · Support AI · read` underneath it
              in the open. The time was inside the bubble, so every message
              carried a footer 02 does not have.
            */}
            <div className={styles.bubble}>
              {/*
              ★★ THE QUOTE ITSELF, FROM THE REPLY. 02 draws who said it and a
              line of what they said, inside the bubble above the reply.
              `replyTo` travels with the message, so the quote shows whether
              or not the quoted message is on this page.
            */}
              {message.replyTo ? (
                <div className={styles.quote} data-testid={`quote-${message.id}`}>
                  <span className={styles.quoteWho}>
                    {message.replyTo.direction === 'INBOUND'
                      ? t('stream.quote.customer')
                      : (senderLabel(message.replyTo) ?? t('stream.quote.team'))}
                  </span>
                  <span className={styles.quoteText}>
                    {message.replyTo.body.trim() !== '' ? (
                      <UserText>{message.replyTo.body}</UserText>
                    ) : (
                      t('stream.quote.noText')
                    )}
                  </span>
                </div>
              ) : null}

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
              {unsupported !== null ? (
                <p className={styles.mediaNote} data-testid={`unsupported-${message.id}`}>
                  {t('stream.unsupported', { type: unsupported })}
                </p>
              ) : message.body.trim() !== '' ? (
                /* Isolated: a customer writes in their language, not the page's. */
                <p className={styles.body}>
                  <UserText>{message.body}</UserText>
                </p>
              ) : !rendered ? (
                <p className={styles.mediaNote} data-testid={`unknown-${message.id}`}>
                  {t('stream.unknownType')}
                </p>
              ) : null}
            </div>

            <p className={styles.meta}>
              <time dateTime={message.createdAt}>
                {format.dateTime(new Date(message.createdAt), {
                  hour: '2-digit',
                  minute: '2-digit',
                  /* 02 writes `09:12` in both languages; see the queue's time. */
                  hour12: false,
                })}
              </time>
              {/* 02's middle slot — "Support AI" — when there is a name to put there. */}
              {senderLabel(message) === null ? null : (
                <span data-testid={`sender-${message.id}`}>{senderLabel(message)}</span>
              )}
              {/*
                ★ THE CUSTOMER READ IT. Labelled as theirs, because the same
                word means the agent's queue elsewhere in this product and
                collapsing them would empty a queue as customers open their
                phones.
              */}
              {/*
                ══════════════════════════════════════════════════════════════
                ★★ A FAILED MESSAGE USED TO RENDER AS NOTHING AT ALL
                ══════════════════════════════════════════════════════════════
                This read `readAt` then `deliveredAt` and showed nothing
                otherwise — so `PENDING` and `FAILED` were the same rendering:
                silence. An outbound reply the customer never received looked
                exactly like one sent a second ago.

                `Message.status` was on the wire the whole time and our
                `z.object` stripped it. `deliveryOf` reads it together with both
                timestamps, and its order matters: **a failure is not undone by a
                timestamp recorded before the provider rejected it.**

                A status we do not recognise says so rather than falling through
                to silence. The safe default for "did this arrive" is no, and
                this is the one field where the reassuring default would tell
                somebody a customer has their answer.
              */}
              {(() => {
                const delivery = deliveryOf(message);
                if (delivery === null) return null;
                if (delivery === 'read')
                  return <span data-testid={`read-${message.id}`}>{t('stream.customerRead')}</span>;
                if (delivery === 'delivered')
                  return (
                    <span data-testid={`delivered-${message.id}`}>{t('stream.delivered')}</span>
                  );
                if (delivery === 'failed')
                  return (
                    <span className={styles.streamFailed} data-testid={`failed-${message.id}`}>
                      {t('stream.failed')}
                    </span>
                  );
                if (delivery === 'sent')
                  return <span data-testid={`sent-${message.id}`}>{t('stream.sent')}</span>;
                if (delivery === 'pending')
                  return <span data-testid={`pending-${message.id}`}>{t('stream.pending')}</span>;
                return (
                  <span data-testid={`delivery-unknown-${message.id}`}>
                    {t('stream.deliveryUnknown')}
                  </span>
                );
              })()}
            </p>

            {/*
              ★ 02's hover bar, with Reply — the one of its four actions with
                a backend. The target is described here, where the quote's
                words already are, so the composer can show what is being
                answered before anything is sent.
            */}
            <ReplyButton
              target={{
                id: message.id,
                who:
                  message.direction === 'INBOUND'
                    ? t('stream.quote.customer')
                    : (senderLabel(message) ?? t('stream.quote.team')),
                preview:
                  message.body.trim() !== ''
                    ? message.body.trim().slice(0, 140)
                    : t('stream.quote.noText'),
              }}
              label={t('stream.reply')}
              description={t('stream.replyTo')}
            />
          </li>
        );
      })}
    </ol>
  );
}
