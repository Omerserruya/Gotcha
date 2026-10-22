'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { useRouter } from '@/i18n/navigation';

import styles from './Notifications.module.css';
import { savePreferenceSwitch, type PreferenceSwitchKey } from './preference-actions';

/**
 * A switch the platform really has - a channel for everything, or approvals.
 * It shows the change at once, saves it, and the page reads again so every
 * cell below says the stored state; a refusal puts it back and says so.
 */
export function PreferenceSwitch({
  field,
  on,
  label,
}: {
  readonly field: PreferenceSwitchKey;
  readonly on: boolean;
  /** What it switches, for the reader ("Email, for everything below"). */
  readonly label: string;
}) {
  const t = useTranslations('notifications-settings.matrix');
  const router = useRouter();
  const [shown, setShown] = useState(on);
  const [problem, setProblem] = useState<'forbidden' | 'failed' | null>(null);
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
        data-testid={`pref-switch-${field}`}
        onClick={() => {
          const next = !shown;
          setShown(next);
          setProblem(null);
          startTransition(async () => {
            const done = await savePreferenceSwitch(field, next);
            if (done.ok) {
              setShown(done.preferences[field]);
              router.refresh();
            } else {
              setShown(!next);
              setProblem(done.reason);
            }
          });
        }}
      />
      {problem ? (
        <span
          className={styles.switchProblem}
          role="alert"
          data-testid={`pref-switch-${field}-problem`}
        >
          {t(`saveProblem.${problem}`)}
        </span>
      ) : null}
    </span>
  );
}
