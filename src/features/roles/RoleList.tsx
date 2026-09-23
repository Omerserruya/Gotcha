import { getTranslations } from 'next-intl/server';

import { allowsEverything, isEditable, type Role } from '@/api/contracts/roles';

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

  return (
    <ul className={styles.roles} data-testid="role-list">
      {roles.map((role) => (
        <li
          key={role.id}
          className={styles.role}
          data-testid={`role-${role.id}`}
          data-builtin={role.isSystem ? 'yes' : 'no'}
        >
          <div className={styles.head}>
            <span className={styles.name}>{role.name}</span>
            {role.isSystem ? (
              <span className={styles.builtin} data-testid={`builtin-${role.id}`}>
                {t('builtin')}
              </span>
            ) : null}
          </div>

          {/*
            The platform's own words for a built-in role. A custom role has no
            description unless whoever made it wrote one, and inventing one
            from its permission list would read as a promise about behaviour.
          */}
          {role.description ? <p className={styles.description}>{role.description}</p> : null}

          {/*
            How much it allows, counted — never "up to ₪1,000", which has no
            column behind it.
          */}
          {/*
            A wildcard role says what it means; only a role without one gets a
            number. Owner holds exactly one feature row — `*` — so counting it
            rendered "Allows one thing" beneath "Full access to everything",
            and a reader comparing Owner's 1 to Admin's 58 concludes Owner is
            the narrower role. The row was counted without being read.
          */}
          <p className={styles.allows} data-testid={`allows-${role.id}`}>
            {allowsEverything(role)
              ? t('allowsEverything')
              : t('allows', { count: role.features.length })}
          </p>

          <p className={styles.members} data-testid={`members-${role.id}`}>
            {role.memberCount > 0 ? t('members', { count: role.memberCount }) : t('noMembers')}
          </p>

          {/*
            A built-in role can be copied but never edited — the route refuses
            it, so offering an edit control would be a button the server
            rejects.
          */}
          <p className={styles.action} data-testid={`action-${role.id}`}>
            {isEditable(role) ? t('action.editable') : t('action.copyOnly')}
          </p>
        </li>
      ))}
    </ul>
  );
}
