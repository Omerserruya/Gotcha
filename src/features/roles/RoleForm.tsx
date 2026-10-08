'use client';

import { ChevronDown } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo, useState, useTransition } from 'react';

import { humaniseCode } from '@/api/contracts/capabilities';
import type { PermissionDef } from '@/api/contracts/permission-catalog';
import { gridCanRepresent, holds, wildcardsIn, type Role } from '@/api/contracts/roles';
import drawer from '@/design-system/styles/drawer.module.css';
import { Link, useRouter } from '@/i18n/navigation';

import { createRole, updateRole } from './actions';
import { gridRows, levelOf, levelsOf, rowChanged, withLevel, type GridRow } from './role-grid';
import { permissionName } from './permission-words';
import { roleNameOf } from './role-words';
import styles from './Roles.module.css';

/**
 * 12c, measured: "New role" - name and "Start from" on one row, what it is
 * for, then the permissions as 02's table (AREA · PERMISSION · LEVEL ·
 * SCOPE / LIMIT), "Compared with {source}" and "Give this role to" beside
 * it, and Create role.
 *
 * The table is the catalogue on the approved mapping (`role-grid.ts`): a
 * LEVEL where the actions are a ladder, the ACTIONS where they are separate
 * jobs. Scope is the role ASSIGNMENT's, not a permission's, so the column
 * says so on rows that take one; a money limit has no field anywhere - "-".
 *
 * ★ A role that grants by PATTERN (Owner's `*`, Department Manager's
 * `conversation:messages:*`) is a standing instruction a grid cannot hold:
 * ticking what it matches today freezes it. Started from one, the table is
 * read-only and Create is unavailable, with the reason.
 *
 * ★ EDIT (12b's Edit, Omer 2026-10-08): the same form on one custom role -
 *   seeded from it, compared against what it holds now, saved over it, then
 *   back to the roles. No "Start from": the role starts from itself. A
 *   built-in role never comes here (the route refuses it).
 */
