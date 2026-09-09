import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import CategoryView from './CategoryView';
import { HELP_CATEGORIES, findCategory } from '@/content/help';

export const dynamicParams = false;

export function generateStaticParams() {
  return HELP_CATEGORIES.map((c) => ({ category: c.slug }));
}

export function generateMetadata({ params }: { params: { category: string } }): Metadata {
  const c = findCategory(params.category);
  return c ? { title: `${c.title[0]} | GOTCHA Help`, description: c.desc[0] } : {};
}

export default function Page({ params }: { params: { category: string } }) {
  const category = findCategory(params.category);
  if (!category) notFound();
  return <CategoryView category={category} />;
}
