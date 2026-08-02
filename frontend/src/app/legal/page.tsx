"use client";

import Link from "next/link";
import { T, tx, useLegalLocale } from "./LegalKit";
import { PUBLIC_LEGAL_DOCS, LegalDocMeta } from "./content/registry";
import { LEGAL_CONTENT } from "./content/generated";

function Icon({ name }: { name: LegalDocMeta["icon"] }) {
  const p = {
    width: 20,
    height: 20,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (name) {
    case "scroll":
      return <svg {...p}><path d="M8 3h9a2 2 0 0 1 2 2v13a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V6" /><path d="M4 6a2 2 0 0 1 2-2h2v4H4z" /><path d="M9 9h6M9 13h6M9 17h4" /></svg>;
    case "shield":
      return <svg {...p}><path d="M12 3l7 3v5c0 4.5-2.9 8.4-7 10-4.1-1.6-7-5.5-7-10V6z" /><path d="m9 12 2 2 4-4" /></svg>;
    case "cookie":
      return <svg {...p}><path d="M12 3a9 9 0 1 0 9 9 3.5 3.5 0 0 1-4.5-4.5A3.5 3.5 0 0 1 12 3z" /><path d="M9 10h.01M13 14h.01M8.5 15h.01M15 9.5h.01" /></svg>;
    case "handshake":
      return <svg {...p}><path d="m11 17 2 2a1.4 1.4 0 0 0 2-2l-3-3" /><path d="M3 11l4-4 3 3-4 4z" /><path d="M14 7h3l4 4-3 3" /><path d="M10 10l3 3" /></svg>;
    default:
      return <svg {...p}><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01" /></svg>;
  }
}

export default function TrustCenterPage() {
  const { locale, he } = useLegalLocale();

  return (
    <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6 sm:py-16">
      <header className="max-w-2xl">
        <p className="text-[12px] font-semibold uppercase tracking-wider text-primary-600">
          <T en="Trust Center" he="מרכז האמון" />
        </p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl">
          <T en="How we handle your data" he="כיצד אנו מטפלים במידע שלכם" />
        </h1>
        <p className="mt-4 text-[15px] leading-relaxed text-gray-500">
          <T
            en="Everything that governs your use of GOTCHA and our handling of personal data, in one place. Every document is published in Hebrew and English."
            he="כל מה שמסדיר את השימוש שלכם ב-GOTCHA ואת הטיפול שלנו במידע אישי, במקום אחד. כל מסמך מתפרסם בעברית ובאנגלית."
          />
        </p>
      </header>

      {/* Facts a reader usually came to check, without opening a document. */}
      <dl className="mt-10 grid gap-px overflow-hidden rounded-xl border border-gray-200 bg-gray-200 sm:grid-cols-3">
        {[
          {
            k: tx(he, "Data residency", "מיקום אחסון המידע"),
            v: tx(he, "AWS il-central-1 (Israel)", "AWS il-central-1 (ישראל)"),
          },
          {
            k: tx(he, "Our role", "התפקיד שלנו"),
            v: tx(he, "Processor for your customer data", "מעבד עבור נתוני הלקוחות שלכם"),
          },
          {
            k: tx(he, "Privacy contact", "איש קשר לפרטיות"),
            v: "privacy@gotcha.co.il",
          },
        ].map((f) => (
          <div key={f.k} className="bg-white px-4 py-4">
            <dt className="text-[11px] font-medium uppercase tracking-wide text-gray-400">{f.k}</dt>
            <dd className="mt-1 text-[13px] font-semibold text-gray-900" dir={f.v.includes("@") ? "ltr" : undefined} style={{ textAlign: "start" }}>
              {f.v}
            </dd>
          </div>
        ))}
      </dl>

      <ul className="mt-10 grid gap-3 sm:grid-cols-2">
        {PUBLIC_LEGAL_DOCS.map((d) => {
          const doc = LEGAL_CONTENT[d.slug][locale];
          return (
            <li key={d.slug}>
              <Link
                href={`/legal/${d.slug}`}
                data-testid={`legal-card-${d.slug}`}
                className="group flex h-full gap-3.5 rounded-xl border border-gray-200 bg-white p-4 transition hover:border-primary-300 hover:shadow-sm"
              >
                <span className="mt-0.5 shrink-0 text-primary-500">
                  <Icon name={d.icon} />
                </span>
                <span className="min-w-0">
                  <span className="block text-[14px] font-semibold text-gray-900 group-hover:text-primary-700">
                    {doc.title}
                  </span>
                  <span className="mt-1 block text-[12.5px] leading-relaxed text-gray-500">
                    {he ? d.summary[1] : d.summary[0]}
                  </span>
                  {doc.effectiveDate && (
                    <span className="mt-2 block text-[11px] text-gray-400">
                      <T en="Effective" he="בתוקף מיום" /> {doc.effectiveDate}
                    </span>
                  )}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>

      <section className="mt-12 rounded-xl border border-gray-200 bg-gray-50/60 p-5">
        <h2 className="text-[14px] font-semibold text-gray-900">
          <T en="Exercising your rights" he="מימוש הזכויות שלכם" />
        </h2>
        <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-gray-500">
          <T
            en="If you are a customer of a business that uses GOTCHA, that business controls your data and your request should go to them. We assist them in fulfilling it. For data we control ourselves, write to us directly."
            he="אם אתם לקוחות של עסק המשתמש ב-GOTCHA, אותו עסק הוא בעל השליטה במידע שלכם ויש לפנות אליו. אנו מסייעים לו במימוש הבקשה. לגבי מידע שאנו עצמנו בעלי השליטה בו, ניתן לפנות אלינו ישירות."
          />
        </p>
        <a
          href="mailto:privacy@gotcha.co.il"
          className="mt-3 inline-block text-[13px] font-medium text-primary-600 underline underline-offset-2 hover:text-primary-700"
          dir="ltr"
        >
          privacy@gotcha.co.il
        </a>
      </section>
    </div>
  );
}
