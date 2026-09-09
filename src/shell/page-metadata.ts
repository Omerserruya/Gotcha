import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

/**
 * Page titles.
 *
 * The tab title is user-facing text, so it is translated like any other
 * string - a Hebrew user should not read "Inbox" in their browser tab. It is
 * also the label that appears in browser history and in a bookmark, which is
 * the reason it names the page before the product: with a dozen GOTCHA tabs
 * open, "Inbox · GOTCHA" is distinguishable at a glance and "GOTCHA · Inbox"
 * is not.
 *
 * Each page exports `generateMetadata = pageMetadata('primary.inbox')`, so the
 * title comes from the same key the navigation uses and the two can never
 * drift apart.
 */
export function pageMetadata(labelKey: string, namespace = 'navigation') {
  return async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations(namespace);
    return { title: t(labelKey) };
  };
}
