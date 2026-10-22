'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { IDLE_DELAY_MAX_MINUTES, type IdleAutomation } from '@/api/contracts/idle-automation';
import drawer from '@/design-system/styles/drawer.module.css';
import { Link } from '@/i18n/navigation';
import { wholeUnit, type DurationUnit } from '@/lib/duration';

import { saveIdleAutomation } from './idle-actions';
import { delayWords } from './IdleRow';
import styles from './Workspace.module.css';

const UNITS: readonly DurationUnit[] = ['minutes', 'hours', 'days'];
const IN_MINUTES: Readonly<Record<DurationUnit, number>> = { minutes: 1, hours: 60, days: 1440 };

/** A delay as the drawer edits it: a count and a unit. */
interface Delay {
  readonly count: string;
  readonly unit: DurationUnit;
}

const delayOf = (minutes: number | null, fallback: number): Delay => {
  const { unit, count } = wholeUnit((minutes ?? fallback) * 60_000);
  return { count: String(count), unit };
};

/** Minutes, or `null` when the entry is not a whole number within the PUT's seven days. */
export function minutesOf(delay: Delay): number | null {
  if (!/^\d+$/.test(delay.count.trim())) return null;
  const minutes = Number(delay.count.trim()) * IN_MINUTES[delay.unit];
  return minutes >= 1 && minutes <= IDLE_DELAY_MAX_MINUTES ? minutes : null;
}

/**
 * Follow-up and auto-close (S3, Omer 2026-10-13: "Hi, we didn't hear back…"
 * after a while, and closing after a while - both optional).
 *
 * It says what the platform does, because nothing else on the screen will:
 * only conversations a person holds, whose last message is ours; the close
 * counts from our last message, which a sent reminder becomes; and on
 * WhatsApp past 24 hours the reminder is not sent and the close goes without
 * its message (Backend, B8).
 */
