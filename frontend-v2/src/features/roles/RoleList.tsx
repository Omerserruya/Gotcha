import { getTranslations } from 'next-intl/server';

import { Lock } from 'lucide-react';

import type { Member } from '@/api/contracts/people';
import { allowsEverything, isEditable, type Role } from '@/api/contracts/roles';
import { Link } from '@/i18n/navigation';

import { roleDescriptionOf, roleNameOf, type BuiltinWords } from './role-words';
import styles from './Roles.module.css';

/**
 * Screen 12b - the roles.
 *
 * ── WHAT A ROLE ALLOWS, WITHOUT THE AMOUNTS ──
 * The design describes each role in prose *"including money limits"*:
 * *"refunds up to ₪1,000"*, *"refunds up to ₪500"*.
 *
 * **`TenantRoleFeature` is `(roleId, feature)` and nothing else.** There is no
 * amount column anywhere - a role either grants `billing.refund` or it does
 * not. Writing "up to ₪1,000" on this screen would be inventing a limit that
 * nothing enforces, which is the same failure as the quiet hours: a number on
 * screen that no code path reads.
 *
 * So a role is described by **how many permissions it holds**, and the
 * built-in ones carry the sentence the platform itself uses for them. A
 * custom role gets no prose, because nobody wrote any.
 */
export async function RoleList({
  roles,
  members = null,
}: {
  readonly roles: readonly Role[];
  /** The roster, for 02's faces in PEOPLE; `null` when unread - then the count. */
  readonly members?: readonly Member[] | null;
}) {
  const t = await getTranslations('roles');
  // A built-in role in the reader's words; a custom one in its owner's.
  const words: BuiltinWords = (key, part) => t(`builtinRole.${key}.${part}`);
  const holders = (role: Role) =>
    (members ?? []).filter(
      (m) =>
        (m.roleId ?? null) === role.id ||
        (role.builtinKey !== null && (m.roleBuiltinKey ?? null) === role.builtinKey),
    );

  /*
    12b, measured: one white card - a mono head (ROLE · WHAT IT ALLOWS ·
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
              <span className={styles.name}>{roleNameOf(role, words)}</span>
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
              what it allows, counted - never invented from its permissions.
              A wildcard role says what it means: Owner holds one row, `*`, and
              counting it read "Allows one thing" under "everything".
            */}
            <span className={styles.colAllows} data-testid={`allows-${role.id}`}>
              {roleDescriptionOf(role, words) ??
                (allowsEverything(role)
                  ? t('allowsEverything')
                  : t('allows', { count: role.features.length }))}
            </span>

            <span className={styles.colPeople} data-testid={`members-${role.id}`}>
              {members !== null && holders(role).length > 0 ? (
                // 02: a face per person - initials, 26px; more than four, "+N".
                <span
                  className={styles.faces}
                  title={holders(role)
                    .map((m) => m.name ?? m.email ?? '')
                    .filter(Boolean)
                    .join(', ')}
                >
                  {holders(role)
                    .slice(0, 4)
                    .map((m) => (
                      <span key={m.id} className={styles.face} aria-hidden="true">
                        {initialsOf(m.name ?? m.email ?? '')}
                      </span>
                    ))}
                  {holders(role).length > 4 ? (
                    <span className={styles.faceMore}>+{holders(role).length - 4}</span>
                  ) : null}
                  <span className="srOnly">{t('members', { count: holders(role).length })}</span>
                </span>
              ) : role.memberCount > 0 ? (
                t('members', { count: role.memberCount })
              ) : (
                <span className={styles.nobody}>{t('noMembers')}</span>
              )}
            </span>

            {/*
              A built-in role can be copied but never edited - the route refuses
              it. A custom one opens in the 12c form, saved over it.
            */}
            <span className={styles.colAction} data-testid={`action-${role.id}`}>
              {isEditable(role) ? (
                <Link
                  href={`/settings/people/roles/edit/${encodeURIComponent(role.id)}`}
                  className={styles.actionLink}
                  data-testid={`edit-${role.id}`}
                >
                  {t('edit')}
                </Link>
              ) : (
                <Link
                  href={{ pathname: '/settings/people/roles/new', query: { from: role.id } }}
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

/** Two letters: the first of the first two words, or of an address's parts. */
function initialsOf(name: string): string {
  const words = name
    .trim()
    .split(/[\s@._-]+/)
    .filter(Boolean);
  return (
    words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? '?').slice(0, 2)
  ).toUpperCase();
}
