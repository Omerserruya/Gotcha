'use client';

import { useTranslations } from 'next-intl';

import { signOut } from '@/auth/sign-out';
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
} from '@/design-system/primitives/overlay/Menu';
import { useTenant } from '@/tenant/tenant-context';

import styles from './AppShell.module.css';
import { LocaleMenuItems } from './LocaleMenuItems';

/**
 * Person and workspace, at the foot of the rail.
 *
 * The design puts identity here rather than in a top-right corner, because
 * there is no top bar to put it in - the frame is the chrome.
 *
 * Initials rather than a photo: the platform exposes no avatar contract, and
 * a broken image is worse than none. See docs/api-gaps.md.
 */
export function AccountControl({
  name,
  workspace,
}: {
  /** The person, from `/auth/me`; `null` when unread. */
  readonly name: string | null;
  /** The business's own name. */
  readonly workspace: string | null;
}) {
  const t = useTranslations('navigation');
  const { tenantId } = useTenant();
  const initials = name
    ? name
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map((w) => w[0]!.toUpperCase())
        .join('')
    : null;

  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" className={styles.account}>
          <span className={styles.avatar} aria-hidden="true">
            {initials ?? '··'}
          </span>
          <span className={styles.accountText}>
            <span className={styles.accountName}>{name ?? t('account.label')}</span>
            <span className={styles.accountWorkspace}>
              {/* The business's name; never its id - an id is not a name anybody knows. */}
              {workspace ?? (tenantId ? t('workspace.unnamed') : t('workspace.noneSelected'))}
            </span>
          </span>
        </button>
      </MenuTrigger>
      <MenuContent align="start" side="top">
        <LocaleMenuItems />
        <MenuSeparator />
        <MenuItem tone="danger" onSelect={() => void signOut()}>
          {t('account.signOut')}
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
