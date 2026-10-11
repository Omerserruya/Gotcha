'use client';

import drawer from '@/design-system/styles/drawer.module.css';
import { LOCALES } from '@/i18n/locales';

import { useInterfaceLanguage } from './use-interface-language';

/**
 * 12d's "Interface language", in the viewer's OWN row only - the same switch
 * as the rail's account menu (`useInterfaceLanguage`): kept on the account,
 * then this page, drawer and all, reopened in it.
 *
 * Nobody else's: the language is personal, and the member API does not
 * serve anyone's locale anyway (auth permissions.ts, `/users` and
 * `/users/:userId` select no `locale`), so for anyone else the row is not
 * drawn rather than drawn with a guess.
 */
export function InterfaceLanguageSelect() {
  const { current, choose, isPending } = useInterfaceLanguage();

  return (
    <select
      className={drawer.box}
      value={current}
      disabled={isPending}
      data-testid="person-language-mine"
      onChange={(e) => choose(e.target.value)}
    >
      {LOCALES.map((entry) => (
        // Each named in itself, as in the account menu.
        <option key={entry.code} value={entry.code} lang={entry.code}>
          {entry.nativeName}
        </option>
      ))}
    </select>
  );
}
