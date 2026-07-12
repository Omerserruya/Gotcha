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

export const HELP_FAQS: HelpFaq[] = faqs;

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

// ─── Search ─────────────────────────────────────────────────
// Client-side scoring over BOTH languages (visitors mix Hebrew/English terms):
// title (×4) > keywords (×3) > excerpt (×2) > body (×1). Every query term must
// hit at least once, so multi-word queries narrow instead of widen.

export interface HelpSearchResult {
  category: HelpCategory;
  article: HelpArticle;
  score: number;
}

function countHits(haystack: string, term: string): number {
  if (!term) return 0;
  let count = 0;
  let idx = haystack.indexOf(term);
  while (idx !== -1 && count < 20) {
    count += 1;
    idx = haystack.indexOf(term, idx + term.length);
  }
  return count;
}

export function searchHelp(query: string, limit = 8): HelpSearchResult[] {
  const terms = query.toLowerCase().split(/\s+/).map((t) => t.trim()).filter((t) => t.length >= 2);
  if (!terms.length) return [];

  const results: HelpSearchResult[] = [];
  for (const category of HELP_CATEGORIES) {
    for (const article of category.articles) {
      const title = (article.title[0] + " " + article.title[1]).toLowerCase();
      const kw = article.keywords.join(" ").toLowerCase();
      const excerpt = (article.excerpt[0] + " " + article.excerpt[1]).toLowerCase();
      const body = (article.body[0] + " " + article.body[1]).toLowerCase();

      let score = 0;
      let allTermsHit = true;
      for (const term of terms) {
        const t = countHits(title, term) * 4 + countHits(kw, term) * 3 + countHits(excerpt, term) * 2 + Math.min(countHits(body, term), 5);
        if (t === 0) { allTermsHit = false; break; }
        score += t;
      }
      if (allTermsHit && score > 0) results.push({ category, article, score });
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}
