'use client';

import { useTranslations } from 'next-intl';
import { useTransition } from 'react';

import { MenuItem, MenuLabel } from '@/design-system/primitives/overlay/Menu';
import { LOCALES } from '@/i18n/locales';
import { usePathname, useRouter } from '@/i18n/navigation';

/**
 * Language switching, inside the account menu.
 *
 * Switching navigates to the same path under the new locale, so the user stays
 * where they were. Direction follows from the locale on `<html dir>`; nothing
 * here knows about RTL, and nothing needs to.
 */
export function LocaleMenuItems() {
  const t = useTranslations('common.language');
  const pathname = usePathname();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <>
      <MenuLabel>{t('label')}</MenuLabel>
      {LOCALES.map((entry) => (
        <MenuItem
          key={entry.code}
          disabled={isPending}
          onSelect={() => startTransition(() => router.replace(pathname, { locale: entry.code }))}
        >
          {/* Each language is named in itself, so a speaker can find theirs
              without being able to read the current interface language. */}
          <span lang={entry.code}>{entry.nativeName}</span>
        </MenuItem>
      ))}
    </>
  );
}
