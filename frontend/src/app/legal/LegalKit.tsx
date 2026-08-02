"use client";

/**
 * Shared chrome for the Trust Center.
 *
 * Two constraints shape this file:
 *
 *  1. It is PUBLIC. A visitor arriving from the marketing footer has no token
 *     and no tenant, so nothing here may depend on I18nContext, AuthContext, or
 *     an /api call. Language is resolved locally.
 *  2. Both languages are first-class. Hebrew is the authoritative version of
 *     every document, and Hebrew is RTL, so layout uses logical properties
 *     (ps/pe/start/end) throughout rather than left/right. A document's `dir`
 *     follows the document, not the browser.
 */

import { ReactNode, createContext, useContext, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import type { LegalBlock } from "./content/generated";
import { LegalLocale, isLegalLocale } from "./content/types";

// ─── Language ───────────────────────────────────────────────

interface LegalLocaleState {
  locale: LegalLocale;
  setLocale: (l: LegalLocale) => void;
  he: boolean;
}

const LegalLocaleContext = createContext<LegalLocaleState>({
  locale: "he",
  setLocale: () => {},
  he: true,
});

export const useLegalLocale = () => useContext(LegalLocaleContext);

/** Pick from `?lang=`, then this section's own choice, then whatever the rest of
 *  the app last used. Defaults to Hebrew: GOTCHA is an Israeli company and the
 *  Hebrew documents are the governing ones. */
function initialLocale(): LegalLocale {
  if (typeof window === "undefined") return "he";
  try {
    const q = new URLSearchParams(window.location.search).get("lang");
    if (isLegalLocale(q)) return q;
    const own = window.localStorage.getItem("legal.locale");
    if (isLegalLocale(own)) return own;
    const app = window.localStorage.getItem("locale");
    if (isLegalLocale(app)) return app;
  } catch {
    /* storage unavailable, fall through to the default */
  }
  return "he";
}

export function LegalLocaleProvider({ children }: { children: ReactNode }) {
  // Server and first client render must agree, so the stored choice is adopted
  // in an effect rather than during render.
  const [locale, setLocaleState] = useState<LegalLocale>("he");
  useEffect(() => setLocaleState(initialLocale()), []);

  const value = useMemo<LegalLocaleState>(
    () => ({
      locale,
      he: locale === "he",
      setLocale: (l) => {
        setLocaleState(l);
        try {
          window.localStorage.setItem("legal.locale", l);
        } catch {
          /* the choice just will not persist */
        }
      },
    }),
    [locale],
  );

  return <LegalLocaleContext.Provider value={value}>{children}</LegalLocaleContext.Provider>;
}

export function LanguageToggle() {
  const { locale, setLocale } = useLegalLocale();
  return (
    <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5" role="group" aria-label="Language">
      {(["he", "en"] as LegalLocale[]).map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => setLocale(l)}
          aria-pressed={locale === l}
          data-testid={`legal-lang-${l}`}
          className={
            "px-2.5 py-1 text-[11px] font-medium rounded-md transition " +
            (locale === l ? "bg-primary-50 text-primary-700" : "text-gray-500 hover:text-gray-800")
          }
        >
          {l === "he" ? "עברית" : "English"}
        </button>
      ))}
    </div>
  );
}

/** Bilingual literal, for chrome that is not part of a document. */
export function T({ en, he }: { en: string; he: string }) {
  return <>{useLegalLocale().he ? he : en}</>;
}

export function tx(isHe: boolean, en: string, he: string): string {
  return isHe ? he : en;
}

// ─── Document rendering ─────────────────────────────────────

