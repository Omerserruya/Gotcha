'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import type { SlaSettings } from '@/api/contracts/sla';
import drawer from '@/design-system/styles/drawer.module.css';
import { Link } from '@/i18n/navigation';

import type { DepartmentSla } from './load-sla-setup';
import { saveSla, type SlaWrite } from './sla-actions';
import styles from './Workspace.module.css';

/** A whole number in range, or `null`. An empty or partial entry is not a number. */
function wholeIn(raw: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw.trim());
  return value >= min && value <= max ? value : null;
}

/**
 * The response target (W2): on or off, the minutes, the early warning, and
 * each department's own target. What the inbox marks - nothing moves or
 * reassigns a conversation, and the drawer says so.
 *
 * A department whose own target could not be read is shown and NOT editable:
 * saving over a value nobody saw would erase it.
 */
export function SlaDrawer({
  settings,
  departments,
}: {
  readonly settings: SlaSettings;
  readonly departments: readonly DepartmentSla[] | null;
}) {
  const t = useTranslations('workspace');
  const [enabled, setEnabled] = useState(settings.enabled);
  const [minutes, setMinutes] = useState(String(settings.slaMinutes ?? 30));
  const [warning, setWarning] = useState(
    settings.warningThreshold === null ? '' : String(settings.warningThreshold),
  );
  const [own, setOwn] = useState<Record<string, { enabled: boolean; minutes: string }>>(() =>
    Object.fromEntries(
      (departments ?? []).flatMap((d) =>
        d.own === null
          ? []
          : [
              [
                d.id,
                {
                  enabled: d.own.enabled,
                  minutes: d.own.slaMinutes === null ? '' : String(d.own.slaMinutes),
                },
              ],
            ],
      ),
    ),
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isPending, startTransition] = useTransition();

  const minutesValue = wholeIn(minutes, 1, 1440);
  const warningValue = warning.trim() === '' ? null : wholeIn(warning, 0, 100);
  const warningBad = warning.trim() !== '' && warningValue === null;
  const departmentBad = (id: string) => {
    const entry = own[id];
    return entry !== undefined && entry.enabled && wholeIn(entry.minutes, 1, 1440) === null;
  };

  function save() {
    setProblem(null);
    setSaved(false);
    if (
      minutesValue === null ||
      warningBad ||
      (departments ?? []).some((d) => departmentBad(d.id))
    ) {
      setProblem(t('slaDrawer.fix'));
      return;
    }
    const changed: SlaWrite['departments'] = (departments ?? []).flatMap((d) => {
      const entry = own[d.id];
      if (d.own === null || entry === undefined) return [];
      const next = {
        enabled: entry.enabled,
        slaMinutes: entry.enabled ? wholeIn(entry.minutes, 1, 1440) : null,
      };
      const was = { enabled: d.own.enabled, slaMinutes: d.own.enabled ? d.own.slaMinutes : null };
      return next.enabled === was.enabled && next.slaMinutes === was.slaMinutes
        ? []
        : [{ id: d.id, ...next }];
    });
    startTransition(async () => {
      const result = await saveSla({
        enabled,
        slaMinutes: minutesValue,
        warningThreshold: warningValue,
        departments: changed,
      });
      if (result.ok) {
        setSaved(true);
        return;
      }
      setProblem(
        result.reason === 'departments'
          ? t('slaDrawer.problem.departments', {
              names: (departments ?? [])
                .filter((d) => result.failed.includes(d.id))
                .map((d) => d.name)
                .join(', '),
            })
          : t(`slaDrawer.problem.${result.reason}`),
      );
    });
  }

  return (
    <>
      <div className={drawer.drawerBody} data-testid="sla-drawer">
        <label className={styles.weekUse}>
          <input
            type="checkbox"
            className="srOnly"
            checked={enabled}
            data-testid="sla-enabled"
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span className={styles.weekPill} aria-hidden="true" />
          {t('slaDrawer.enabled')}
        </label>
        <label className={drawer.field}>
          <span className={drawer.fieldLabel}>{t('slaDrawer.minutes')}</span>
          <input
            className={drawer.box}
            inputMode="numeric"
            value={minutes}
            aria-invalid={minutesValue === null}
            data-testid="sla-minutes"
            onChange={(e) => setMinutes(e.target.value)}
          />
          {minutesValue === null ? (
            <span className={styles.rowNote} data-testid="sla-minutes-problem">
              {t('slaDrawer.invalidMinutes')}
            </span>
          ) : null}
        </label>
        <label className={drawer.field}>
          <span className={drawer.fieldLabel}>{t('slaDrawer.warning')}</span>
          <input
            className={drawer.box}
            inputMode="numeric"
            value={warning}
            aria-invalid={warningBad}
            data-testid="sla-warning"
            onChange={(e) => setWarning(e.target.value)}
          />
          <span className={drawer.hint}>
            {warningBad ? t('slaDrawer.invalidWarning') : t('slaDrawer.warningHint')}
          </span>
        </label>

        <h3 className={drawer.sectionTitle}>{t('slaDrawer.departments')}</h3>
        {departments === null ? (
          <p className={drawer.hint} data-testid="sla-departments-unavailable">
            {t('slaDrawer.departmentsUnavailable')}
          </p>
        ) : departments.length === 0 ? (
          <p className={drawer.hint} data-testid="sla-departments-none">
            {t('slaDrawer.departmentsNone')}
          </p>
        ) : (
          <>
            <p className={drawer.hint}>{t('slaDrawer.departmentsLine')}</p>
            <ul className={styles.weekRows}>
              {departments.map((d) => {
                const entry = own[d.id];
                return (
                  <li key={d.id} className={styles.weekRow} data-testid={`sla-department-${d.id}`}>
                    <span className={styles.weekDay}>{d.name}</span>
                    {entry === undefined ? (
                      <span className={drawer.hint} data-testid={`sla-department-unread-${d.id}`}>
                        {t('slaDrawer.unread')}
                      </span>
                    ) : (
                      <>
                        <label className={styles.weekSwitch}>
                          <input
                            type="checkbox"
                            className="srOnly"
                            checked={entry.enabled}
                            aria-label={t('slaDrawer.own', { name: d.name })}
                            data-testid={`sla-department-own-${d.id}`}
                            onChange={(e) =>
                              setOwn({ ...own, [d.id]: { ...entry, enabled: e.target.checked } })
                            }
                          />
                          <span className={styles.weekPill} aria-hidden="true" />
                        </label>
                        {entry.enabled ? (
                          <input
                            className={drawer.box}
                            inputMode="numeric"
                            value={entry.minutes}
                            aria-label={t('slaDrawer.ownMinutes', { name: d.name })}
                            aria-invalid={departmentBad(d.id)}
                            data-testid={`sla-department-minutes-${d.id}`}
                            onChange={(e) =>
                              setOwn({ ...own, [d.id]: { ...entry, minutes: e.target.value } })
                            }
                          />
                        ) : (
                          <span className={drawer.hint}>{t('slaDrawer.usesWorkspace')}</span>
                        )}
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
        <p className={drawer.hint}>{t('slaDrawer.notEnforced')}</p>
      </div>
      <footer className={drawer.drawerFoot}>
        <button
          type="button"
          className={styles.saveButton}
          data-testid="drawer-save-sla"
          disabled={isPending}
          onClick={save}
        >
          {isPending ? t('saving') : t('save')}
        </button>
        <Link href="/settings/workspace" className={drawer.drawerCancel}>
          {t('cancel')}
        </Link>
        {problem ? (
          <span className={styles.rowNote} data-testid="sla-problem">
            {problem}
          </span>
        ) : saved ? (
          <span className={styles.rowNoteQuiet} data-testid="sla-saved">
            {t('saved')}
          </span>
        ) : null}
      </footer>
    </>
  );
}
