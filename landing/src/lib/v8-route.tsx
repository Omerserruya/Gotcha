import type { Metadata } from 'next';
import V8Landing from '@/components/V8Landing';
import { pathFor, type Lang } from '@/lib/pages';
import { V8_PAGES, type V8Page } from '@/lib/v8-pages';

/**
 * What every v8 route exports: its canonical and hreflang addresses (the same
 * ones the older design's route gave this page), and the design's page in one
 * language. The route files under src/app/(v8) are one call each.
 */
export function v8Metadata(page: V8Page, lang: Lang): Metadata {
  const key = V8_PAGES[page].key;
  return {
    alternates: {
      canonical: pathFor(key, lang),
      languages: { en: pathFor(key, 'en'), he: pathFor(key, 'he') },
    },
  };
}

export function v8Page(page: V8Page, lang: Lang) {
  return function Page() {
    return <V8Landing page={page} lang={lang} />;
  };
}
