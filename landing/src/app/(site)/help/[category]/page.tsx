import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import CategoryView from './CategoryView';
import { HELP_CATEGORIES, findCategory } from '@/content/help';
import { HELP_ORIGIN } from '@/lib/seo';

export const dynamicParams = false;

export function generateStaticParams() {
  return HELP_CATEGORIES.map((c) => ({ category: c.slug }));
}

export function generateMetadata({ params }: { params: { category: string } }): Metadata {
  const c = findCategory(params.category);
  if (!c) return {};
  return {
    title: `${c.title[0]} | GOTCHA Help`,
    description: c.desc[0],
    alternates: {
      canonical: `${HELP_ORIGIN}/${params.category}`,
      languages: {
        en: `${HELP_ORIGIN}/${params.category}`,
        he: `${HELP_ORIGIN}/he/${params.category}`,
        'x-default': `${HELP_ORIGIN}/${params.category}`,
      },
    },
  };
}

export default function Page({ params }: { params: { category: string } }) {
  const category = findCategory(params.category);
  if (!category) notFound();
  return <CategoryView category={category} />;
}
