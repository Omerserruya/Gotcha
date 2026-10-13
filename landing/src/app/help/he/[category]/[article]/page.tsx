import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import ArticleView from '../../../[category]/[article]/ArticleView';
import { HELP_CATEGORIES, findArticle } from '@/content/help';
import { HELP_ORIGIN } from '@/lib/seo';

/**
 * The Hebrew Help Center, as its own addresses.
 *
 * Every article already carries its Hebrew - the content files store `[en, he]`
 * pairs for the title, the excerpt, the keywords and the whole body - but the
 * route produced one file per article and the language was a client-side
 * toggle. So 31 translated articles were invisible to anyone searching in
 * Hebrew, which is most of the audience.
 *
 * Additive: the English articles keep their existing addresses.
 */

export const dynamicParams = false;

export function generateStaticParams() {
  return HELP_CATEGORIES.flatMap((c) =>
    c.articles.map((a) => ({ category: c.slug, article: a.slug })),
  );
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
    // Index 1 is the Hebrew half of every `[en, he]` pair.
    title: `${found.article.title[1]} | GOTCHA Help`,
    description: found.article.excerpt[1] ?? found.article.excerpt[0],
    keywords: found.article.keywords,
    alternates: {
      canonical: `${HELP_ORIGIN}/he/${path}`,
      languages: {
        en: `${HELP_ORIGIN}/${path}`,
        he: `${HELP_ORIGIN}/he/${path}`,
        'x-default': `${HELP_ORIGIN}/${path}`,
      },
    },
  };
}

export default function Page({
  params,
}: {
  params: { category: string; article: string };
}) {
  const found = findArticle(params.category, params.article);
  if (!found) notFound();
  return <ArticleView category={found.category} article={found.article} pinned="he" />;
}
