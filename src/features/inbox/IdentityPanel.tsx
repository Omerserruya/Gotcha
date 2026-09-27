import { getTranslations } from 'next-intl/server';

import { channelHandles, type CustomerTimeline } from '@/api/contracts/customer-detail';
import { channelLabelKey } from '@/api/contracts/inbox';
import type { ChannelHandle } from '@/api/contracts/customer-detail';

import styles from './Inbox.module.css';

/**
 * Screen 02's identity panel — who this is, across channels.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ "CHANNELS WE'VE JOINED UP", NOT "HER CHANNELS"
 * ════════════════════════════════════════════════════════════════════════════
 * The handles come from `contact.metadata.aliases`, which holds channels
 * **merged INTO this contact** by a prior merge. The route separately
 * computes `findSiblingContacts` — people currently linked by `personId` —
 * and does not return them.
 *
 * So somebody unified but never merged has handles this panel cannot see,
 * and calling the list "her channels" would claim completeness we do not
 * have. The heading says what the list is instead.
 *
 * That is the same distinction screen 04's list makes about the unifier: a
 * shared phone joins two entries, and an Instagram handle with no phone
 * stands alone. **A distinction that appears independently on a second
 * screen is a property of the domain rather than a local scruple**, which is
 * why it is phrased the same way in both places.
 *
 * ── IF BACKEND RETURNS THE SIBLINGS ──
 * The list widens and the caption changes with it. It is deliberately not
 * renamed in advance of data we do not have.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ AND IN THE INBOX THERE IS NO JOIN TO SHOW AT ALL
 * ════════════════════════════════════════════════════════════════════════════
 * `Conversation` has **no `contactId`.** It carries `customerExternalId` and
 * `channel` — one handle, the one this conversation arrived on. The identity
 * reads are keyed on a contact id, and `resolveContactByChannelId` exists as
 * a shared function used by two services but **is not routed as a GET**.
 *
 * So from a conversation we can show the handle in front of us and nothing
 * else. That is a materially weaker panel than the customer page's, and the
 * caption says which one the reader is looking at rather than letting a list
 * of one imply that one is all there is.
 *
 * The Backend item is small and specific: a read that resolves
 * `(channel, externalId)` to a contact id. The function is written; it has
 * no route.
 */
export async function IdentityPanel({
  timeline,
  conversation,
}: {
  /**
   * The joined-up identity, when a contact id was available to read it with.
   * `null` when the read failed OR when there was no contact id to try —
   * the Inbox case, which `conversation` then covers.
   */
  readonly timeline: CustomerTimeline | null;
  /**
   * The one handle this conversation arrived on. Used when no timeline is
   * available, which in the Inbox is always.
   */
  readonly conversation?: {
    readonly contactName: string | null;
    readonly channel: string | null;
    readonly customerExternalId?: string | null;
  } | null;
}) {
  const t = await getTranslations('inbox');
  const channelNames = await getTranslations('channels');

  if (timeline === null && !conversation) {
    return (
      <aside className={styles.identity} data-testid="identity-unavailable">
        <p className={styles.note}>{t('identity.unavailable')}</p>
      </aside>
    );
  }

  /*
   * ★ TWO SOURCES, AND THE CAPTION SAYS WHICH ONE.
   * A timeline gives the joined-up list; a conversation gives the single
   * handle it arrived on. A list of one from the second source would imply
   * this person uses one channel, which we do not know.
   */
  const joined = timeline !== null;
  const handles: readonly ChannelHandle[] = joined
    ? channelHandles(timeline)
    : conversation?.channel && conversation.customerExternalId
      ? [{ channel: conversation.channel, externalId: conversation.customerExternalId }]
      : [];
  const name = (joined ? timeline?.contact?.displayName : conversation?.contactName)?.trim();

  return (
    <aside className={styles.identity} data-testid="identity-panel">
      <h2 className={styles.identityName} data-testid="identity-name">
        {name || t('identity.unnamed')}
      </h2>

      {handles.length === 0 ? (
        /*
         * A contact with no channel and no aliases. Not an error — a record
         * created without a handle is an ordinary state — but the panel says
         * so rather than rendering an empty list somebody reads as a loading
         * failure.
         */
        <p className={styles.note} data-testid="identity-no-handles">
          {t('identity.noHandles')}
        </p>
      ) : (
        <>
          <p className={styles.note} data-testid="identity-caption">
            {joined ? t('identity.joinedUp') : t('identity.thisChannelOnly')}
          </p>
          <ul className={styles.handles}>
            {handles.map((handle) => (
              <li
                key={`${handle.channel}-${handle.externalId}`}
                className={styles.handle}
                data-testid={`handle-${handle.channel}`}
              >
                {/*
                  ════════════════════════════════════════════════════════════
                  ★★ THE SIBLING RENDERER. THIS IS THE SAME DEFECT AS THE HOME
                     QUEUE ROW, IN THE COMPONENT NOBODY PHOTOGRAPHED.
                  ════════════════════════════════════════════════════════════
                  It read `WHATSAPP`. The queue row and the metric strip were
                  fixed in Wave 1 because a browser walk photographed Home; the
                  walk reached this panel later, and by then the report had
                  already been organised by screen and so had the repair.

                  **Every value with two renderers had one fixed.** Three of
                  three, in one batch. The lesson is not "sweep harder": it is
                  that a fix organised by where a defect was SEEN inherits the
                  blind spots of the thing that saw it.
                */}
                <span className={styles.handleChannel}>
                  {channelLabelKey(handle.channel)
                    ? channelNames(`name.${handle.channel}` as 'name.WHATSAPP')
                    : channelNames('name.other')}
                </span>
                {/*
                  The raw identifier — a phone number or an email — is what
                  makes two handles tellable apart, which is the panel's
                  whole job. It is the same identifier already on screen 04's
                  rows, so this is not new exposure.
                */}
                <span className={styles.handleId}>{handle.externalId}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </aside>
  );
}
