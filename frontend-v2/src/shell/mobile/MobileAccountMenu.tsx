'use client';

import { EllipsisVertical } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { signOut } from '@/auth/sign-out';
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
} from '@/design-system/primitives/overlay/Menu';

import { LocaleMenuItems } from '../LocaleMenuItems';
import styles from './MobileBar.module.css';
import { browserPlugin, storePushToken, storedPushToken } from './native';
import { forgetPushDevice } from './push-actions';

/**
 * The phone's account menu: the language, the full website, signing out.
 *
 * ★★ SIGNING OUT FORGETS THIS PHONE FIRST. Otherwise the platform would go on
 *   sending this person's customers' messages to a phone that is now signed
 *   out, or handed to somebody else, and they would show on its lock screen.
 *   Best effort: a failed forget does not keep anybody signed in.
 */
export function MobileAccountMenu() {
  const t = useTranslations('mobile');
  const locale = useLocale();

  const openWebsite = () => {
    const url = `${window.location.origin}/${locale}/home`;
    const browser = browserPlugin();
    // The desktop site, a full document load: not a route of this app's router.
    if (browser === null) window.location.href = url;
    else void browser.open({ url });
  };

  const leave = async () => {
    const token = storedPushToken();
    if (token !== null) {
      await forgetPushDevice(token);
      storePushToken(null);
    }
    await signOut();
  };

  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          className={styles.iconButton}
          aria-label={t('account.menu')}
          data-testid="mobile-account"
        >
          <EllipsisVertical aria-hidden size={22} strokeWidth={2} />
        </button>
      </MenuTrigger>
      <MenuContent align="end" side="bottom">
        <LocaleMenuItems />
        <MenuSeparator />
        <MenuItem onSelect={openWebsite}>{t('account.website')}</MenuItem>
        <MenuSeparator />
        <MenuItem tone="danger" onSelect={() => void leave()}>
          {t('account.signOut')}
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
