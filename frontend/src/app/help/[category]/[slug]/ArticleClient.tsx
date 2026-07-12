"use client";

// Article page: breadcrumb, markdown body, category sidebar, prev/next,
// "was this helpful?" (stored locally), contact box.

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { findArticle } from "../../content";
import { CategoryIcon, Md, useHelpLocale } from "../../HelpKit";

export function ArticleClient() {
  const { he } = useHelpLocale();
  const params = useParams<{ category: string; slug: string }>();
  const hit = findArticle(String(params.category || ""), String(params.slug || ""));
  const [helpful, setHelpful] = useState<null | boolean>(null);

  if (!hit) {
    return (
      <div className="max-w-3xl mx-auto px-5 py-24 text-center">
        <h1 className="text-2xl font-bold text-gray-900">{he ? "המאמר לא נמצא" : "Article not found"}</h1>
        <Link href="/help" className="inline-block mt-4 text-primary-600 font-medium underline underline-offset-2">
          {he ? "חזרה למרכז העזרה" : "Back to the Help Center"}
        </Link>
      </div>
    );
  }

  const { category, article } = hit;
  const idx = category.articles.findIndex((a) => a.slug === article.slug);
  const prev = idx > 0 ? category.articles[idx - 1] : null;
  const next = idx < category.articles.length - 1 ? category.articles[idx + 1] : null;

  function vote(v: boolean) {
    setHelpful(v);
    try { localStorage.setItem(`help.vote.${category.slug}.${article.slug}`, v ? "1" : "0"); } catch { /* */ }
  }

  return (
    <div className="max-w-6xl mx-auto px-5 md:px-8 py-10">
      {/* Breadcrumb */}
      <nav className="text-xs text-gray-400 mb-8" aria-label="breadcrumb">
        <Link href="/help" className="hover:text-gray-600">{he ? "מרכז עזרה" : "Help Center"}</Link>
        <span className="mx-1.5">/</span>
        <Link href={`/help/${category.slug}`} className="hover:text-gray-600">{category.title[he ? 1 : 0]}</Link>
        <span className="mx-1.5">/</span>
        <span className="text-gray-600 font-medium">{article.title[he ? 1 : 0]}</span>
      </nav>

      <div className="grid lg:grid-cols-[1fr_260px] gap-12">
        {/* Article */}
        <article>
          <h1 className="text-3xl md:text-4xl font-bold text-gray-900 tracking-tight leading-[1.15] max-w-[26ch]">
            {article.title[he ? 1 : 0]}
          </h1>
          <p className="text-gray-500 mt-3 max-w-[65ch]">{article.excerpt[he ? 1 : 0]}</p>

          <div className="mt-8">
            <Md>{article.body[he ? 1 : 0]}</Md>
          </div>

          {/* Helpful */}
          <div className="mt-12 p-5 rounded-2xl border border-gray-150 bg-white shadow-subtle flex flex-col sm:flex-row sm:items-center gap-4">
            {helpful === null ? (
              <>
                <span className="text-sm font-semibold text-gray-800 flex-1">{he ? "המאמר הזה עזר?" : "Was this article helpful?"}</span>
                <div className="flex gap-2">
                  <button type="button" onClick={() => vote(true)} className="px-4 py-2 rounded-xl border border-gray-200 bg-white text-sm font-medium text-gray-700 hover:border-emerald-300 hover:text-emerald-700 transition">
                    {he ? "כן 👍" : "Yes 👍"}
                  </button>
                  <button type="button" onClick={() => vote(false)} className="px-4 py-2 rounded-xl border border-gray-200 bg-white text-sm font-medium text-gray-700 hover:border-amber-300 hover:text-amber-700 transition">
                    {he ? "לא ממש 👎" : "Not really 👎"}
                  </button>
                </div>
              </>
            ) : helpful ? (
              <span className="text-sm text-emerald-700 font-medium">{he ? "תודה! שמחים שעזרנו." : "Thanks! Glad it helped."}</span>
            ) : (
              <span className="text-sm text-gray-700">
                {he ? "תודה על המשוב — " : "Thanks for the feedback — "}
                <a href="mailto:support@gotcha.co.il" className="text-primary-600 font-medium underline underline-offset-2">
                  {he ? "ספרו לנו מה חסר" : "tell us what's missing"}
                </a>
              </span>
            )}
          </div>

          {/* Prev / next */}
          {(prev || next) && (
            <div className="mt-6 grid sm:grid-cols-2 gap-2.5">
              {prev ? (
                <Link href={`/help/${category.slug}/${prev.slug}`} className="px-4 py-3 rounded-2xl border border-gray-150 bg-white shadow-subtle hover:border-primary-300 transition">
                  <span className="block text-[11px] text-gray-400">{he ? "← הקודם" : "← Previous"}</span>
                  <span className="block text-sm font-semibold text-gray-900 truncate">{prev.title[he ? 1 : 0]}</span>
                </Link>
              ) : <span />}
              {next && (
                <Link href={`/help/${category.slug}/${next.slug}`} className="px-4 py-3 rounded-2xl border border-gray-150 bg-white shadow-subtle hover:border-primary-300 transition text-end">
                  <span className="block text-[11px] text-gray-400">{he ? "הבא →" : "Next →"}</span>
                  <span className="block text-sm font-semibold text-gray-900 truncate">{next.title[he ? 1 : 0]}</span>
                </Link>
              )}
            </div>
          )}
        </article>

        {/* Sidebar: this category's articles */}
        <aside className="hidden lg:block">
          <div className="sticky top-24">
            <Link href={`/help/${category.slug}`} className="flex items-center gap-2 mb-3">
              <CategoryIcon name={category.icon} size={15} className="text-gray-400" />
              <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-400">{category.title[he ? 1 : 0]}</span>
            </Link>
            <nav className="space-y-1">
              {category.articles.map((a) => (
                <Link
                  key={a.slug}
                  href={`/help/${category.slug}/${a.slug}`}
                  className={"block px-3 py-2 rounded-xl text-sm transition " + (a.slug === article.slug ? "bg-primary-50 text-primary-700 font-semibold" : "text-gray-600 hover:bg-gray-100")}
                >
                  {a.title[he ? 1 : 0]}
                </Link>
              ))}
            </nav>
          </div>
        </aside>
      </div>
    </div>
  );
}
