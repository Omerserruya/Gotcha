'use client';

import { useLocale, useTimeZone, useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { groupByDomain, type PermissionDef } from '@/api/contracts/permission-catalog';
import { holds, type Person } from '@/api/contracts/roles';
import drawer from '@/design-system/styles/drawer.module.css';
import { Link } from '@/i18n/navigation';

import { addPermission } from './actions';
import { dateIn, expiresAtOf, type Ends } from './grant-end';
import { areaName, permissionName } from './permission-words';
import styles from './Roles.module.css';

/**
 * 12e, measured: a floating dialog over 12d - "Add a permission for {name}" - a search over the
 * catalogue by area, what is already covered shown and not pickable (given
 * to them already, or in their role), an end, a reason, and Add.
 *
 * ⚠ Add is a WRITE that gives a real person a permission. No test presses
 * it against the platform; the action is mocked to throw in every test.
 *
 * Ends (backend 53a5079a): no end date, 7 or 30 days, or a date - each the
 * END of that day in the workspace's time zone. A date is in the future
 * only; the server refuses a past one anyway, and says so.
 */
export function GrantPicker({
  person,
  permissions,
  roleName,
}: {
  readonly person: Person;
  readonly permissions: readonly PermissionDef[];
  readonly roleName: string | null;
}) {
  const t = useTranslations('roles.grant');
  const tr = useTranslations('roles');
  const locale = useLocale();
  // The catalogue is English only: names and areas in the role grid's own words.
  const word = (key: string) => (tr.has(key as never) ? tr(key as never) : null);
  const join = (row: string, action: string) => tr('catalog.permissionName', { row, action });
  const nameOf = (p: PermissionDef) => permissionName(p, locale, word, join);
  const who = person.name ?? person.email;
  const [query, setQuery] = useState('');
  /* 02 draws checkboxes: several at once, one call each, in order. */
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [reason, setReason] = useState('');
  const timeZone = useTimeZone() ?? 'Asia/Jerusalem';
  const [ends, setEnds] = useState<Ends>({ kind: 'none' });
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [isPending, startTransition] = useTransition();

  const given = new Set(person.grants.filter((g) => g.granted).map((g) => g.feature));
  const named = permissions.filter((p) => p.displayName.trim() !== '');
  // Searched in the words shown, so a Hebrew name finds its permission.
  const q = query.trim().toLowerCase();
  const shown = groupByDomain(
    q
      ? named.filter(
          (p) =>
            nameOf(p).toLowerCase().includes(q) ||
            areaName(p.domain, locale, word, p.domain).toLowerCase().includes(q),
        )
      : named,
  );

  const status = (p: PermissionDef): string | null =>
    given.has(p.key)
      ? t('already')
      : holds(person.permissions, p.key)
        ? t('inRole', { role: roleName || '-' })
        : null;
  const pickable = named.filter((p) => status(p) === null);

  function add() {
    if (chosen.length === 0) return;
    if (ends.kind === 'date' && !ends.date) return;
    setProblem(null);
    const expiresAt = expiresAtOf(ends, timeZone);
    startTransition(async () => {
      for (const key of chosen) {
        const result = await addPermission(person.id, key, reason.trim(), expiresAt);
        if (!result.ok) {
          // Stop at the first refusal: the ones before it are given.
          setProblem(tr(`error.${result.reason}` as 'error.failed'));
          return;
        }
      }
      setDone(true);
    });
  }

  return (
    <div
      className={styles.grantPicker}
      data-testid="grant-picker"
      role="dialog"
      aria-label={t('title', { name: who })}
    >
      <div className={styles.grantHead}>
        <h3 className={styles.grantTitle}>{t('title', { name: who })}</h3>
        <input
          className={drawer.box}
          type="search"
          placeholder={t('search')}
          aria-label={t('search')}
          value={query}
          data-testid="grant-search"
          onChange={(e) => setQuery(e.target.value)}
        />
        {/* An all-disabled list explains itself. */}
        {named.length > 0 && pickable.length === 0 ? (
          <p className={styles.grantAllCovered} data-testid="grant-all-covered">
            {t('allCovered', { role: roleName || '-' })}
          </p>
        ) : null}
      </div>

      <div className={styles.grantAreas}>
        {shown.map((group) => (
          <section key={group.domain} className={styles.grantArea}>
            <h4 className={styles.grantAreaName}>
              {areaName(group.domain, locale, word, group.domain)}
            </h4>
            <ul className={styles.grantOptions}>
              {group.permissions.map((p) => {
                const covered = status(p);
                return (
                  <li key={p.key}>
                    <label
                      className={styles.grantOption}
                      data-covered={covered ? 'yes' : 'no'}
                      data-testid={`grant-option-${p.key}`}
                    >
                      <input
                        type="checkbox"
                        value={p.key}
                        disabled={covered !== null}
                        checked={chosen.includes(p.key)}
                        onChange={(e) =>
                          setChosen(
                            e.target.checked
                              ? [...chosen, p.key]
                              : chosen.filter((k) => k !== p.key),
                          )
                        }
                      />
                      <span className={styles.grantOptionName}>{nameOf(p)}</span>
                      {covered ? <span className={styles.grantOptionNote}>{covered}</span> : null}
                    </label>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>

      {/* 02's sticky footer: Ends, Why and Add are always in view. */}
      <div className={styles.grantFoot}>
        <div className={styles.grantRow}>
          <span className={drawer.fieldLabel}>{t('ends')}</span>
          <span className={styles.grantSegmented} role="radiogroup" aria-label={t('ends')}>
            {(
              [
                ['none', t('noEnd'), { kind: 'none' }],
                ['days7', t('days7'), { kind: 'days', days: 7 }],
                ['days30', t('days30'), { kind: 'days', days: 30 }],
                ['date', t('pickDate'), { kind: 'date', date: '' }],
              ] as const
            ).map(([key, label, value]) => {
              const current =
                ends.kind === value.kind &&
                (ends.kind !== 'days' || (value.kind === 'days' && ends.days === value.days));
              return (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={current}
                  className={styles.grantSegment}
                  data-current={current ? 'yes' : undefined}
                  data-testid={`grant-ends-${key}`}
                  onClick={() => setEnds(value)}
                >
                  {label}
                </button>
              );
            })}
          </span>
          {ends.kind === 'date' ? (
            <input
              type="date"
              className={drawer.box}
              aria-label={t('pickDate')}
              // Tomorrow, there: a date that has already ended is not an end.
              min={dateIn(timeZone, new Date(), 1)}
              value={ends.date}
              data-testid="grant-ends-day"
              onChange={(e) => setEnds({ kind: 'date', date: e.target.value })}
            />
          ) : null}
        </div>
        <label className={styles.grantRow}>
          <span className={drawer.fieldLabel}>{t('why')}</span>
          <input
            className={drawer.box}
            value={reason}
            maxLength={300}
            placeholder={t('whyPlaceholder')}
            data-testid="grant-reason"
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <div className={styles.grantActions}>
          <button
            type="button"
            className={styles.grantAdd}
            data-testid="grant-add"
            disabled={
              chosen.length === 0 || isPending || done || (ends.kind === 'date' && !ends.date)
            }
            onClick={add}
          >
            {t('add')}
          </button>
          <Link
            href={{ pathname: '/settings/people', query: { person: person.id } }}
            className={drawer.drawerCancel}
            scroll={false}
          >
            {t('cancel')}
          </Link>
          {problem ? (
            <span className={styles.grantProblem} data-testid="grant-problem">
              {problem}
            </span>
          ) : done ? (
            <span className={styles.grantDone} data-testid="grant-done">
              {t('done', { name: who })}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
