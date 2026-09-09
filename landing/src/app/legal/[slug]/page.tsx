import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import DocView from './DocView';
import { PUBLIC_LEGAL_DOCS } from '@/content/legal-registry.mjs';
import { LEGAL_CONTENT } from '@/generated/legal';

export const dynamicParams = false;

export function generateStaticParams() {
  return PUBLIC_LEGAL_DOCS.map((d: any) => ({ slug: d.slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const doc = (LEGAL_CONTENT as any)[params.slug];
  const meta = PUBLIC_LEGAL_DOCS.find((d: any) => d.slug === params.slug);
  if (!doc || !meta) return {};
  return {
    title: `${doc.en.title} | GOTCHA`,
    description: meta.summary[0],
  };
}

export default function Page({ params }: { params: { slug: string } }) {
  const doc = (LEGAL_CONTENT as any)[params.slug];
  if (!doc) notFound();
  return <DocView slug={params.slug} en={doc.en} he={doc.he} />;
}
