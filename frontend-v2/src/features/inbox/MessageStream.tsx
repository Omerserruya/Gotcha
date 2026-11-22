import { Check, CheckCheck, Clock } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';

import {
  quotedState,
  senderLabel,
  reactionOf,
  renderableType,
  resolveExternal,
  systemEventOf,
  unsupportedType,
  type InboxMessage,
  deliveryOf,
  escalationReasonOf,
  type SystemEvent,
} from '@/api/contracts/inbox';

import styles from './Inbox.module.css';
import { ContactCards, LocationCard, MessageMedia, ProductCards } from './MessageMedia';
import { isLocationMessage, isPlaceholderCaption, mediaKind, quoteOf } from './media';
import { ReplyButton } from './ReplyButton';
import { STREAM_SCROLLER } from './stream-scroller';
import { sendFailure } from './send-failure';
import { streamUndelivered } from './undelivered';
import { plainDashes } from '@/lib/plain-dashes';
import { UserText } from '@/design-system/primitives/text/UserText';

/**
 * Screen 02's message stream.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * FOUR THINGS THE DESIGN PUTS HERE THAT ARE NOT DRAWN
 * ════════════════════════════════════════════════════════════════════════════
 *   "GOTCHA saw damage in this photo"   no vision path exists anywhere
 *   "Read what she said" on a voice note  nothing transcribes audio - see below
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
  variant,
}: {
  /** `null` when the read failed. Never an empty conversation. */
  readonly messages: readonly InboxMessage[] | null;
  /** Drives nothing here yet; carried so the caller cannot forget it exists. */
  readonly channel: string | null;
  /** The phone app's look (`/m`); the same messages, drawn its way. */
  readonly variant?: 'phone';
}) {
  const t = await getTranslations('inbox');
  const format = await getFormatter();

  if (messages === null) {
    return (
      <div className={styles.stream} data-variant={variant} data-testid="stream-unavailable">
        <p className={styles.note}>{t('stream.unavailable')}</p>
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className={styles.stream} data-variant={variant} data-testid="stream-empty">
        <p className={styles.note}>{t('stream.empty')}</p>
      </div>
    );
  }

  /*
   * The phone's day chips ("Today", "Yesterday", a date) where the day turns,
   * as a chat draws them. The website's stream reads the time on each message.
   */
  const dayStarts = new Map<string, string>();
  if (variant === 'phone') {
    const dayOf = (at: Date) =>
      format.dateTime(at, { year: 'numeric', month: '2-digit', day: '2-digit' });
    const now = new Date();
    const today = dayOf(now);
    const yesterday = dayOf(new Date(now.getTime() - 86_400_000));
    let last: string | null = null;
    for (const message of messages) {
      const at = new Date(message.createdAt);
      if (Number.isNaN(at.getTime())) continue;
      const day = dayOf(at);
      if (day === last) continue;
      last = day;
      dayStarts.set(
        message.id,
        day === today
          ? t('stream.day.today')
          : day === yesterday
            ? t('stream.day.yesterday')
            : format.dateTime(at, { day: 'numeric', month: 'long' }),
      );
    }
  }

  /*
   * W1: a web chat that moved to WhatsApp reads as ONE thread - the web rows
   * (originChannel "WEBCHAT"), the divider, then WhatsApp. In such a thread
   * the divider says the move; an old linked pair keeps its own line.
   */
  const merged = messages.some((m) => m.originChannel === 'WEBCHAT');

  return (
    <ol
      className={styles.stream}
      data-variant={variant}
      data-testid="message-stream"
      data-channel={channel ?? 'unknown'}
      /* What `StreamPin` scrolls to the latest message. */
      {...{ [STREAM_SCROLLER]: '' }}
    >
      {messages.map((message) => [
        variant === 'phone' && dayStarts.has(message.id) ? (
          <li
            key={`day-${message.id}`}
            className={styles.dayChip}
            data-testid={`day-${message.id}`}
          >
            {dayStarts.get(message.id)}
          </li>
        ) : null,
        ((): ReactNode => {
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
           * below the stream - pressing "take control" writes one of these.
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
                  {systemDivider(t, message, systemEvent, merged)}
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
          is the literal string `[reaction message]` - which is what an agent
          reads today - and the emoji survives only on
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
          `[revoke message]`, `[edit message]`, `[unsupported message]` - an
          agent reading a bracketed token cannot tell whether it is the
          customer's words or ours. Naming the provider's own type is all we
          can honestly do: for every type but `reaction`, we do not know what
          happened.
        */
          const unsupported = unsupportedType(message);
          /* Meta's "unsupported": the reason in plain words, by its code; an album's part softly. */
          const undelivered = streamUndelivered(message, messages);
          /*
           * Did any branch above draw the message's content? Recognising a
           * type and rendering it are different things, and only the second
           * one means the agent can see what was sent.
           */
          const products = message.metadata?.commerce?.products.length ?? 0;
          const rendered =
            products > 0 ||
            mediaKind(message) !== null ||
            (message.metadata?.contacts?.length ?? 0) > 0 ||
            isLocationMessage(message);
          return (
            <li
              key={message.id}
              className={styles.message}
              data-testid={`message-${message.id}`}
              data-direction={message.direction}
              /*
              ★ THE TYPE WE COULD ACCOUNT FOR, OR NOTHING.
              `messageType` is an unconstrained String - the observed values
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
                {/* The phone names who answered at the top of the bubble, as the design does. */}
                {variant === 'phone' && senderLabel(message) !== null ? (
                  <span
                    className={styles.bubbleBy}
                    data-gotcha={senderLabel(message) === 'GOTCHA' ? '' : undefined}
                  >
                    {senderLabel(message)}
                  </span>
                ) : null}
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
                      {(() => {
                        // The adapter's filler ("[Image]") is not what they wrote: say what it was.
                        const quoted = quoteOf(message.replyTo);
                        return quoted === null ? (
                          t('stream.quote.noText')
                        ) : 'text' in quoted ? (
                          <UserText>{quoted.text}</UserText>
                        ) : (
                          t(`stream.quote.kind.${quoted.kind}`)
                        );
                      })()}
                    </span>
                  </div>
                ) : null}

                {/*
              ★★ A REPLY WHOSE QUOTE WE NEVER STORED IS STILL A REPLY.
              `replyToMessageId` can fail to resolve - the quoted message may
              predate GOTCHA or have been deleted - while
              `replyToExternalId` is the provider's and survives. Showing
              nothing would lose the fact that the customer was answering
              something, which is often what makes the message legible.
            */}
                {quoted === 'unresolved' ? (
                  <p className={styles.quoted} data-testid={`quoted-missing-${message.id}`}>
                    {t('stream.quotedMissing')}
                  </p>
                ) : null}

                {/*
                ★ The attachment itself, as 02 draws it - a photo to see, a voice
                note to play, a file to download - or, when it could not be
                fetched, a sentence saying so. (Was "A photo." in words.)
              */}
                <MessageMedia message={message} t={(key, values) => t(`stream.${key}`, values)} />
                <ContactCards message={message} t={(key) => t(`stream.${key}`)} />
                <LocationCard message={message} t={(key) => t(`stream.${key}`)} />
                <ProductCards
                  message={message}
                  t={(key) => t(`stream.${key}`)}
                  money={(amount, currency) => {
                    const n = Number(amount);
                    if (!Number.isFinite(n)) return amount;
                    if (!currency) return format.number(n, { maximumFractionDigits: 2 });
                    try {
                      return format.number(n, {
                        style: 'currency',
                        currency,
                        maximumFractionDigits: 2,
                      });
                    } catch {
                      return format.number(n, { maximumFractionDigits: 2 });
                    }
                  }}
                />

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
              no body and no branch - location, template, interactive,
              system, and whatever is added next - lands here and says so.
            */}
                {undelivered !== null ? (
                  <p className={styles.mediaNote} data-testid={`undelivered-${message.id}`}>
                    {t(`stream.undelivered.${undelivered}`)}
                  </p>
                ) : unsupported !== null ? (
                  <p className={styles.mediaNote} data-testid={`unsupported-${message.id}`}>
                    {t('stream.unsupported', { type: unsupported })}
                  </p>
                ) : products === 0 &&
                  message.body.trim() !== '' &&
                  !isPlaceholderCaption(message) ? (
                  /* With cards drawn, the body is their plain-text fallback: not said twice. */
                  /* Isolated: a customer writes in their language, not the page's. */
                  <p className={styles.body}>
                    {/* Our side's words (the AI's, mostly): plain hyphens. The customer's are theirs. */}
                    <UserText>
                      {message.direction === 'OUTBOUND' ? plainDashes(message.body) : message.body}
                    </UserText>
                  </p>
                ) : !rendered ? (
                  <p className={styles.mediaNote} data-testid={`unknown-${message.id}`}>
                    {t('stream.unknownType')}
                  </p>
                ) : null}
                {variant === 'phone' ? (
                  <PhoneStamp message={message} format={format} t={t} />
                ) : null}
              </div>

              {variant === 'phone' && deliveryOf(message) !== 'failed' ? null : (
                <p className={styles.meta}>
                  <time dateTime={message.createdAt}>
                    {format.dateTime(new Date(message.createdAt), {
                      hour: '2-digit',
                      minute: '2-digit',
                      /* 02 writes `09:12` in both languages; see the queue's time. */
                      hour12: false,
                    })}
                  </time>
                  {/* 02's middle slot - "Support AI" - when there is a name to put there. */}
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
                otherwise - so `PENDING` and `FAILED` were the same rendering:
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
                      return (
                        <span data-testid={`read-${message.id}`}>{t('stream.customerRead')}</span>
                      );
                    if (delivery === 'delivered')
                      return (
                        <span data-testid={`delivered-${message.id}`}>{t('stream.delivered')}</span>
                      );
                    if (delivery === 'failed')
                      return (
                        <span className={styles.streamFailed} data-testid={`failed-${message.id}`}>
                          {/*
                        ★ The window's two refusals are said in words (Backend
                          47e376a4): the reason is the 24 hours, not a fault.
                      */}
                          {/* And Meta's refusal of a file's format, by its code (`sendFailure`). */}
                          {t(`stream.${sendFailure(message)}`)}
                        </span>
                      );
                    if (delivery === 'sent')
                      return <span data-testid={`sent-${message.id}`}>{t('stream.sent')}</span>;
                    if (delivery === 'pending')
                      return (
                        <span data-testid={`pending-${message.id}`}>{t('stream.pending')}</span>
                      );
                    return (
                      <span data-testid={`delivery-unknown-${message.id}`}>
                        {t('stream.deliveryUnknown')}
                      </span>
                    );
                  })()}
                </p>
              )}

              {/*
              ★ 02's hover bar, with Reply - the one of its four actions with
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
                  preview: (() => {
                    const quoted = quoteOf(message);
                    return quoted === null
                      ? t('stream.quote.noText')
                      : 'text' in quoted
                        ? quoted.text.slice(0, 140)
                        : t(`stream.quote.kind.${quoted.kind}`);
                  })(),
                }}
                label={t('stream.reply')}
                description={t('stream.replyTo')}
              />
            </li>
          );
        })(),
      ])}
    </ol>
  );
}

/**
 * A system row's divider, in words.
 *
 * The AI's handover says why when the code is one we have words for
 * ("GOTCHA handed the conversation to the team: the daily AI budget ran
 * out"), and never prints the platform's English summary. A system row we
 * have no words for is "System update" (`stream.system.other`, through the
 * same key as every event) - never an empty customer bubble.
 */
function systemDivider(
  t: Awaited<ReturnType<typeof getTranslations<'inbox'>>>,
  message: InboxMessage,
  event: SystemEvent | 'other',
  merged = false,
): string {
  // The one divider of a merged web-to-WhatsApp thread (Backend W1).
  if (event === 'continued_from_website' && merged) return t('stream.system.moved_to_whatsapp');
  if (event === 'ai_bot_escalation') {
    const reason = escalationReasonOf(message);
    return reason
      ? t('stream.system.ai_bot_escalation_because', {
          reason: t(`stream.system.reason.${reason}`),
        })
      : t('stream.system.ai_bot_escalation');
  }
  return t(`stream.system.${event}` as 'stream.system.agent_claimed', {
    /*
     * Empty string rather than a placeholder name. The service writes
     * `agentName: updated.assignedAgent?.name || "Agent"` - so a missing name
     * already arrives as the word "Agent", and inventing a second fallback
     * here would hide which of the two happened. ICU needs the argument
     * present.
     */
    name: message.metadata?.agentName ?? '',
    from: message.metadata?.fromAgentName ?? '',
    to: message.metadata?.toAgentName ?? '',
  });
}

/**
 * The phone's time and delivery, inside the bubble at its end: `09:41` and a
 * tick - one for sent, two for delivered, two in colour once the customer read
 * it, a clock while it is on its way. A failure is not a tick: it is said in
 * words under the bubble, where the website says it.
 */
function PhoneStamp({
  message,
  format,
  t,
}: {
  readonly message: InboxMessage;
  readonly format: Awaited<ReturnType<typeof getFormatter>>;
  readonly t: Awaited<ReturnType<typeof getTranslations<'inbox'>>>;
}) {
  const delivery = message.direction === 'OUTBOUND' ? deliveryOf(message) : null;
  return (
    <span className={styles.bubbleStamp}>
      <time dateTime={message.createdAt}>
        {format.dateTime(new Date(message.createdAt), {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        })}
      </time>
      {delivery === 'read' ? (
        <span className={styles.bubbleTick} data-read="">
          <CheckCheck aria-hidden size={14} strokeWidth={2} />
          <span className="srOnly">{t('stream.customerRead')}</span>
        </span>
      ) : delivery === 'delivered' ? (
        <span className={styles.bubbleTick}>
          <CheckCheck aria-hidden size={14} strokeWidth={2} />
          <span className="srOnly">{t('stream.delivered')}</span>
        </span>
      ) : delivery === 'sent' ? (
        <span className={styles.bubbleTick}>
          <Check aria-hidden size={14} strokeWidth={2} />
          <span className="srOnly">{t('stream.sent')}</span>
        </span>
      ) : delivery === 'pending' ? (
        <span className={styles.bubbleTick}>
          <Clock aria-hidden size={12} strokeWidth={2} />
          <span className="srOnly">{t('stream.pending')}</span>
        </span>
      ) : null}
    </span>
  );
}
