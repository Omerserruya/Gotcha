"use client";

// Help Center home: hero search, category quick-buttons, popular articles,
// FAQ accordion. Public and bilingual.

import { useState } from "react";
import Link from "next/link";
import { HELP_CATEGORIES, HELP_FAQS, popularArticles } from "./content";
import { CategoryIcon, HelpSearch, Md, useHelpLocale } from "./HelpKit";

export default function HelpHomePage() {
  const { he } = useHelpLocale();
  const popular = popularArticles();

  return (
    <div className="max-w-6xl mx-auto px-5 md:px-8">
      {/* Hero */}
      <section className="pt-14 pb-10 md:pt-20 md:pb-14 text-center">
        <h1 className="text-3xl md:text-5xl font-bold text-gray-900 tracking-tight leading-[1.1]">
          {he ? "איך אפשר לעזור?" : "How can we help?"}
        </h1>
        <p className="text-gray-500 mt-3 md:text-lg">
          {he ? "מדריכים, תשובות והגדרות ל-GOTCHA - הדור הבא של התקשורת עם הלקוחות." : "Guides, answers and setup for GOTCHA - the next generation of customer engagement."}
        </p>
        <div className="mt-7 flex justify-center">
          <HelpSearch big autoFocus />
        </div>
      </section>

      {/* Category quick buttons */}
      <section aria-label={he ? "קטגוריות" : "Categories"}>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {HELP_CATEGORIES.map((c) => (
            <Link
              key={c.slug}
              href={`/help/${c.slug}`}
              className="group flex items-start gap-4 p-5 rounded-2xl border border-gray-150 bg-white shadow-subtle hover:border-primary-300 hover:shadow-card transition"
            >
              <span className="w-11 h-11 rounded-2xl bg-primary-50 flex items-center justify-center shrink-0 group-hover:bg-primary-100 transition">
                <CategoryIcon name={c.icon} />
              </span>
              <span className="min-w-0">
                <span className="block font-semibold text-gray-900">{c.title[he ? 1 : 0]}</span>
                <span className="block text-sm text-gray-500 mt-0.5 leading-snug">{c.desc[he ? 1 : 0]}</span>
                <span className="block text-[11px] text-gray-400 mt-1.5">
                  {c.articles.length} {he ? "מאמרים" : "articles"}
                </span>
              </span>
            </Link>
          ))}
        </div>
      </section>

      {/* Popular articles */}
      <section className="mt-14">
        <h2 className="text-xl font-bold text-gray-900 tracking-tight mb-4">{he ? "מאמרים פופולריים" : "Popular articles"}</h2>
        <div className="grid md:grid-cols-2 gap-2.5">
          {popular.map(({ category, article }) => (
            <Link
              key={`${category.slug}/${article.slug}`}
              href={`/help/${category.slug}/${article.slug}`}
              className="flex items-center gap-3 px-4 py-3.5 rounded-2xl border border-gray-150 bg-white shadow-subtle hover:border-primary-300 transition"
            >
              <CategoryIcon name={category.icon} size={17} className="text-gray-400" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-gray-900 truncate">{article.title[he ? 1 : 0]}</span>
                <span className="block text-xs text-gray-400 truncate">{category.title[he ? 1 : 0]}</span>
              </span>
              <span className="text-gray-300">{he ? "←" : "→"}</span>
            </Link>
          ))}
        </div>
      </section>

      {/* FAQ */}
      <section className="mt-14 mb-16">
        <h2 className="text-xl font-bold text-gray-900 tracking-tight mb-4">{he ? "שאלות נפוצות" : "Frequently asked questions"}</h2>
        <div className="rounded-2xl border border-gray-150 bg-white shadow-subtle divide-y divide-gray-100">
          {HELP_FAQS.map((f, i) => (
            <FaqRow key={i} q={f.q[he ? 1 : 0]} a={f.a[he ? 1 : 0]} />
          ))}
        </div>
      </section>
    </div>
  );
}

function FaqRow({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-4 px-5 py-4 text-start hover:bg-gray-50/60 transition"
      >
        <span className="text-sm font-semibold text-gray-900">{q}</span>
        <span className={"text-gray-300 text-xs transition-transform " + (open ? "rotate-180" : "")}>▼</span>
      </button>
      {open && (
        <div className="px-5 pb-5 -mt-1 text-sm">
          <Md>{a}</Md>
        </div>
      )}
    </div>
  );
}
