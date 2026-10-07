import type { ReactNode } from 'react';

import { channelMark } from '@/features/inbox/channel-marks';
import { Link } from '@/i18n/navigation';

import styles from './WhoAnswers.module.css';

/** `whoAnswers`'s link: Studio · Automations, where it is decided. */
export const automationsLink = (chunks: ReactNode) => (
  <Link href="/studio/automations">{chunks}</Link>
);

/** One channel this employee answers on, in the caller's words. */
export interface ReachItem {
  readonly channel: string;
  /** The channel's name ("WhatsApp"). */
  readonly name: string;
  /** "Always" / "Sometimes (by the playbook)". */
  readonly when: string;
}

/**
 * Where an employee answers - the PLAYBOOK's to say, never a field on the
 * employee (`AIAgent.channels` is gone; Backend f79f1e6c): per channel,
 * always (the single path reaches it) or sometimes (behind a branch), with
 * the way to where it is decided.
 *
 * Without the read (`reach` null - it failed, or the service predates it),
 * the line that says where it is decided, as before: never "nothing reaches
 * it", which a failed read cannot know.
 *
 * The words are the caller's, so a server and a client component render it
 * alike (a server test has no client intl).
 */
export function WhoAnswers({
  text,
  reach = null,
  where,
  nowhere,
  className,
}: {
  /** The line without the read: "Who it answers is set in Studio · Automations…". */
  readonly text: ReactNode;
  readonly reach?: readonly ReachItem[] | null;
  /** Under the list: where it is decided, with the link. */
  readonly where?: ReactNode;
  /** The playbook routes no channel to it today. */
  readonly nowhere?: ReactNode;
  readonly className?: string;
}) {
  if (reach === null) {
    return (
      <p className={className} data-testid="who-answers">
        {text}
      </p>
    );
  }
  return (
    <div className={styles.reach} data-testid="who-answers">
      {reach.length === 0 ? (
        <p className={className} data-testid="who-answers-nowhere">
          {nowhere}
        </p>
      ) : (
        <ul className={styles.list} data-testid="who-answers-channels">
          {reach.map((item) => {
            const { Icon, tone } = channelMark(item.channel);
            return (
              <li key={item.channel} className={styles.item} data-testid={`reach-${item.channel}`}>
                <span className={styles.mark} data-tone={tone} aria-hidden="true">
                  <Icon size={12} strokeWidth={1.9} />
                </span>
                <span className={styles.name}>{item.name}</span>
                <span className={styles.when}>{item.when}</span>
              </li>
            );
          })}
        </ul>
      )}
      <p className={`${styles.where} ${className ?? ''}`.trim()}>{where}</p>
    </div>
  );
}