export function RoleForm({
  permissions,
  roles,
  initialSourceId = '',
  editing = null,
}: {
  readonly permissions: readonly PermissionDef[];
  /** Existing roles to start from. */
  readonly roles: readonly Role[];
  /** 12b's "Duplicate": the role this one starts from (`?from=`). */
  readonly initialSourceId?: string;
  /** 12b's "Edit": the custom role being changed - the form saves over it. */
  readonly editing?: Role | null;
}) {
  const t = useTranslations('roles');
  const locale = useLocale();
  // The catalogue is English only: a permission's name in the role grid's own words.
  const word = (key: string) => (t.has(key as never) ? t(key as never) : null);
  const join = (row: string, action: string) => t('catalog.permissionName', { row, action });
  // A built-in role in the reader's words; a custom one in its owner's.
  const nameOf = (role: Role) => roleNameOf(role, (key, part) => t(`builtinRole.${key}.${part}`));
  const router = useRouter();
  /*
   * 02 starts from Agent: "you start from an existing role and only touch
   * what's different" - so the Compared card is there from the first look.
   * 12b's Duplicate (`?from=`) wins; no Agent role, nothing.
   */
  // The platform's key is lowercase (`invite-role.service`: builtinKey "agent").
  const startId = editing
    ? editing.id
    : initialSourceId || (roles.find((r) => r.builtinKey?.toLowerCase() === 'agent')?.id ?? '');
  const [sourceId, setSourceId] = useState(startId);
  const [name, setName] = useState(editing?.name ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  // Seeded as `startFrom` would seed it - including its refusal of a pattern role.
  const [selected, setSelected] = useState<readonly string[]>(() => {
    const role = roles.find((r) => r.id === startId);
    return role && gridCanRepresent(role.features) ? [...role.features] : [];
  });
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const source = roles.find((r) => r.id === sourceId) ?? null;
  const patterned = source !== null && !gridCanRepresent(source.features);
  const rows = useMemo(() => gridRows(permissions), [permissions]);
  const held = new Set(selected);
  const base = new Set(source && !patterned ? source.features : []);
  const changed = source && !patterned ? rows.filter((r) => rowChanged(r, held, base)) : [];

  function startFrom(id: string) {
    setSourceId(id);
    const role = roles.find((r) => r.id === id);
    // A copy of the features as they are NOW; a pattern role seeds nothing.
    setSelected(role && gridCanRepresent(role.features) ? [...role.features] : []);
  }

  function toggle(key: string) {
    setSelected((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }

  function submit() {
    setError(null);
    if (editing) {
      startTransition(async () => {
        const result = await updateRole(editing.id, {
          name: name.trim(),
          description: description.trim(),
          features: selected,
          isSystem: editing.isSystem,
        });
        if (result.ok) router.push('/settings/people/roles');
        else setError(t(`form.edit.error.${result.reason}`));
      });
      return;
    }
    startTransition(async () => {
      const result = await createRole({
        name: name.trim(),
        description: description.trim(),
        features: selected,
      });
      if (!result.ok) setError(t(`form.error.${result.reason}`));
      else {
        setName('');
        setDescription('');
        setSelected([]);
        setSourceId('');
      }
    });
  }

  const rowName = (row: GridRow) =>
    t.has(`form.row.${row.id}`)
      ? t(`form.row.${row.id}` as 'form.row.crm:contacts')
      : humaniseCode(row.id.replace(':', ' '));
  const actionName = (action: string) =>
    t.has(`form.action.${action}`)
      ? t(`form.action.${action}` as 'form.action.read')
      : humaniseCode(action);
  const areaName = (domain: string) =>
    t.has(`form.area.${domain}`)
      ? t(`form.area.${domain}` as 'form.area.ai')
      : humaniseCode(domain);

  /** What a row holds, said for the comparison card. */
  const summary = (row: GridRow, set: ReadonlySet<string>) =>
    row.ladder
      ? (() => {
          const level = levelOf(row, set);
          return level ? t(`form.level.${level}`) : t('form.level.mixed');
        })()
      : row.permissions
          .filter((p) => set.has(p.key))
          .map((p) => actionName(p.action))
          .join(', ') || t('form.level.none');

  return (
    <section className={styles.newRole} data-testid="role-form">
      <div className={styles.newRoleMain}>
        <div className={styles.newRoleTop}>
          <label className={drawer.field}>
            <span className={drawer.fieldLabel}>{t('form.name')}</span>
            <input
              className={drawer.box}
              value={name}
              maxLength={80}
              data-testid="role-name"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          {editing ? null : (
            <label className={drawer.field}>
              <span className={drawer.fieldLabel}>{t('form.startFrom')}</span>
              {/* 02's box: the role's name and a chevron, never a clipped placeholder. */}
              <span className={styles.selectBox}>
                <select
                  className={`${drawer.box} ${styles.selectInner}`}
                  data-testid="role-source"
                  value={sourceId}
                  title={
                    source && !patterned
                      ? t('form.startFromHint', { name: nameOf(source) })
                      : undefined
                  }
                  onChange={(e) => startFrom(e.target.value)}
                >
                  <option value="">{t('form.startFromNone')}</option>
                  {roles.map((role) => (
                    <option key={role.id} value={role.id}>
                      {nameOf(role)}
                    </option>
                  ))}
                </select>
                <ChevronDown size={13} className={styles.selectChevron} aria-hidden="true" />
              </span>
            </label>
          )}
        </div>
        <label className={drawer.field}>
          <span className={drawer.fieldLabel}>{t('form.description')}</span>
          <input
            className={drawer.box}
            value={description}
            maxLength={300}
            data-testid="role-description"
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>

        {source && !patterned ? (
          <p className="srOnly" data-testid="role-source-hint">
            {t('form.startFromHint', { name: nameOf(source) })}
          </p>
        ) : null}

        {/*
          The refusal, in the role's own terms: Department Manager would
          render fourteen correct rows and drop two patterns, looking RIGHT
          while being destructive.
        */}
        {patterned ? (
          <div className={styles.formWildcard} data-testid="role-source-wildcard">
            <p className={styles.formWildcardLead}>{t('form.wildcardHeading')}</p>
            <p className={styles.formHint}>
              {t('form.wildcardBody', { patterns: wildcardsIn(source.features).join(', ') })}
            </p>
            <p className={styles.formHint} data-testid="role-source-refused">
              {t('form.wildcardCannotSeed')}
            </p>
          </div>
        ) : null}

        <div className={styles.grid} role="table" aria-label={t('form.tableLabel')}>
          <div className={styles.gridHead} role="row">
            <span role="columnheader">{t('form.col.area')}</span>
            <span role="columnheader">{t('form.col.permission')}</span>
            <span role="columnheader">{t('form.col.level')}</span>
            <span role="columnheader">{t('form.col.scope')}</span>
          </div>
          {rows.map((row, i) => {
            const firstOfArea = i === 0 || rows[i - 1]!.domain !== row.domain;
            const level = levelOf(row, held);
            const isChanged = changed.includes(row);
            return (
              <div
                key={row.id}
                className={styles.gridRow}
                role="row"
                data-testid={`role-row-${row.id}`}
                data-changed={isChanged ? 'yes' : 'no'}
              >
                <span className={styles.gridArea} role="cell">
                  {firstOfArea ? areaName(row.domain) : ''}
                </span>
                <span className={styles.gridName} role="cell">
                  {isChanged ? (
                    <span className={styles.gridDot} aria-label={t('form.changedMark')}>
                      ●
                    </span>
                  ) : null}
                  {rowName(row)}
                </span>
                <span className={styles.gridLevel} role="cell">
                  {patterned ? (
                    <span className={styles.gridPattern}>
                      {row.permissions.some((p) => holds(source.features, p.key))
                        ? t('form.byPattern')
                        : '-'}
                    </span>
                  ) : row.ladder ? (
                    <span className={styles.segmented} role="radiogroup" aria-label={rowName(row)}>
                      {levelsOf(row).map((l) => (
                        <button
                          key={l}
                          type="button"
                          role="radio"
                          aria-checked={level === l}
                          className={styles.segment}
                          data-current={level === l ? 'yes' : 'no'}
                          data-testid={`role-level-${row.id}-${l}`}
                          onClick={() => setSelected(withLevel(row, l, selected))}
                        >
                          {t(`form.level.${l}`)}
                        </button>
                      ))}
                    </span>
                  ) : (
                    <span className={styles.gridActions}>
                      {row.permissions.map((p) => (
                        <button
                          key={p.key}
                          type="button"
                          aria-pressed={held.has(p.key)}
                          className={styles.gridAction}
                          data-testid={`role-action-${p.key}`}
                          title={permissionName(p, locale, word, join)}
                          onClick={() => toggle(p.key)}
                        >
                          {actionName(p.action)}
                        </button>
                      ))}
                    </span>
                  )}
                </span>
                {/* Scope is the assignment's; a money limit has no field. */}
                <span
                  className={styles.gridScope}
                  role="cell"
                  title={row.scoped ? t('form.scopeHint') : t('form.noLimits')}
                >
                  {row.scoped ? t('form.scopeAssigned') : '-'}
                </span>
              </div>
            );
          })}
        </div>

        {changed.length > 0 && source ? (
          <p className={styles.gridLegend} data-testid="role-legend">
            ● {t('form.changedFrom', { name: nameOf(source) })}
          </p>
        ) : null}

        <p className="srOnly" data-testid="role-selected">
          {t('form.selected', { count: selected.length })}
        </p>

        {/* 02's bar at the form's end - it stays in view while the grid scrolls. */}
        <div className={styles.formBar} data-testid="role-bar">
          <button
            type="button"
            className={styles.createButton}
            disabled={isPending || !name.trim() || patterned}
            title={patterned ? t('form.wildcardCannotSeed') : undefined}
            data-testid="role-save"
            onClick={submit}
          >
            {isPending
              ? editing
                ? t('form.edit.saving')
                : t('form.saving')
              : editing
                ? t('form.edit.save')
                : t('form.save')}
          </button>
          <Link href="/settings/people/roles" className={drawer.drawerCancel}>
            {t('form.cancel')}
          </Link>
        </div>
        {error ? (
          <p className={styles.formError} data-testid="role-error">
            {error}
          </p>
        ) : null}
      </div>

      <aside className={styles.newRoleSide}>
        {source && !patterned ? (
          <section className={styles.sideCard} data-testid="role-compared">
            <h3 className={styles.sideTitle}>
              {editing
                ? t('form.edit.changes', { name: nameOf(source) })
                : t('form.comparedWith', { name: nameOf(source) })}
            </h3>
            {changed.length > 0 ? (
              <ul className={styles.sideList}>
                {changed.map((row) => (
                  <li key={row.id}>
                    <span className={styles.sideName}>{rowName(row)}</span>
                    <span className={styles.sideDiff}>
                      {summary(row, base)} → {summary(row, held)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            <p className={styles.sideNote}>
              {editing
                ? changed.length > 0
                  ? t('form.edit.elseSame')
                  : t('form.edit.noChange')
                : changed.length > 0
                  ? t('form.elseSame', { name: nameOf(source) })
                  : t('form.allSame', { name: nameOf(source) })}
            </p>
          </section>
        ) : null}

        {/* Assigning a role is another route; drawn, not live. */}
        <section className={styles.sideCard} data-testid="role-give">
          <h3 className={styles.sideTitle}>{t('form.giveTo')}</h3>
          <span className={styles.sideAdd} aria-disabled="true" title={t('form.giveNotYet')}>
            {t('form.addPerson')}
          </span>
        </section>
      </aside>
    </section>
  );
}
