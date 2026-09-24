'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { groupByDomain, type PermissionDef } from '@/api/contracts/permission-catalog';
import type { Role } from '@/api/contracts/roles';
import { Button } from '@/design-system/primitives/button/Button';
import { Input } from '@/design-system/primitives/input/Input';

import { createRole } from './actions';
import styles from './Roles.module.css';

/**
 * Create a role — screen 12c.
 *
 * *"You start from an existing role and only touch what's different."*
 *
 * That is not a server concept. `POST /permissions/roles` takes
 * `{ name, description, features }` and knows nothing about a source, so
 * starting from a role means seeding the selection from its features and
 * sending the result — one call rather than a copy followed by an edit.
 *
 * And because it is a copy rather than a link, the screen says so: later
 * edits to the source will not reach the new role. A merchant who reads
 * "start from Agent" can reasonably expect the opposite.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * TWO THINGS THE DESIGN DRAWS THAT THE CATALOGUE CANNOT HOLD
 * ════════════════════════════════════════════════════════════════════════════
 * **None / View / Edit / Manage.** `TenantRoleFeature` is `(roleId, feature)`
 * — a permission is held or it is not. There are no four levels to render,
 * and a control offering them would write three of its four states to the
 * same value.
 *
 * **Money limits on the row.** There is no amount column anywhere on a role,
 * a feature or a grant. A role that may issue refunds may issue any refund,
 * and the design's "refunds up to ₪1,000" cannot be stored, enforced or
 * displayed.
 *
 * Both are named on the screen rather than omitted, because a missing control
 * is indistinguishable from one somebody failed to find — and the second is
 * the kind of absence an owner would otherwise discover from an invoice.
 */
export function RoleForm({
  permissions,
  roles,
}: {
  readonly permissions: readonly PermissionDef[];
  /** Existing roles to start from. */
  readonly roles: readonly Role[];
}) {
  const t = useTranslations('roles');
  const [sourceId, setSourceId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const source = roles.find((r) => r.id === sourceId) ?? null;

  function startFrom(id: string) {
    setSourceId(id);
    const role = roles.find((r) => r.id === id);
    // A copy of the features as they are NOW. Nothing links the two after
    // this, which is what the hint below says out loud.
    setSelected(role ? [...role.features] : []);
  }

  function toggle(key: string) {
    setSelected((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }

  function submit() {
    setError(null);
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

  return (
    <section className={styles.roleForm} data-testid="role-form">
      <h2 className={styles.formHeading}>{t('form.heading')}</h2>

      <label className={styles.formField}>
        <span className={styles.formLabel}>{t('form.startFrom')}</span>
        <select
          className={styles.formSelect}
          data-testid="role-source"
          value={sourceId}
          onChange={(e) => startFrom(e.target.value)}
        >
          <option value="">{t('form.startFromNone')}</option>
          {roles.map((role) => (
            <option key={role.id} value={role.id}>
              {role.name}
            </option>
          ))}
        </select>
      </label>

      {/*
        Said because "start from" reads as a link, and it is a copy. Somebody
        who later widens the Agent role would reasonably expect this one to
        follow, and it will not.
      */}
      {source ? (
        <p className={styles.formHint} data-testid="role-source-hint">
          {t('form.startFromHint', { name: source.name })}
        </p>
      ) : null}

      <Input label={t('form.name')} value={name} onChange={(e) => setName(e.target.value)} />
      <Input
        label={t('form.description')}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />

      {/*
        One checkbox per permission, grouped by area as the design asks —
        and one checkbox, not four levels. See the header.
      */}
      {groupByDomain(permissions).map((domain) => (
        <fieldset key={domain.domain} className={styles.formDomain} data-testid="role-domain">
          <legend className={styles.formLegend}>{domain.domain}</legend>
          {domain.permissions.map((permission) => (
            <label key={permission.key} className={styles.formPermission}>
              <input
                type="checkbox"
                data-testid={`role-permission-${permission.key}`}
                checked={selected.includes(permission.key)}
                onChange={() => toggle(permission.key)}
              />
              <span>{permission.displayName}</span>
            </label>
          ))}
        </fieldset>
      ))}

      <p className={styles.formHint} data-testid="role-selected">
        {t('form.selected', { count: selected.length })}
      </p>

      {/* Named rather than drawn. Both are storage, not layout. */}
      <p className={styles.formAbsent} data-testid="role-no-levels">
        {t('form.noLevels')}
      </p>
      <p className={styles.formAbsent} data-testid="role-no-limits">
        {t('form.noLimits')}
      </p>

      <Button
        variant="primary"
        disabled={isPending || !name.trim()}
        data-testid="role-save"
        onClick={submit}
      >
        {isPending ? t('form.saving') : t('form.save')}
      </Button>

      {error ? (
        <p className={styles.formError} data-testid="role-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}
