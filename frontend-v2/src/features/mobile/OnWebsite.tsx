import { getLocale } from 'next-intl/server';

import { appPath } from '@/lib/base-path';

import styles from './on-website.module.css';

/**
 * "Open on the website": the way to what the phone does not do - creating,
 * editing, the history.
 *
 * ★ A PLAIN `<a>`, NOT `Link`. The native shell opens any link outside `/m`
 *   in the system browser (`isAppPath`), and a full document load is what
 *   that needs; `Link` would keep it inside the app's router. Prefixed by
 *   hand for the same reason (`appPath`): `Link` would have done it for us.
 */
export async function OnWebsite({
  path,
  label,
  testId,
}: {
  /** A locale-less website path: `/outreach`, `/customers/<id>`. */
  readonly path: `/${string}`;
  readonly label: string;
  readonly testId?: string;
}) {
  const locale = await getLocale();
  return (
    <a
      href={appPath(`/${locale}${path}`)}
      className={styles.link}
      data-testid={testId ?? 'mobile-on-website'}
    >
      {label}
    </a>
  );
}
