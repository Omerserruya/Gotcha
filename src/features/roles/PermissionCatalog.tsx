import { getTranslations } from 'next-intl/server';

import { humaniseCode } from '@/api/contracts/capabilities';
import { groupByDomain, takesScope, type PermissionDef } from '@/api/contracts/permission-catalog';

import styles from './Roles.module.css';

/**
 * Screen 12c — what a role allows, as the catalogue.
 *
 * ── NOT THE DESIGN'S GRID, AND THE REASON IS A WRITE ──
 * The design draws one row per area with None/View/Edit/Manage. The platform
 * has `conversation:messages:read · reply · takeover · assign · close` —
 * **five independent keys, where the action is the level.**
 *
 * A four-way radio must pick one of four values to stand for five booleans,
 * so **saving an untouched role would drop whatever the levels cannot
 * express** — no error, no warning, and the role now differs from what its
 * owner believes. **A control that cannot represent a state the system can be
 * in will eventually be used to destroy that state.**
 *
 * ── EACH PERMISSION IN THE PLATFORM'S OWN WORDS ──
 * `displayName` and `description` come from the catalogue and are **not
 * re-worded here**. They are already written, and a second vocabulary is a
 * second thing to drift.
 *
 * ── AND SCOPE APPEARS ONLY WHERE IT APPLIES ──
 * `PermissionDef.scoped` is a boolean — whether the dimension applies at all.
 * A permission without it gets no scope marker, because a greyed control on a
 * row that has none is the same lie in miniature.
 */
export async function PermissionCatalog({
  permissions,
}: {
  readonly permissions: readonly PermissionDef[];
}) {
  const t = await getTranslations('roles');
  const domains = groupByDomain(permissions);

  return (
    <div className={styles.catalog} data-testid="permission-catalog">
      {domains.map((group) => (
        <section
          key={group.domain}
          className={styles.domain}
          data-testid={`domain-${group.domain}`}
        >
          <h3 className={styles.domainHeading}>{humaniseCode(group.domain)}</h3>

          <ul className={styles.permissions}>
            {group.permissions.map((permission) => (
              <li
                key={permission.key}
                className={styles.permission}
                data-testid={`permission-${permission.key}`}
                data-scoped={permission.scoped ? 'yes' : 'no'}
              >
                {/*
                  The platform's own words. Re-writing them here would create
                  a second vocabulary that drifts from the one the backend
                  enforces against.
                */}
                <span className={styles.permissionName}>
                  {permission.displayName || permission.key}
                </span>
                {permission.description ? (
                  <span className={styles.permissionWhat}>{permission.description}</span>
                ) : null}

                {/*
                  Only where the dimension applies. Most permissions do not
                  take one, and showing a disabled control on those rows would
                  imply a setting exists and is turned off.
                */}
                {takesScope(permission) ? (
                  <span
                    className={styles.permissionScoped}
                    data-testid={`scoped-${permission.key}`}
                  >
                    {t('catalog.scoped')}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
