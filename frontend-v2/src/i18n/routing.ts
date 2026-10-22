import { defineRouting } from 'next-intl/routing';

import { DEFAULT_LOCALE, LOCALE_CODES } from './locales';

/**
 * The locale lives in the URL (`/en/inbox`, `/he/inbox`).
 *
 * A cookie alone would make a shared link render in the sharer's language, and
 * would make a page's language invisible to caches and crawlers. `always`
 * rather than `as-needed` so that every URL states its language explicitly and
 * there is no privileged, unprefixed language.
 */
export const routing = defineRouting({
  locales: LOCALE_CODES,
  defaultLocale: DEFAULT_LOCALE,
  localePrefix: 'always',
  localeDetection: true,
});
