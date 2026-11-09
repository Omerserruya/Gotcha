import { CheckCheck, Inbox } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';

import {
  channelName,
  type ConversationRow,
  UNREAD_BADGE_MAX,
  unreadMark,
} from '@/api/contracts/inbox';
import { ChannelPlate } from '@/design-system/brand/channel-plate';
import { UserText } from '@/design-system/primitives/text/UserText';
import { PersonName } from '@/features/customers/PersonName';
import { initials } from '@/features/inbox/initials';
import { quoteOf } from '@/features/inbox/media';
import { Link } from '@/i18n/navigation';
import { listTime } from '@/lib/list-time';

import ui from '../mobile-ui.module.css';
import styles from './mobile-inbox.module.css';
import { rowOwner } from './row-owner';

/**
 * The conversations, as `GOTCHA Mobile App.dc.html` lists them: the person on
 * their channel, the time, the last thing said, how much is unread, and who
 * has it - one tap to open.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THE DESKTOP ROW'S FACTS, FROM THE DESKTOP ROW'S HELPERS
 * ════════════════════════════════════════════════════════════════════════════
 * Name, channel plate, `listTime`, `quoteOf` and `unreadMark` are the queue's
 * own (`ConversationList`), so the phone and the website say one thing about
 * one conversation. What is left out is what a phone has no room or no tap
 * for: the row menu, SLA tags, the department. They stay on the website.
 */
export async function MobileConversationList({
  rows,
  now,
  meId,
  colleagues,
  filtered,
}: {
  /** `null` is a failed read, not an empty inbox. */
  readonly rows: readonly ConversationRow[] | null;
  readonly now: Date;
  readonly meId: string | null;
  readonly colleagues: readonly { readonly id: string; readonly name: string }[];
  /** A search or a channel is narrowing the list: an empty one says so. */
  readonly filtered: boolean;
}) {
  const t = await getTranslations('mobile');
  const inbox = await getTranslations('inbox');
  const channelNames = await getTranslations('channels');
  const format = await getFormatter();

  if (rows === null) {
    return (
      <p className={ui.empty} role="status" data-testid="mobile-inbox-unavailable">
        {t('inbox.unavailable')}
      </p>
    );
  }
  if (rows.length === 0) {
    return (
      <p className={ui.empty} data-testid="mobile-inbox-empty">
        <Inbox aria-hidden size={30} strokeWidth={2} />
        {filtered ? t('inbox.noMatch') : t('inbox.empty')}
      </p>
    );
  }

  return (
    <ul className={styles.list} data-testid="mobile-inbox-list">
      {rows.map((row) => {
        const mark = unreadMark(row);
        const said = quoteOf({ body: row.lastMessageBody ?? '', messageType: row.lastMessageType });
        const channel = channelName(row.channel, channelNames) ?? inbox('queue.unknownChannel');
        const owner = rowOwner(row, meId, colleagues);
        return (
          <li key={row.id}>
            <Link
              href={`/m/inbox/${row.id}` as '/m/inbox'}
              className={`${ui.row} ${styles.row}`}
              data-unread={mark === null ? undefined : ''}
              data-testid={`mobile-row-${row.id}`}
            >
              <span className={styles.avatarStack} title={channel}>
                <span
                  className={styles.avatar}
                  data-settled={row.status === 'CLOSED' ? '' : undefined}
                  aria-hidden="true"
                >
                  {initials(row.customerName)}
                </span>
                <span className={styles.channelBadge}>
                  <ChannelPlate channel={row.channel} label={channel} size="xs" />
                </span>
              </span>

              <span className={styles.body}>
                <span className={styles.top}>
                  <span className={styles.who}>
                    {row.customerName === null ? (
                      inbox('queue.unnamed')
                    ) : (
                      <PersonName name={row.customerName} />
                    )}
                  </span>
                  {row.lastMessageAt === null ? null : (
                    <span className={styles.time}>
                      {listTime(row.lastMessageAt, now, format, (days) =>
                        inbox('queue.daysAgo', { days }),
                      )}
                    </span>
                  )}
                </span>
                <span className={styles.bottom}>
                  {/* The last word was ours: the double tick, as a chat list marks a reply. */}
                  {row.lastMessageDirection === 'OUTBOUND' ? (
                    <CheckCheck aria-hidden size={16} strokeWidth={2} className={styles.tick} />
                  ) : null}
                  <span
                    className={styles.preview}
                    data-kind={said !== null && 'kind' in said ? said.kind : undefined}
                  >
                    {said === null ? null : 'text' in said ? (
                      <UserText>{said.text}</UserText>
                    ) : (
                      inbox(`stream.quote.kind.${said.kind}`)
                    )}
                  </span>
                  {mark === null ? null : mark.kind === 'count' ? (
                    <span className={styles.badge}>
                      {/* "99+" is a number: kept left-to-right, or Hebrew draws "+99". */}
                      <span aria-hidden="true" dir="ltr">
                        {mark.count > UNREAD_BADGE_MAX ? `${UNREAD_BADGE_MAX}+` : mark.count}
                      </span>
                      <span className="srOnly">
                        {inbox('queue.unreadMessages', { count: mark.count })}
                      </span>
                    </span>
                  ) : (
                    <span className={styles.dot}>
                      <span className="srOnly">{inbox('queue.unread')}</span>
                    </span>
                  )}
                </span>
                {owner === null ? null : (
                  <span className={ui.tags}>
                    <span className={ui.tag} data-tone={owner.tone}>
                      {owner.kind === 'colleague' ? (
                        <PersonName name={owner.name} />
                      ) : (
                        t(`inbox.owner.${owner.kind}`)
                      )}
                    </span>
                  </span>
                )}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
