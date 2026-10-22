'use client';

import { useTranslations } from 'next-intl';

import { MenuLabel, MenuRadioGroup, MenuRadioItem } from '@/design-system/primitives/overlay/Menu';
import { LOCALES } from '@/i18n/locales';

import { useInterfaceLanguage } from './use-interface-language';

/**
 * Language switching, inside the account menu - THE personal switch (Omer,
 * 2026-10-11: the interface language is personal, so it lives in the
 * person's own places, not in Settings > Workspace).
 *
 * The current language is checked (`menuitemradio`, `aria-checked`).
 * Choosing another keeps it on the account, then reopens this same page,
 * query and all, in it (`useInterfaceLanguage`). Direction follows from the
 * locale on `<html dir>`; nothing here knows about RTL, and nothing needs to.
 */
export function LocaleMenuItems() {
  const t = useTranslations('common.language');
  const { current, choose, isPending } = useInterfaceLanguage();

  return (
    <>
      <MenuLabel>{t('label')}</MenuLabel>
      <MenuRadioGroup value={current} onValueChange={choose}>
        {LOCALES.map((entry) => (
          <MenuRadioItem
            key={entry.code}
            value={entry.code}
            disabled={isPending}
            data-testid={`locale-${entry.code}`}
          >
            {/* Each language is named in itself, so a speaker can find theirs
                without being able to read the current interface language. */}
            <span lang={entry.code}>{entry.nativeName}</span>
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </>
  );
}
