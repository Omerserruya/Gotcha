import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import ArticleView from './ArticleView';
import { HELP_CATEGORIES, findArticle } from '@/content/help';

export const dynamicParams = false;

export function generateStaticParams() {
  return HELP_CATEGORIES.flatMap((c) => c.articles.map((a) => ({ category: c.slug, article: a.slug })));
}

export function generateMetadata({
  params,
}: {
  params: { category: string; article: string };
}): Metadata {
  const found = findArticle(params.category, params.article);
  if (!found) return {};
  return { title: `${found.article.title[0]} | GOTCHA Help`, description: found.article.excerpt[0] };
}

export default function Page({ params }: { params: { category: string; article: string } }) {
  const found = findArticle(params.category, params.article);
  if (!found) notFound();
  return <ArticleView category={found.category} article={found.article} />;
}
