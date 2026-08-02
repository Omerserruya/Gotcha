"use client";

import { ReactNode } from "react";
import Link from "next/link";
import { LanguageToggle, T, useLegalLocale } from "./LegalKit";
import { PUBLIC_LEGAL_DOCS } from "./content/registry";
import { LEGAL_CONTENT } from "./content/generated";

/** Public page: a plain link home, not the app nav (a visitor has no session). */
export function LegalShell({ children }: { children: ReactNode }) {
  const { locale, he } = useLegalLocale();

  return (
    <div dir={he ? "rtl" : "ltr"} lang={locale} className="min-h-screen bg-white flex flex-col">
      <header className="sticky top-0 z-30 border-b border-gray-100 bg-white/85 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Link href="/" className="flex items-center gap-2.5 shrink-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo_icon.png" alt="GOTCHA" className="h-6 w-auto" />
            <span className="text-[13px] font-semibold text-gray-900">
              <T en="Trust Center" he="מרכז האמון" />
            </span>
          </Link>
          <LanguageToggle />
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="mt-16 border-t border-gray-100 bg-gray-50/60">
        <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
          <nav className="flex flex-wrap gap-x-5 gap-y-2">
            {PUBLIC_LEGAL_DOCS.map((d) => (
              <Link
                key={d.slug}
                href={`/legal/${d.slug}`}
                className="text-[12px] text-gray-500 hover:text-gray-900"
              >
                {LEGAL_CONTENT[d.slug][locale].title}
              </Link>
            ))}
          </nav>
          <p className="mt-5 text-[12px] text-gray-400">
            <T
              en="Questions about these documents: "
              he="שאלות על המסמכים האלה: "
            />
            <a href="mailto:privacy@gotcha.co.il" className="text-gray-500 underline underline-offset-2" dir="ltr">
              privacy@gotcha.co.il
            </a>
          </p>
          <p className="mt-2 text-[12px] text-gray-400">
            &copy; {new Date().getFullYear()} GOTCHA
          </p>
        </div>
      </footer>
    </div>
  );
}
