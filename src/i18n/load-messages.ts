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

export async function loadMessages(locale: Locale): Promise<Messages> {
  const loaded = await Promise.all(
    NAMESPACES.map(
      async (namespace) => [namespace, await loadNamespace(locale, namespace)] as const,
    ),
  );
  return Object.fromEntries(loaded);
}
