// Server wrapper: static export (prod) requires generateStaticParams - every
// article page is pre-rendered from the finite content set.
import { HELP_CATEGORIES } from "../../content";
import { ArticleClient } from "./ArticleClient";

export function generateStaticParams() {
  return HELP_CATEGORIES.flatMap((c) => c.articles.map((a) => ({ category: c.slug, slug: a.slug })));
}

export default function HelpArticlePage() {
  return <ArticleClient />;
}
