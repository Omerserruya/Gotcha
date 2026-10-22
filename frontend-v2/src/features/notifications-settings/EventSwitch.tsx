'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import type { EventChannel } from '@/api/contracts/notifications';
import { useRouter } from '@/i18n/navigation';

import styles from './Notifications.module.css';
import { saveEventChannel } from './preference-actions';

/**
 * One event on one channel, for this person - a real switch, because the
 * platform keeps it (notifications 63307535). Shows the change at once, saves
 * it, and the page reads again; a refusal puts it back and says why.
 */
export function EventSwitch({
  eventType,
  channel,
  on,
  label,
  testid,
}: {
  readonly eventType: string;
  readonly channel: EventChannel;
  readonly on: boolean;
  /** "Email - An approval is waiting", for the reader. */
  readonly label: string;
  readonly testid: string;
}) {
  const t = useTranslations('notifications-settings.matrix');
  const router = useRouter();
  const [shown, setShown] = useState(on);
  const [problem, setProblem] = useState<'forbidden' | 'unknown' | 'failed' | null>(null);
  const [isPending, startTransition] = useTransition();

  return (
    <span className={styles.switchWrap}>
      <button
        type="button"
        role="switch"
        aria-checked={shown}
        aria-label={label}
        className={styles.switch}
        data-on={shown ? 'yes' : 'no'}
        disabled={isPending}
        data-testid={testid}
        onClick={() => {
          const next = !shown;
          setShown(next);
          setProblem(null);
          startTransition(async () => {
            const done = await saveEventChannel(eventType, channel, next);
            if (done.ok) {
              router.refresh();
            } else {
              setShown(!next);
              setProblem(done.reason);
            }
          });
        }}
      />
      {problem ? (
        <span className={styles.switchProblem} role="alert" data-testid={`${testid}-problem`}>
          {t(`saveProblem.${problem}`)}
        </span>
      ) : null}
    </span>
  );
}
