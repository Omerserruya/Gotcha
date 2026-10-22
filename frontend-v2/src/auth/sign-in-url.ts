/**
 * Where a sign-in URL's build is mounted: its path without the screen
 * (`https://auth-dev.gotcha.co.il/sign-in` → ``, `…/v2/sign-in` → `/v2`). A
 * whole URL is configured so this build need not guess the other's mount;
 * this reads it back.
 */
export function mountOf(signIn: URL): string {
  return signIn.pathname.replace(/\/sign-in\/?$/, '');
}

/**
 * The sign-in URL in the language of a path: `/he/inbox` → `…/he/sign-in`.
 * A language picked in the URL wins over `Accept-Language`, which decides
 * only when the path carries none. The proxy and the login route both send
 * people to sign-in; one rule, here, so they cannot disagree (dev: the
 * login route's hand-off landed /he/ visitors on /en/).
 */
export function inLocaleOf(
  signIn: URL,
  pathname: string,
  /** The app's own locales (`isLocale`): passed in, as auth reads no i18n. */
  isLocale: (value: unknown) => boolean,
): URL {
  const locale = /^\/([a-z]{2})(?:[/?#]|$)/.exec(pathname)?.[1];
  if (!isLocale(locale)) return signIn;
  const target = new URL(signIn);
  target.pathname = `${mountOf(signIn)}/${locale}/sign-in`;
  return target;
}
