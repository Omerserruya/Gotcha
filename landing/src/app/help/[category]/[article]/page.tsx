import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import ArticleView from './ArticleView';
import { HELP_CATEGORIES, findArticle } from '@/content/help';
import { HELP_ORIGIN } from '@/lib/seo';

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
  const path = `${params.category}/${params.article}`;
  return {
    title: `${found.article.title[0]} | GOTCHA Help`,
    description: found.article.excerpt[0],
    keywords: found.article.keywords,
    alternates: {
      // The Help Center serves this page at /<path> and, for apex-shaped links,
      // also at /help/<path>. Naming one of them settles which is the page.
      canonical: `${HELP_ORIGIN}/${path}`,
      languages: {
        en: `${HELP_ORIGIN}/${path}`,
        he: `${HELP_ORIGIN}/he/${path}`,
        'x-default': `${HELP_ORIGIN}/${path}`,
      },
    },
  };
}

export default function Page({ params }: { params: { category: string; article: string } }) {
  const found = findArticle(params.category, params.article);
  if (!found) notFound();
  return <ArticleView category={found.category} article={found.article} />;
}