export function IdleDrawer({ settings }: { readonly settings: IdleAutomation }) {
  const t = useTranslations('workspace');
  const [remind, setRemind] = useState(settings.reminderEnabled);
  const [remindAfter, setRemindAfter] = useState(() => delayOf(settings.reminderDelayMinutes, 60));
  const [remindText, setRemindText] = useState(settings.reminderMessage ?? '');
  const [close, setClose] = useState(settings.autoCloseEnabled);
  const [closeAfter, setCloseAfter] = useState(() => delayOf(settings.autoCloseDelayMinutes, 1440));
  const [closeText, setCloseText] = useState(settings.autoCloseMessage ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isPending, startTransition] = useTransition();

  const remindMinutes = minutesOf(remindAfter);
  const closeMinutes = minutesOf(closeAfter);
  const remindTextMissing = remind && remindText.trim() === '';

  function save() {
    setProblem(null);
    setSaved(false);
    if (remindMinutes === null || closeMinutes === null || remindTextMissing) {
      setProblem(t('idleDrawer.fix'));
      return;
    }
    startTransition(async () => {
      const result = await saveIdleAutomation({
        reminderEnabled: remind,
        reminderDelayMinutes: remindMinutes,
        reminderMessage: remindText,
        autoCloseEnabled: close,
        autoCloseDelayMinutes: closeMinutes,
        autoCloseMessage: closeText,
      });
      if (result.ok) setSaved(true);
      else setProblem(t(`idleDrawer.problem.${result.reason}`));
    });
  }

  const delayField = (
    id: 'reminder' | 'close',
    value: Delay,
    set: (next: Delay) => void,
    bad: boolean,
  ) => (
    <div className={drawer.field}>
      <span className={drawer.fieldLabel}>{t(`idleDrawer.${id}After`)}</span>
      <span className={drawer.pair}>
        <input
          className={drawer.box}
          inputMode="numeric"
          value={value.count}
          aria-label={t(`idleDrawer.${id}After`)}
          aria-invalid={bad}
          data-testid={`idle-${id}-count`}
          onChange={(e) => set({ ...value, count: e.target.value })}
        />
        <select
          className={drawer.box}
          value={value.unit}
          aria-label={t('idleDrawer.unit')}
          data-testid={`idle-${id}-unit`}
          onChange={(e) => set({ ...value, unit: e.target.value as DurationUnit })}
        >
          {UNITS.map((unit) => (
            <option key={unit} value={unit}>
              {t(`idleDrawer.units.${unit}`)}
            </option>
          ))}
        </select>
      </span>
      {bad ? (
        <span className={styles.rowNote} data-testid={`idle-${id}-problem`}>
          {t('idleDrawer.invalidDelay')}
        </span>
      ) : null}
    </div>
  );

  return (
    <>
      <div className={drawer.drawerBody} data-testid="idle-drawer">
        <p className={drawer.hint} data-testid="idle-who">
          {t('idleDrawer.who')}
        </p>

        <h3 className={drawer.sectionTitle}>{t('idleDrawer.reminderTitle')}</h3>
        <label className={styles.weekUse}>
          <input
            type="checkbox"
            className="srOnly"
            checked={remind}
            data-testid="idle-reminder-enabled"
            onChange={(e) => setRemind(e.target.checked)}
          />
          <span className={styles.weekPill} aria-hidden="true" />
          {t('idleDrawer.reminderEnabled')}
        </label>
        {delayField('reminder', remindAfter, setRemindAfter, remindMinutes === null)}
        <label className={drawer.field}>
          <span className={drawer.fieldLabel}>{t('idleDrawer.reminderMessage')}</span>
          <textarea
            className={drawer.box}
            rows={3}
            maxLength={1000}
            value={remindText}
            aria-invalid={remindTextMissing}
            data-testid="idle-reminder-message"
            onChange={(e) => setRemindText(e.target.value)}
          />
          {remindTextMissing ? (
            <span className={styles.rowNote} data-testid="idle-reminder-message-problem">
              {t('idleDrawer.reminderMessageRequired')}
            </span>
          ) : null}
        </label>
        <p className={drawer.hint} data-testid="idle-whatsapp-reminder">
          {t('idleDrawer.whatsappReminder')}
        </p>

        <h3 className={drawer.sectionTitle}>{t('idleDrawer.closeTitle')}</h3>
        <label className={styles.weekUse}>
          <input
            type="checkbox"
            className="srOnly"
            checked={close}
            data-testid="idle-close-enabled"
            onChange={(e) => setClose(e.target.checked)}
          />
          <span className={styles.weekPill} aria-hidden="true" />
          {t('idleDrawer.closeEnabled')}
        </label>
        {delayField('close', closeAfter, setCloseAfter, closeMinutes === null)}
        <label className={drawer.field}>
          <span className={drawer.fieldLabel}>{t('idleDrawer.closeMessage')}</span>
          <textarea
            className={drawer.box}
            rows={3}
            maxLength={1000}
            value={closeText}
            data-testid="idle-close-message"
            onChange={(e) => setCloseText(e.target.value)}
          />
          <span className={drawer.hint}>{t('idleDrawer.closeMessageHint')}</span>
        </label>
        <p className={drawer.hint} data-testid="idle-close-timing">
          {remind && close && remindMinutes !== null && closeMinutes !== null
            ? t('idleDrawer.closeTimingAfterReminder', {
                reminder: delayWords(remindMinutes, t),
                close: delayWords(closeMinutes, t),
              })
            : t('idleDrawer.closeTiming')}
        </p>
      </div>
      <footer className={drawer.drawerFoot}>
        <button
          type="button"
          className={styles.saveButton}
          data-testid="drawer-save-idle"
          disabled={isPending}
          onClick={save}
        >
          {isPending ? t('saving') : t('save')}
        </button>
        <Link href="/settings/workspace" className={drawer.drawerCancel}>
          {t('cancel')}
        </Link>
        {problem ? (
          <span className={styles.rowNote} data-testid="idle-problem">
            {problem}
          </span>
        ) : saved ? (
          <span className={styles.rowNoteQuiet} data-testid="idle-saved">
            {t('saved')}
          </span>
        ) : null}
      </footer>
    </>
  );
}
