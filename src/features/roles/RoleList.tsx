import { getTranslations } from 'next-intl/server';

import { Lock } from 'lucide-react';

import { allowsEverything, isEditable, type Role } from '@/api/contracts/roles';
import { Link } from '@/i18n/navigation';

import styles from './Roles.module.css';

/**
 * Screen 12b — the roles.
 *
 * ── WHAT A ROLE ALLOWS, WITHOUT THE AMOUNTS ──
 * The design describes each role in prose *"including money limits"*:
 * *"refunds up to ₪1,000"*, *"refunds up to ₪500"*.
 *
 * **`TenantRoleFeature` is `(roleId, feature)` and nothing else.** There is no
 * amount column anywhere — a role either grants `billing.refund` or it does
 * not. Writing "up to ₪1,000" on this screen would be inventing a limit that
 * nothing enforces, which is the same failure as the quiet hours: a number on
 * screen that no code path reads.
 *
 * So a role is described by **how many permissions it holds**, and the
 * built-in ones carry the sentence the platform itself uses for them. A
 * custom role gets no prose, because nobody wrote any.
 */
export async function RoleList({ roles }: { readonly roles: readonly Role[] }) {
  const t = await getTranslations('roles');

  /*
    12b, measured: one white card — a mono head (ROLE · WHAT IT ALLOWS ·
    PEOPLE), then a row per role: its name over "Built in" (a lock) or
    "Custom"; what it allows; who holds it; and its action at the end.
  */
  return (
    <section className={styles.table} data-testid="role-list">
      <div className={styles.tableHead} aria-hidden="true">
        <span className={styles.colRole}>{t('table.role')}</span>
        <span className={styles.colAllows}>{t('table.allows')}</span>
        <span className={styles.colPeople}>{t('table.people')}</span>
        <span className={styles.colAction} />
      </div>
      <ul className={styles.rows}>
        {roles.map((role) => (
          <li
            key={role.id}
            className={styles.row}
            data-testid={`role-${role.id}`}
            data-builtin={role.isSystem ? 'yes' : 'no'}
          >
            <span className={styles.colRole}>
              <span className={styles.name}>{role.name}</span>
              {role.isSystem ? (
                <span className={styles.kind} data-testid={`builtin-${role.id}`}>
                  <Lock size={11} aria-hidden="true" />
                  {t('builtin')}
                </span>
              ) : (
                // No creator is recorded, so "Custom", never "Custom · by Maya".
                <span className={styles.kind}>{t('custom')}</span>
              )}
            </span>

            {/*
              The platform's own words for a built-in role; a custom one shows
              what it allows, counted — never invented from its permissions.
              A wildcard role says what it means: Owner holds one row, `*`, and
              counting it read "Allows one thing" under "everything".
            */}
            <span className={styles.colAllows} data-testid={`allows-${role.id}`}>
              {role.description ??
                (allowsEverything(role)
                  ? t('allowsEverything')
                  : t('allows', { count: role.features.length }))}
            </span>

            <span className={styles.colPeople} data-testid={`members-${role.id}`}>
              {role.memberCount > 0 ? (
                t('members', { count: role.memberCount })
              ) : (
                <span className={styles.nobody}>{t('noMembers')}</span>
              )}
            </span>

            {/*
              A built-in role can be copied but never edited — the route refuses
              it. A custom one could be edited, but nothing edits a role from
              here yet: drawn, and it says so.
            */}
            <span className={styles.colAction} data-testid={`action-${role.id}`}>
              {isEditable(role) ? (
                <span className={styles.actionQuiet} aria-disabled="true" title={t('editNotYet')}>
                  {t('edit')}
                </span>
              ) : (
                <Link
                  href={{
                    pathname: '/settings/people/roles',
                    query: { create: '1', from: role.id },
                  }}
                  className={styles.actionLink}
                >
                  {t('duplicate')}
                </Link>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
