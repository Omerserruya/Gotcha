import { notFound } from 'next/navigation';
import Landing from '@/components/Landing';
import { ALL_PATHS, PAGE_BY_PATH } from '@/lib/pages';

export const dynamicParams = false;

export function generateStaticParams() {
  return ALL_PATHS.map((p) => ({ slug: p === '' ? [] : p.split('/') }));
}

export default function Page({ params }: { params: { slug?: string[] } }) {
  const path = (params.slug || []).join('/');
  const page = PAGE_BY_PATH[path];
  if (!page) notFound();
  return <Landing initialPage={page} />;
}
