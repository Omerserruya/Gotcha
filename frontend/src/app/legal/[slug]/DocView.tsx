"use client";

import Link from "next/link";
import { useMemo } from "react";
import { LegalBody, PlaceholderNotice, T, useLegalLocale } from "../LegalKit";
import { LEGAL_CONTENT } from "../content/generated";
import { PUBLIC_LEGAL_DOCS } from "../content/registry";

/** Section headings, for the sidebar. Read from the document so the contents
 *  list can never drift from what the document actually says. */
function headings(blocks: { kind: string; text?: string }[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.kind !== "markdown" || !b.text) continue;
    // exec loop rather than matchAll: this file compiles under an ES5-ish
    // target, where iterating the matchAll iterator needs downlevelIteration.
    const re = /^##\s+(.+)$/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(b.text)) !== null) out.push(m[1].trim());
  }
  return out;
}

export function DocView({ slug }: { slug: string }) {
  const { locale, he } = useLegalLocale();
  const doc = LEGAL_CONTENT[slug]?.[locale];
  const sections = useMemo(() => (doc ? headings(doc.blocks) : []), [doc]);

  if (!doc) return null;

  const others = PUBLIC_LEGAL_DOCS.filter((d) => d.slug !== slug);

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
      <nav className="mb-6 text-[12px] text-gray-400">
        <Link href="/legal" className="hover:text-gray-700">
          <T en="Trust Center" he="מרכז האמון" />
        </Link>
        <span className="mx-1.5">/</span>
        <span className="text-gray-600">{doc.title}</span>
      </nav>

      <div className="lg:flex lg:gap-12">
        <article className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold tracking-tight text-gray-900 sm:text-3xl">{doc.title}</h1>
          {doc.effectiveDate && (
            <p className="mt-2 text-[12px] text-gray-400">
              <T en="Effective" he="בתוקף מיום" /> {doc.effectiveDate}
            </p>
          )}

          <div className="mt-8">
            <PlaceholderNotice placeholders={doc.placeholders} />
            <LegalBody blocks={doc.blocks} />
          </div>

          <div className="mt-14 border-t border-gray-100 pt-6">
            <p className="text-[12px] font-medium text-gray-400">
              <T en="Other documents" he="מסמכים נוספים" />
            </p>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
              {others.map((d) => (
                <Link key={d.slug} href={`/legal/${d.slug}`} className="text-[13px] text-primary-600 hover:text-primary-700 hover:underline underline-offset-2">
                  {LEGAL_CONTENT[d.slug][locale].title}
                </Link>
              ))}
            </div>
          </div>
        </article>

        {sections.length > 2 && (
          <aside className="mt-12 hidden w-56 shrink-0 lg:mt-0 lg:block">
            <div className="sticky top-20">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                <T en="Contents" he="תוכן העניינים" />
              </p>
              <ol className="space-y-1.5 border-s border-gray-100 ps-3" dir={he ? "rtl" : "ltr"}>
                {sections.map((s) => (
                  <li key={s}>
                    <span className="block text-[12px] leading-snug text-gray-500">{s}</span>
                  </li>
                ))}
              </ol>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
