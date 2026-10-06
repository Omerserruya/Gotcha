import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';

import {
  channelName,
  waitingMinutes,
  waitingScale,
  type ConversationRow,
} from '@/api/contracts/inbox';
import type { CommerceContextResponse } from '@/api/contracts/customer-orders';
import { UserText } from '@/design-system/primitives/text/UserText';

import { initials } from './initials';
import styles from './Inbox.module.css';
import { ltr } from '@/lib/bidi';

/**
 * How many orders this customer has, or `null` when we cannot say.
 *
 * ⚠ `orderCount` DEFAULTS TO 0 IN THE CONTRACT, so a 0 is indistinguishable
 *   from "not sent". Only a positive count from an `ok` read is a statement;
 *   anything else draws no chip rather than a confident "0 orders".
 */
export function orderCountOf(orders: CommerceContextResponse | null): number | null {
  if (orders?.state !== 'ok') return null;
  const count = (orders.data?.summary ?? orders.summary)?.orderCount ?? 0;
  return count > 0 ? count : null;
}

/**
 * Who this conversation is with - screen 02's header.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ 02's HEADER IS ONE ROW: AVATAR · NAME AND CHIP OVER A SUBLINE · VERBS
 * ════════════════════════════════════════════════════════════════════════════
 * Measured: `[856x67] flex, align-items:center, gap:14px, padding:16px 22px`
 * over a `#EDE9E1` hairline. A 34px initials disc, then the name at 15px/600
 * with a chip beside it, then an 11.5px subline. The verbs sit at the right
 * end of the same row; they are `ConversationVerbs`, a sibling in the page,
 * because this is an async server component and that is a client one.
 *
 * Every field was already loaded for the queue row beside it. Nothing new is
 * read except the order count, which the commerce panel already fetched.
 */
export async function ConversationHeader({
  conversation,
  now,
  chip = null,
}: {
  readonly conversation: ConversationRow;
  /** One `now` for the whole render - the capture runs at three viewports. */
  readonly now: Date;
  /**
   * 02's "Returning · 6 orders" chip - `OrdersChip`, inside a `<Suspense>`.
   *
   * ⚠ A slot rather than the order read: the read is the second round, and
   *   the header must paint before it returns. The chip arrives beside the
   *   name when the count is known.
   */
  readonly chip?: ReactNode;
}) {
  const t = await getTranslations('inbox');
  const channels = await getTranslations('channels');

  const minutes = waitingMinutes(conversation, now);
  const waiting = minutes === null ? null : waitingScale(minutes);

  return (
    <header className={styles.openHeader} data-testid="conversation-header">
      <span className={styles.openAvatar} aria-hidden="true">
        {initials(conversation.customerName)}
      </span>

      <div className={styles.openWho}>
        <div className={styles.openNameRow}>
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
               * No name is an ordinary state: a first message from a number
               * nobody has met. The handle below identifies them, so the
               * heading says there is no name instead of supplying a person.
               */
              <span className={styles.openUnnamed}>{t('open.noName')}</span>
            )}
          </h2>

          {/*
            ★★ 02's CHIP, FROM THE COUNT WE ALREADY HAD - see `OrdersChip`.
            "Returning" means more than one order (our definition); no chip
            for a count that is absent, zero or unreadable.
          */}
          {chip}
        </div>

        {/*
          02's subline: channel · handle · one more fact, on one line. Ours
          carries the status and how long they have waited.
        */}
        <p className={styles.openFacts} data-testid="conversation-facts">
          {[
            channelName(conversation.channel, channels),
            /*
             * The handle, which is what makes two unnamed people tellable
             * apart. Already on screen 04's rows, so this is not new exposure.
             */
            ltr(conversation.customerExternalId),
            t(`open.status.${conversation.status}` as 'open.status.OPEN'),
          ]
            .filter(Boolean)
            .join(' · ')}
          {/*
            ★★ HOW LONG THEY HAVE BEEN WAITING, AND "UNKNOWN" WHEN WE CANNOT
            SAY. `waitingMinutes` is `null` when `lastMessageAt` is absent - a
            denormalised cache maintained by convention. "0m" would sort it as
            the freshest thing on the screen and read as just-arrived.

            ⚠ The full reason was a sentence on its own line; the subline is
              one line, so it is the tooltip now and the line says the fact.
          */}
          {' · '}
          {waiting ? (
            <span data-testid="conversation-waiting" data-scale={waiting.scale}>
              {t(`queue.waitingFor.${waiting.scale}` as 'queue.waitingFor.minutes', {
                value: waiting.value,
              })}
            </span>
          ) : (
            <span data-testid="conversation-waiting-unknown" title={t('open.waitingUnknown')}>
              {t('open.waitingUnknownShort')}
            </span>
          )}
        </p>
      </div>
    </header>
  );
}
