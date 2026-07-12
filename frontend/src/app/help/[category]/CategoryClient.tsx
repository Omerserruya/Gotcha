"use client";

// Category page: the category's articles + a sidebar of all categories.

import Link from "next/link";
import { useParams } from "next/navigation";
import { HELP_CATEGORIES, findCategory } from "../content";
import { CategoryIcon, useHelpLocale } from "../HelpKit";

export function CategoryClient() {
  const { he } = useHelpLocale();
  const params = useParams<{ category: string }>();
  const category = findCategory(String(params.category || ""));

  if (!category) {
    return (
      <div className="max-w-3xl mx-auto px-5 py-24 text-center">
        <h1 className="text-2xl font-bold text-gray-900">{he ? "הקטגוריה לא נמצאה" : "Category not found"}</h1>
        <Link href="/help" className="inline-block mt-4 text-primary-600 font-medium underline underline-offset-2">
          {he ? "חזרה למרכז העזרה" : "Back to the Help Center"}
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-5 md:px-8 py-10">
      {/* Breadcrumb */}
      <nav className="text-xs text-gray-400 mb-6" aria-label="breadcrumb">
        <Link href="/help" className="hover:text-gray-600">{he ? "מרכז עזרה" : "Help Center"}</Link>
        <span className="mx-1.5">/</span>
        <span className="text-gray-600 font-medium">{category.title[he ? 1 : 0]}</span>
      </nav>

      <div className="grid lg:grid-cols-[240px_1fr] gap-10">
        {/* Sidebar: all categories */}
        <aside className="hidden lg:block">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-400 mb-3">{he ? "קטגוריות" : "Categories"}</p>
          <nav className="space-y-1">
            {HELP_CATEGORIES.map((c) => (
              <Link
                key={c.slug}
                href={`/help/${c.slug}`}
                className={"flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm transition " + (c.slug === category.slug ? "bg-primary-50 text-primary-700 font-semibold" : "text-gray-600 hover:bg-gray-100")}
              >
                <CategoryIcon name={c.icon} size={15} className={c.slug === category.slug ? "text-primary-500" : "text-gray-400"} />
                {c.title[he ? 1 : 0]}
              </Link>
            ))}
          </nav>
        </aside>

        {/* Article list */}
        <div>
          <div className="flex items-center gap-4 mb-2">
            <span className="w-12 h-12 rounded-2xl bg-primary-50 flex items-center justify-center shrink-0">
              <CategoryIcon name={category.icon} size={24} />
            </span>
            <div>
              <h1 className="text-2xl md:text-3xl font-bold text-gray-900 tracking-tight">{category.title[he ? 1 : 0]}</h1>
              <p className="text-gray-500 text-sm mt-0.5">{category.desc[he ? 1 : 0]}</p>
            </div>
          </div>

          <div className="mt-6 rounded-2xl border border-gray-150 bg-white shadow-subtle divide-y divide-gray-100">
            {category.articles.map((a) => (
              <Link key={a.slug} href={`/help/${category.slug}/${a.slug}`} className="flex items-center gap-4 px-5 py-4 hover:bg-gray-50/60 transition group">
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold text-gray-900 group-hover:text-primary-700 transition">{a.title[he ? 1 : 0]}</span>
                  <span className="block text-sm text-gray-500 mt-0.5">{a.excerpt[he ? 1 : 0]}</span>
                </span>
                <span className="text-gray-300 shrink-0">{he ? "←" : "→"}</span>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
