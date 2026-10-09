import { DEFAULT_LOCALE, type Locale } from './locales';
import { NAMESPACES, type Namespace } from './namespaces';

type Messages = Record<string, unknown>;

/**
 * Assembles a locale's messages from its per-namespace files.
 *
 * Each namespace falls back to the default locale independently. That matters
 * for a partially-translated language: a new Hebrew namespace that has not
 * been written yet renders in English rather than blanking the screen, and the
 * rest of Hebrew is unaffected.
 */
async function loadNamespace(locale: string, namespace: Namespace): Promise<Messages> {
  try {
    return (await import(`./messages/${locale}/${namespace}.json`)).default as Messages;
  } catch {
    if (locale === DEFAULT_LOCALE) return {};
    return loadNamespace(DEFAULT_LOCALE, namespace);
  }
}

/**
 * A locale's messages, optionally narrowed to the namespaces a surface needs.
 *
 * ★★ THE ARGUMENT IS WHAT KEEPS THE PRODUCT'S COPY OFF THE SIGN-IN PAGE.
 * `NextIntlClientProvider` serialises whatever it is given into the client
 * payload, so "all of them" is not a neutral default on a page nobody has
 * authenticated to reach - it published feature names, warnings and limits to
 * anyone who opened it. See `CREDENTIAL_SURFACE_NAMESPACES`.
 */
export async function loadMessages(
  locale: Locale,
  namespaces: readonly Namespace[] = NAMESPACES,
): Promise<Messages> {
  const loaded = await Promise.all(
    namespaces.map(
      async (namespace) => [namespace, await loadNamespace(locale, namespace)] as const,
    ),
  );
  return Object.fromEntries(loaded);
}
