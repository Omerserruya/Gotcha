'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { DAY_KEYS, type DayKey, type Workspace } from '@/api/contracts/workspace';
import { Link } from '@/i18n/navigation';
import drawer from '@/design-system/styles/drawer.module.css';

import { saveWorkspaceFacts } from './actions';
import { hoursPatch, weekOf, type DayHours } from './hours';
import styles from './Workspace.module.css';

/**
 * 11c, measured: the week as rows — day, a switch, opens – closes — then
 * "Copy Sunday to every weekday", the holidays, and what happens outside
 * these hours.
 *
 * ★ What the setting cannot hold is drawn, not live: `+ Split` (one range a
 * day — `dayScheduleSchema` is `{ enabled, open?, close? }`) and the holiday
 * calendar (no dates at all). Each says why on its title.
 *
 * ★ Outside-hours travels with every save. The setting is REPLACED by the
 * PUT and its validator defaults both fields, so a save that omitted them
 * would reset a silenced AI to answering at 2am; `hoursPatch` always sends
 * them. 02 points this at Studio; the one field that exists is here.
 */
export function HoursDrawer({ workspace }: { readonly workspace: Workspace }) {
  const t = useTranslations('workspace');
  const [week, setWeek] = useState<Record<DayKey, DayHours>>(() => weekOf(workspace));
  const [aiOutside, setAiOutside] = useState<'active' | 'silent'>(
    workspace.hours?.aiOutsideHours ?? 'active',
  );
  const [outsideMsg, setOutsideMsg] = useState(workspace.hours?.outsideHoursHandoffMessage ?? '');
  const [copied, setCopied] = useState(false);
  /*
    02's master switch. A stored week that is switched off is SHOWN, under
    "Use these hours" off — never as seven closed days, which says something
    else: that the business is closed every day.
  */
  /*
    Which days were ever stored. With none — dev's `{ enabled: false }` — no
    day is "Closed": nothing was set, so the rows are empty and the week sits
    under "Use these hours" off.
  */
  const stored = new Set(Object.keys(workspace.hours?.schedule ?? {}));
  const [use, setUse] = useState(
    stored.size > 0 ? workspace.hours?.enabled !== false : workspace.hours == null,
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isPending, startTransition] = useTransition();

  const setDay = (day: DayKey, next: Partial<DayHours>) =>
    setWeek({ ...week, [day]: { ...week[day], ...next } });

  function save() {
    setProblem(null);
    setSaved(false);
    startTransition(async () => {
      const result = await saveWorkspaceFacts(
        {
          hours: hoursPatch(
            week,
            workspace.hours ?? null,
            {
              aiOutsideHours: aiOutside,
              outsideHoursHandoffMessage: outsideMsg.trim(),
            },
            use,
          ),
        },
        workspace.updatedAt ?? null,
      );
      if (result.ok) setSaved(true);
      else setProblem(result.reason === 'stale' ? t('stale') : t('failed'));
    });
  }

  return (
    <>
      <div className={drawer.drawerBody} data-testid="hours-drawer">
        <label className={styles.weekUse}>
          <input
            type="checkbox"
            className="srOnly"
            checked={use}
            data-testid="hours-use"
            onChange={(e) => setUse(e.target.checked)}
          />
          <span className={styles.weekPill} aria-hidden="true" />
          {t('hours.use')}
        </label>
        <ul className={styles.weekRows} data-in-use={use ? 'yes' : 'no'}>
          {DAY_KEYS.map((day) => (
            <li
              key={day}
              className={styles.weekRow}
              data-open={week[day].enabled ? 'yes' : 'no'}
              data-testid={`hours-day-${day}`}
            >
              <span className={styles.weekDay}>{t(`day.${day}`)}</span>
              <label className={styles.weekSwitch}>
                <input
                  type="checkbox"
                  className="srOnly"
                  checked={week[day].enabled}
                  aria-label={t('hours.openOn', { day: t(`day.${day}`) })}
                  onChange={(e) => setDay(day, { enabled: e.target.checked })}
                />
                <span className={styles.weekPill} aria-hidden="true" />
              </label>
              {week[day].enabled ? (
                <span className={styles.weekRange}>
                  <input
                    className={styles.weekTime}
                    type="time"
                    aria-label={`${t(`day.${day}`)} — ${t('hours.open')}`}
                    value={week[day].open ?? ''}
                    onChange={(e) => setDay(day, { open: e.target.value })}
                  />
                  <span className={styles.weekDash} aria-hidden="true">
                    –
                  </span>
                  <input
                    className={styles.weekTime}
                    type="time"
                    aria-label={`${t(`day.${day}`)} — ${t('hours.close')}`}
                    value={week[day].close ?? ''}
                    onChange={(e) => setDay(day, { close: e.target.value })}
                  />
                </span>
              ) : stored.has(day) ? (
                <span className={styles.weekClosed}>{t('hours.closedDay')}</span>
              ) : (
                <span className={styles.weekClosed} data-testid={`hours-unset-${day}`}>
                  — – —
                </span>
              )}
              <span
                className={styles.weekSplit}
                aria-disabled="true"
                title={t('hours.oneRange')}
                data-testid={day === 'sunday' ? 'hours-one-range' : undefined}
              >
                {t('hours.split')}
              </span>
            </li>
          ))}
        </ul>

        {/*
          Sunday to Thursday is the Israeli working week. Purely local — it
          fills the inputs and changes nothing until Save.
        */}
        <button
          type="button"
          className={styles.hoursCopy}
          data-testid="hours-copy-sunday"
          onClick={() => {
            const sun = week.sunday;
            setWeek({
              ...week,
              monday: { ...sun },
              tuesday: { ...sun },
              wednesday: { ...sun },
              thursday: { ...sun },
            });
            setCopied(true);
          }}
        >
          {t('hours.copySunday')}
        </button>
        {copied ? (
          <p className={drawer.hint} data-testid="hours-copied">
            {t('hours.copied')}
          </p>
        ) : null}

        <h3 className={drawer.sectionTitle}>{t('hours.holidays')}</h3>
        <p
          className={styles.weekAbsent}
          title={t('hours.noHolidays')}
          data-testid="hours-no-holidays"
        >
          <span className={styles.weekPill} data-on="no" aria-hidden="true" />
          {t('hours.holidaysAuto')}
        </p>
        <span className={styles.weekSplit} aria-disabled="true" title={t('hours.noHolidays')}>
          {t('hours.addDay')}
        </span>

        <h3 className={drawer.sectionTitle}>{t('hours.outsideHeading')}</h3>
        <label className={drawer.field}>
          <span className={drawer.fieldLabel}>{t('hours.aiOutsideLabel')}</span>
          <select
            className={drawer.box}
            data-testid="hours-ai-outside"
            value={aiOutside}
            onChange={(e) => setAiOutside(e.target.value === 'silent' ? 'silent' : 'active')}
          >
            <option value="active">{t('hours.aiOutside.active')}</option>
            <option value="silent">{t('hours.aiOutside.silent')}</option>
          </select>
        </label>
        <label className={drawer.field}>
          <span className={drawer.fieldLabel}>{t('hours.messageLabel')}</span>
          <input
            className={drawer.box}
            value={outsideMsg}
            maxLength={500}
            placeholder={t('hours.messagePlaceholder')}
            title={t('hours.messageHint')}
            data-testid="hours-message"
            onChange={(e) => setOutsideMsg(e.target.value)}
          />
        </label>
      </div>
      <footer className={drawer.drawerFoot}>
        <button
          type="button"
          className={styles.saveButton}
          data-testid="drawer-save-hours"
          disabled={isPending}
          onClick={save}
        >
          {isPending ? t('saving') : t('hours.save')}
        </button>
        <Link href="/settings/workspace" className={drawer.drawerCancel}>
          {t('cancel')}
        </Link>
        {problem ? (
          <span className={styles.rowNote} data-testid="hours-problem">
            {problem}
          </span>
        ) : saved ? (
          <span className={styles.rowNoteQuiet} data-testid="hours-saved">
            {t('saved')}
          </span>
        ) : null}
      </footer>
    </>
  );
}
