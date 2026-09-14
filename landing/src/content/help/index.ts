import type { HelpArticle, HelpCategory, HelpFaq } from "./types";
import { gettingStarted } from "./getting-started";
import { channels } from "./channels";
import { aiEmployees } from "./ai-employees";
import { integrations } from "./integrations";
import { knowledge } from "./knowledge";
import { billing } from "./billing";
import { account, faqs } from "./account";

export type { HelpArticle, HelpCategory, HelpFaq } from "./types";

export const HELP_CATEGORIES: HelpCategory[] = [
  gettingStarted,
  channels,
  aiEmployees,
  integrations,
  knowledge,
  billing,
  account,
];

export function findCategory(slug: string): HelpCategory | undefined {
  return HELP_CATEGORIES.find((c) => c.slug === slug);
}

export function findArticle(categorySlug: string, articleSlug: string): { category: HelpCategory; article: HelpArticle } | undefined {
  const category = findCategory(categorySlug);
  const article = category?.articles.find((a) => a.slug === articleSlug);
  return category && article ? { category, article } : undefined;
}

export function popularArticles(): Array<{ category: HelpCategory; article: HelpArticle }> {
  const out: Array<{ category: HelpCategory; article: HelpArticle }> = [];
  for (const category of HELP_CATEGORIES) {
    for (const article of category.articles) if (article.popular) out.push({ category, article });
  }
  return out;
}
