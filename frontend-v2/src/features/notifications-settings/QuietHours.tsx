'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { useRouter } from '@/i18n/navigation';
import { announcePreferencesChanged } from '@/lib/inbound-alerts/settings';

import styles from './Notifications.module.css';
import { saveQuietHours, type QuietHoursSave } from './preference-actions';

type Window = { readonly from: string; readonly to: string };

/**
 * 15's quiet hours, edited in place: one window, every day (the card's own
 * line). From and to in 24-hour time; a window may run past midnight. Off
 * clears it. Saved to the person's own preferences, then read again.
 */
export function QuietHours({ initial }: { readonly initial: Window | null }) {
  const t = useTranslations('notifications-settings.matrix.quiet');
  const router = useRouter();
  const [stored, setStored] = useState(initial);
  const [editing, setEditing] = useState<Window | null>(null);
  const [problem, setProblem] = useState<Exclude<QuietHoursSave, { ok: true }>['reason'] | null>(
    null,
  );
  const [isPending, startTransition] = useTransition();

  const save = (window: Window | null) =>
    startTransition(async () => {
      setProblem(null);
      const done = await saveQuietHours(window);
      if (!done.ok) {
        setProblem(done.reason);
        return;
      }
      setStored(done.preferences.quietHours);
      setEditing(null);
      // Every open tab's chime and desktop notification keep to the new window.
      announcePreferencesChanged();
      router.refresh();
    });

  if (editing) {
    // Not a window until both ends are set, and they differ.
    const same = editing.from !== '' && editing.from === editing.to;
    const ready = editing.from !== '' && editing.to !== '' && !same;
    return (
      <form
        className={styles.quietForm}
        data-testid="pref-quiet-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) save(editing);
        }}
      >
        <span className={styles.quietFields}>
          <label className={styles.quietField}>
            <span>{t('from')}</span>
            <input
              type="time"
              step={60}
              required
              value={editing.from}
              onChange={(e) => setEditing({ ...editing, from: e.target.value })}
              data-testid="pref-quiet-from"
            />
          </label>
          <label className={styles.quietField}>
            <span>{t('to')}</span>
            <input
              type="time"
              step={60}
              required
              value={editing.to}
              onChange={(e) => setEditing({ ...editing, to: e.target.value })}
              data-testid="pref-quiet-to"
            />
          </label>
        </span>
        {same ? (
          <span className={styles.switchProblem} role="alert" data-testid="pref-quiet-same">
            {t('same')}
          </span>
        ) : problem ? (
          <span className={styles.switchProblem} role="alert" data-testid="pref-quiet-problem">
            {t(`problem.${problem}`)}
          </span>
        ) : null}
        <span className={styles.quietActions}>
          <button
            type="submit"
            className={styles.quietPrimary}
            disabled={isPending || !ready}
            data-testid="pref-quiet-save"
          >
            {isPending ? t('saving') : t('save')}
          </button>
          <button
            type="button"
            className={styles.quietSecondary}
            onClick={() => {
              setProblem(null);
              setEditing(null);
            }}
          >
            {t('cancel')}
          </button>
        </span>
      </form>
    );
  }

  return (
    <>
      <p className={styles.prefValue} data-testid="pref-quiet-value">
        {stored ? t('window', stored) : t('none')}
      </p>
      <span className={styles.quietActions}>
        <button
          type="button"
          className={styles.quietSecondary}
          // The stored window to change, or nothing - never a window it invented.
          onClick={() => setEditing(stored ?? { from: '', to: '' })}
          data-testid="pref-quiet-edit"
        >
          {stored ? t('change') : t('set')}
        </button>
        {stored ? (
          <button
            type="button"
            className={styles.quietSecondary}
            disabled={isPending}
            onClick={() => save(null)}
            data-testid="pref-quiet-off"
          >
            {t('off')}
          </button>
        ) : null}
      </span>
      {problem ? (
        <span className={styles.switchProblem} role="alert" data-testid="pref-quiet-problem">
          {t(`problem.${problem}`)}
        </span>
      ) : null}
    </>
  );
}
