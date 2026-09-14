import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import Landing from '@/components/Landing';
import { ALL_LOCALISED_PATHS, parsePath, pathFor } from '@/lib/pages';

export const dynamicParams = false;

export function generateStaticParams() {
  return ALL_LOCALISED_PATHS.map((p) => ({ slug: p === '' ? [] : p.split('/') }));
}

/**
 * Hebrew is a real address, not a toggle.
 *
 * The design keeps both languages in one bundle and switches them from the
 * footer, so the whole site was one URL that happened to load in English.
 * Nothing could be sent: a link to the offer page opened in English for the
 * person who received it, whichever language the sender was reading.
 *
 * Every page therefore has a second path under /he, prerendered in Hebrew, so
 * the first paint is already right and the link describes what it opens.
 */
export function generateMetadata({ params }: { params: { slug?: string[] } }): Metadata {
  const found = parsePath('/' + (params.slug || []).join('/'));
  if (!found) return {};
  return {
    alternates: {
      canonical: pathFor(found.page, found.lang),
      languages: {
        en: pathFor(found.page, 'en'),
        he: pathFor(found.page, 'he'),
      },
    },
  };
}

export default function Page({ params }: { params: { slug?: string[] } }) {
  const found = parsePath('/' + (params.slug || []).join('/'));
  if (!found) notFound();
  return <Landing initialPage={found.page} initialLang={found.lang} />;
}