/** Inline markdown for a table cell: bold and links, but never a block wrapper. */
function Cell({ text }: { text: string }) {
  return (
    <ReactMarkdown
      components={{
        p: ({ children }) => <>{children}</>,
        strong: ({ children }) => <strong className="font-semibold text-gray-900">{children}</strong>,
        a: ({ href, children }) => (
          <a href={href || "#"} className="text-primary-600 underline underline-offset-2" target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        ),
        code: ({ children }) => <code className="text-[12px]" dir="ltr">{children}</code>,
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

/**
 * Markdown tables are a GitHub extension that the installed renderer does not
 * support, so the build step parses them out and they arrive here as data. The
 * wrapper scrolls on its own: a four-column subprocessor table must not make the
 * whole page scroll sideways on a phone.
 */
function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="my-6 overflow-x-auto rounded-xl border border-gray-200">
      <table className="w-full min-w-[34rem] border-collapse text-[13px]">
        <thead>
          <tr className="bg-gray-50">
            {head.map((h, i) => (
              <th key={i} scope="col" className="px-3 py-2 text-start font-semibold text-gray-900 border-b border-gray-200 whitespace-nowrap">
                <Cell text={h} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r} className="border-b border-gray-100 last:border-0 align-top">
              {row.map((c, i) => (
                <td key={i} className="px-3 py-2 text-gray-600">
                  <Cell text={c} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Prose. No `prose` plugin classes: those bake in physical margins that break RTL. */
function Prose({ text }: { text: string }) {
  return (
    <ReactMarkdown
      components={{
        h2: ({ children }) => (
          <h2 className="text-lg font-bold text-gray-900 tracking-tight mt-10 mb-3 scroll-mt-24 first:mt-0">{children}</h2>
        ),
        h3: ({ children }) => <h3 className="text-[15px] font-semibold text-gray-900 mt-6 mb-2">{children}</h3>,
        p: ({ children }) => <p className="my-3 leading-[1.75]">{children}</p>,
        ul: ({ children }) => <ul className="list-disc ps-6 space-y-2 my-3">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal ps-6 space-y-2 my-3">{children}</ol>,
        li: ({ children }) => <li className="leading-[1.7]">{children}</li>,
        strong: ({ children }) => <strong className="font-semibold text-gray-900">{children}</strong>,
        em: ({ children }) => <em className="italic">{children}</em>,
        hr: () => <hr className="my-8 border-gray-100" />,
        blockquote: ({ children }) => (
          <blockquote className="my-5 rounded-e-xl border-s-4 border-primary-200 bg-primary-50/40 px-4 py-3 text-[13px] text-gray-600 [&>p]:my-0">
            {children}
          </blockquote>
        ),
        code: ({ children }) => (
          <code className="rounded bg-gray-100 px-1.5 py-0.5 text-[13px] text-gray-800" dir="ltr">{children}</code>
        ),
        a: ({ href, children }) => {
          const h = href || "#";
          if (h.startsWith("/")) {
            return (
              <Link href={h} className="text-primary-600 font-medium underline underline-offset-2 hover:text-primary-700">
                {children}
              </Link>
            );
          }
          const external = h.startsWith("http");
          return (
            <a
              href={h}
              className="text-primary-600 font-medium underline underline-offset-2 hover:text-primary-700"
              {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
            >
              {children}
            </a>
          );
        },
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

export function LegalBody({ blocks }: { blocks: LegalBlock[] }) {
  return (
    <div className="text-[14px] text-gray-600">
      {blocks.map((b, i) =>
        b.kind === "table" ? <Table key={i} head={b.head} rows={b.rows} /> : <Prose key={i} text={b.text} />,
      )}
    </div>
  );
}

/**
 * Shown when a document still contains bracketed fill-ins, such as the
 * operating entity's registered name. Publishing a contract with visible
 * placeholders and no warning invites a reader to treat a draft as executed
 * terms, so the draft state is stated rather than left to be noticed.
 */
export function PlaceholderNotice({ placeholders }: { placeholders: string[] }) {
  if (placeholders.length === 0) return null;
  return (
    <div
      data-testid="legal-placeholder-notice"
      className="mb-8 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-900"
    >
      <p className="font-semibold">
        <T en="Draft: pending company details" he="טיוטה: פרטי החברה טרם הושלמו" />
      </p>
      <p className="mt-1 text-amber-800">
        <T
          en="This document is published for review and still contains details to be completed:"
          he="מסמך זה מפורסם לעיון ועדיין כולל פרטים שיש להשלים:"
        />{" "}
        {placeholders.map((p) => `[${p}]`).join(", ")}
      </p>
    </div>
  );
}
