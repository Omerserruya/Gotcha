import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import DocView from '../../[slug]/DocView';
import { PUBLIC_LEGAL_DOCS } from '@/content/legal-registry.mjs';
import { LEGAL_CONTENT } from '@/generated/legal';
import { TRUST_ORIGIN } from '@/lib/seo';

/**
 * The Hebrew Trust Center, as its own addresses.
 *
 * The Hebrew has been written all along - `LEGAL_CONTENT[slug].he` is a full
 * translation - but it had no URL. `DocView` was handed both languages and a
 * toggle switched between them on the client, which means every crawler that
 * ever visited saw only the English, and there was nothing to point a Hebrew
 * search result at.
 *
 * This route is ADDITIVE on purpose. The English documents keep the addresses
 * they have always had; nothing that is linked or indexed moves.
 */

export const dynamicParams = false;

export function generateStaticParams() {
  return PUBLIC_LEGAL_DOCS.map((d: any) => ({ slug: d.slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const doc = (LEGAL_CONTENT as any)[params.slug];
  const meta = PUBLIC_LEGAL_DOCS.find((d: any) => d.slug === params.slug);
  if (!doc || !meta) return {};
  return {
    // The HEBREW title and summary. This is the text a search result shows, and
    // serving the English here would have made the Hebrew page look English in
    // the one place it matters most.
    title: `${doc.he.title} | GOTCHA`,
    description: meta.summary[1] ?? meta.summary[0],
    alternates: {
      canonical: `${TRUST_ORIGIN}/he/${params.slug}`,
      languages: {
        en: `${TRUST_ORIGIN}/${params.slug}`,
        he: `${TRUST_ORIGIN}/he/${params.slug}`,
        'x-default': `${TRUST_ORIGIN}/${params.slug}`,
      },
    },
  };
}

export default function Page({ params }: { params: { slug: string } }) {
  const doc = (LEGAL_CONTENT as any)[params.slug];
  if (!doc) notFound();
  return <DocView slug={params.slug} en={doc.en} he={doc.he} pinned="he" />;
}
