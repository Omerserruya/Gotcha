import { getLocale, getTranslations } from 'next-intl/server';

import { humaniseCode } from '@/api/contracts/capabilities';
import { groupByDomain, takesScope, type PermissionDef } from '@/api/contracts/permission-catalog';

import { areaName, permissionDescription, permissionName } from './permission-words';
import styles from './Roles.module.css';

/**
 * Screen 12c - what a role allows, as the catalogue.
 *
 * ── NOT THE DESIGN'S GRID, AND THE REASON IS A WRITE ──
 * The design draws one row per area with None/View/Edit/Manage. The platform
 * has `conversation:messages:read · reply · takeover · assign · close` -
 * **five independent keys, where the action is the level.**
 *
 * A four-way radio must pick one of four values to stand for five booleans,
 * so **saving an untouched role would drop whatever the levels cannot
 * express** - no error, no warning, and the role now differs from what its
 * owner believes. **A control that cannot represent a state the system can be
 * in will eventually be used to destroy that state.**
 *
 * ── EACH PERMISSION IN THE PLATFORM'S OWN WORDS ──
 * `displayName` and `description` come from the catalogue and are **not
 * re-worded here**. They are already written, and a second vocabulary is a
 * second thing to drift.
 *
 * ── AND SCOPE APPEARS ONLY WHERE IT APPLIES ──
 * `PermissionDef.scoped` is a boolean - whether the dimension applies at all.
 * A permission without it gets no scope marker, because a greyed control on a
 * row that has none is the same lie in miniature.
 */
export async function PermissionCatalog({
  permissions,
}: {
  readonly permissions: readonly PermissionDef[];
}) {
  const t = await getTranslations('roles');
  const locale = await getLocale();
  const domains = groupByDomain(permissions);
  // The catalogue is English only: names and areas in the role grid's own words.
  const word = (key: string) => (t.has(key as never) ? t(key as never) : null);
  const join = (row: string, action: string) => t('catalog.permissionName', { row, action });

  return (
    <div className={styles.catalog} data-testid="permission-catalog">
      {domains.map((group) => (
        <section
          key={group.domain}
          className={styles.domain}
          data-testid={`domain-${group.domain}`}
        >
          <h3 className={styles.domainHeading}>
            {areaName(group.domain, locale, word, humaniseCode(group.domain))}
          </h3>

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
                  {permissionName(permission, locale, word, join)}
                </span>
                {/* English only on the platform: shown in English, never under a Hebrew name. */}
                {permissionDescription(permission, locale) ? (
                  <span className={styles.permissionWhat}>
                    {permissionDescription(permission, locale)}
                  </span>
                ) : null}

                {/*
                  Only where the dimension applies. Most permissions do not
                  take one, and showing a disabled control on those rows would
                  imply a setting exists and is turned off.

                  ════════════════════════════════════════════════════════════
                  ★★ A MARKER, NOT A SENTENCE - THE SENTENCE IS ALREADY ON THE
                     PAGE, ONCE
                  ════════════════════════════════════════════════════════════
                  This read *"How far this reaches depends on the role's
                  setting"* under every scoped row, and a browser walk found it
                  repeated under twenty-plus of them. The page above the
                  catalogue already says it properly, once, in
                  `catalog.scopeIsPerRole`: "A role has one reach, and it
                  applies to everything the role does."

                  So the row no longer explains; it MARKS. An explanation
                  repeated per row is not emphasis - it becomes wallpaper, and
                  the reader stops seeing the rows it is attached to, which are
                  the ones it is trying to distinguish.

                  The marker still has to mean something on its own to somebody
                  who skipped the paragraph, which is why it is
                  "Limited by the role's reach" and not "Scoped".
                */}
                {takesScope(permission) ? (
                  <span
                    className={styles.permissionScoped}
                    data-testid={`scoped-${permission.key}`}
                  >
                    {t('catalog.scopedMark')}
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
