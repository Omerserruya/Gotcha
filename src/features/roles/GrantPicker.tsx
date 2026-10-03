'use client';

import { useTranslations } from 'next-intl';
import { useMemo, useState, useTransition } from 'react';

import { groupByDomain, type PermissionDef } from '@/api/contracts/permission-catalog';
import { holds, type Person } from '@/api/contracts/roles';
import drawer from '@/design-system/styles/drawer.module.css';
import { Link } from '@/i18n/navigation';

import { addPermission } from './actions';
import styles from './Roles.module.css';

/**
 * 12e, measured: "Add a permission for {name}" — a search over the
 * catalogue by area, what is already covered shown and not pickable (given
 * to them already, or in their role), an end, a reason, and Add.
 *
 * ⚠ Add is a WRITE that gives a real person a permission. No test presses
 * it against the platform; the action is mocked to throw in every test.
 *
 * An end date is not stored for an extra permission — "No end date" is the
 * only answer, and 7 days / 30 days / a date are drawn, not live.
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
  const who = person.name ?? person.email;
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [isPending, startTransition] = useTransition();

  const given = new Set(person.grants.filter((g) => g.granted).map((g) => g.feature));
  const named = permissions.filter((p) => p.displayName.trim() !== '');
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return groupByDomain(
      q
        ? named.filter(
            (p) => p.displayName.toLowerCase().includes(q) || p.domain.toLowerCase().includes(q),
          )
        : named,
    );
  }, [named, query]);

  const status = (p: PermissionDef): string | null =>
    given.has(p.key)
      ? t('already')
      : holds(person.permissions, p.key)
        ? t('inRole', { role: roleName || '—' })
        : null;

  function add() {
    if (!chosen) return;
    setProblem(null);
    startTransition(async () => {
      const result = await addPermission(person.id, chosen, reason.trim());
      if (result.ok) setDone(true);
      else setProblem(tr(`error.${result.reason}` as 'error.failed'));
    });
  }

  return (
    <div
      className={styles.grantPicker}
      data-testid="grant-picker"
      role="dialog"
      aria-label={t('title', { name: who })}
    >
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
      <div className={styles.grantAreas}>
        {shown.map((group) => (
          <section key={group.domain} className={styles.grantArea}>
            <h4 className={styles.grantAreaName}>{group.domain}</h4>
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
                        type="radio"
                        name="grant"
                        value={p.key}
                        disabled={covered !== null}
                        checked={chosen === p.key}
                        onChange={() => setChosen(p.key)}
                      />
                      <span className={styles.grantOptionName}>{p.displayName}</span>
                      {covered ? <span className={styles.grantOptionNote}>{covered}</span> : null}
                    </label>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>

      <div className={styles.grantRow}>
        <span className={drawer.fieldLabel}>{t('ends')}</span>
        <span className={styles.grantSegmented} title={t('noEndOnly')}>
          <span className={styles.grantSegment} data-current="yes">
            {t('noEnd')}
          </span>
          <span className={styles.grantSegment} aria-disabled="true">
            {t('days7')}
          </span>
          <span className={styles.grantSegment} aria-disabled="true">
            {t('days30')}
          </span>
          <span className={styles.grantSegment} aria-disabled="true">
            {t('pickDate')}
          </span>
        </span>
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
          disabled={!chosen || isPending || done}
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
  );
}
