"use client";

/**
 * Help Center building blocks: locale context (he default, persisted),
 * category icons, the search box, a RTL-safe markdown renderer, and the
 * page shell (header + footer). The help center is public - no auth,
 * no app chrome - and lives at /help (served as help.gotcha.co.il).
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import { searchHelp, type HelpSearchResult } from "./content";

// The Help Center is served from help.gotcha.co.il, so "Sign in" has to be an
// absolute URL to the APPLICATION host - a relative /login would resolve to
// help.gotcha.co.il/login, which is the Help Center's own 404. This used to be
// hardcoded to the Dev host, which sent every production visitor to Dev.
const APP_URL = (
  process.env.NEXT_PUBLIC_API_URL || "https://app.gotcha.co.il"
).replace(/\/+$/, "");

// ─── Locale ─────────────────────────────────────────────────

interface HelpLocaleState { he: boolean; toggle: () => void }
const HelpLocaleContext = createContext<HelpLocaleState>({ he: true, toggle: () => {} });
export const useHelpLocale = () => useContext(HelpLocaleContext);

export function HelpLocaleProvider({ children }: { children: ReactNode }) {
  const [he, setHe] = useState(true);
  useEffect(() => {
    try { const v = localStorage.getItem("help.locale"); if (v) setHe(v === "he"); } catch { /* */ }
  }, []);
  const value = useMemo<HelpLocaleState>(() => ({
    he,
    toggle: () => setHe((v) => { const next = !v; try { localStorage.setItem("help.locale", next ? "he" : "en"); } catch { /* */ } return next; }),
  }), [he]);
  return <HelpLocaleContext.Provider value={value}>{children}</HelpLocaleContext.Provider>;
}

export function L({ en, heText }: { en: string; heText: string }) {
  const { he } = useHelpLocale();
  return <>{he ? heText : en}</>;
}

// ─── Identity ───────────────────────────────────────────────

// The real brand mark - identical to the main landing page's Logo.
export function Wordmark({ className = "h-7 w-auto" }: { className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src="/logo_icon.png" alt="GOTCHA" className={className} />;
}

export function CategoryIcon({ name, size = 22, className = "text-primary-500" }: { name: string; size?: number; className?: string }) {
  const common = {
    width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
    className: className + " shrink-0",
  };
  switch (name) {
    case "rocket":
      return <svg {...common} aria-hidden><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" /><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" /><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" /><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" /></svg>;
    case "chat":
      return <svg {...common} aria-hidden><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" /></svg>;
    case "bot":
      return <svg {...common} aria-hidden><rect x="4" y="8" width="16" height="12" rx="3" /><path d="M12 8V4" /><circle cx="12" cy="3" r="1" /><path d="M9 13v1.5" /><path d="M15 13v1.5" /><path d="M9.5 17.5h5" /></svg>;
    case "plug":
      return <svg {...common} aria-hidden><path d="M12 22v-5" /><path d="M9 8V2" /><path d="M15 8V2" /><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z" /></svg>;
    case "book":
      return <svg {...common} aria-hidden><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" /></svg>;
    case "credit":
      return <svg {...common} aria-hidden><rect x="2" y="5" width="20" height="14" rx="2" /><line x1="2" y1="10" x2="22" y2="10" /><line x1="6" y1="15" x2="10" y2="15" /></svg>;
    case "users":
      return <svg {...common} aria-hidden><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>;
    default:
      return <svg {...common} aria-hidden><circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>;
  }
}

// ─── Search ─────────────────────────────────────────────────

export function HelpSearch({ big = false, autoFocus = false }: { big?: boolean; autoFocus?: boolean }) {
  const { he } = useHelpLocale();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const results: HelpSearchResult[] = useMemo(() => (q.trim().length >= 2 ? searchHelp(q) : []), [q]);

  useEffect(() => { setActive(0); setOpen(results.length > 0); }, [results.length, q]);
  useEffect(() => {
    const onClick = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, []);

  function go(r: HelpSearchResult) {
    setOpen(false);
    setQ("");
    router.push(`/help/${r.category.slug}/${r.article.slug}`);
  }

  return (
    <div ref={boxRef} className={"relative w-full " + (big ? "max-w-2xl" : "max-w-md")}>
      <div className={"flex items-center gap-3 bg-white border border-gray-200 shadow-subtle transition focus-within:border-primary-300 focus-within:ring-2 focus-within:ring-primary-100 " + (big ? "rounded-2xl px-5 py-4" : "rounded-xl px-4 py-2.5")}>
        <svg width={big ? 20 : 16} height={big ? 20 : 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className="text-gray-400 shrink-0" aria-hidden>
          <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => results.length && setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            else if (e.key === "Enter" && results[active]) go(results[active]!);
            else if (e.key === "Escape") setOpen(false);
          }}
          placeholder={he ? "חפשו תשובה… (למשל: וואטסאפ, קרדיטים, Drive)" : "Search for answers… (e.g. WhatsApp, credits, Drive)"}
          autoFocus={autoFocus}
          className={"flex-1 min-w-0 bg-transparent outline-none text-gray-900 placeholder-gray-400 " + (big ? "text-base" : "text-sm")}
          role="combobox"
          aria-expanded={open}
          aria-label={he ? "חיפוש במרכז העזרה" : "Search the help center"}
        />
      </div>

      {open && (
        <div className="absolute z-40 mt-2 inset-x-0 rounded-2xl border border-gray-150 bg-white shadow-float overflow-hidden" role="listbox">
          {results.map((r, i) => (
            <button
              key={`${r.category.slug}/${r.article.slug}`}
              type="button"
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onClick={() => go(r)}
              className={"w-full text-start px-4 py-3 border-b border-gray-50 last:border-0 transition " + (i === active ? "bg-primary-50/60" : "bg-white")}
            >
              <span className="block text-sm font-semibold text-gray-900">{r.article.title[he ? 1 : 0]}</span>
              <span className="block text-xs text-gray-500 mt-0.5 truncate">
                {r.category.title[he ? 1 : 0]} · {r.article.excerpt[he ? 1 : 0]}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Markdown (RTL-safe, no `prose` - logical paddings) ─────

export function Md({ children }: { children: string }) {
  return (
    <div className="text-[15px] leading-relaxed text-gray-700 space-y-4 max-w-[70ch]">
      <ReactMarkdown
        components={{
          h2: ({ children }) => <h2 className="text-xl font-bold text-gray-900 tracking-tight mt-8 first:mt-0">{children}</h2>,
          h3: ({ children }) => <h3 className="text-base font-semibold text-gray-900 mt-6">{children}</h3>,
          p: ({ children }) => <p>{children}</p>,
          ul: ({ children }) => <ul className="list-disc ps-6 space-y-1.5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal ps-6 space-y-1.5">{children}</ol>,
          li: ({ children }) => <li>{children}</li>,
          strong: ({ children }) => <strong className="font-semibold text-gray-900">{children}</strong>,
          code: ({ children }) => <code className="px-1.5 py-0.5 rounded-md bg-gray-100 text-[13px] text-gray-800" dir="ltr">{children}</code>,
          blockquote: ({ children }) => (
            <blockquote className="border-s-4 border-primary-200 bg-primary-50/40 rounded-e-xl px-4 py-3 [&>p]:m-0 text-gray-700">{children}</blockquote>
          ),
          a: ({ href, children }) => {
            const h = href || "#";
            if (h.startsWith("/")) return <Link href={h} className="text-primary-600 font-medium underline underline-offset-2 hover:text-primary-700">{children}</Link>;
            return <a href={h} target="_blank" rel="noopener noreferrer" className="text-primary-600 font-medium underline underline-offset-2 hover:text-primary-700">{children}</a>;
          },
          hr: () => <hr className="border-gray-100 my-6" />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

// ─── Shell ──────────────────────────────────────────────────

export function HelpShell({ children }: { children: ReactNode }) {
  const { he, toggle } = useHelpLocale();
  return (
    <div className="min-h-screen bg-[#fafafa] flex flex-col" dir={he ? "rtl" : "ltr"}>
      <header className="sticky top-0 z-30 bg-[#fafafa]/90 backdrop-blur border-b border-gray-100">
        <div className="max-w-6xl mx-auto px-5 md:px-8 h-16 flex items-center gap-4">
          <Link href="/help" className="flex items-center gap-2.5 shrink-0">
            <Wordmark />
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-400 mt-0.5">{he ? "מרכז עזרה" : "Help Center"}</span>
          </Link>
          <div className="flex-1 hidden md:flex justify-center"><HelpSearch /></div>
          <div className="flex items-center gap-3 shrink-0">
            <button type="button" onClick={toggle} className="text-xs font-semibold text-gray-500 hover:text-gray-800 px-2 py-1 rounded-lg hover:bg-gray-100 transition">
              {he ? "EN" : "עברית"}
            </button>
            <a href="https://gotcha.co.il" className="hidden sm:block text-xs font-semibold text-gray-500 hover:text-gray-800">gotcha.co.il</a>
            <a href={`${APP_URL}/login`} className="text-xs font-semibold px-3.5 py-2 rounded-xl bg-primary-500 text-white hover:bg-primary-600 transition shadow-subtle">
              {he ? "כניסה" : "Sign in"}
            </a>
          </div>
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <footer id="contact" className="border-t border-gray-100 bg-white">
        <div className="max-w-6xl mx-auto px-5 md:px-8 py-10 flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
          <div>
            <p className="font-semibold text-gray-900">{he ? "לא מצאתם תשובה?" : "Didn't find your answer?"}</p>
            <p className="text-sm text-gray-500 mt-1">{he ? "בן אדם אמיתי קורא כל הודעה - בדרך כלל עונים תוך שעות." : "A real human reads every message - we usually reply within hours."}</p>
          </div>
          <a href="mailto:support@gotcha.co.il" className="inline-flex items-center gap-2 px-5 py-3 rounded-2xl bg-gray-900 text-white text-sm font-semibold hover:bg-gray-800 transition">
            support@gotcha.co.il
          </a>
        </div>
        <div className="max-w-6xl mx-auto px-5 md:px-8 pb-8 flex items-center gap-2.5 text-[11px] text-gray-400">
          <Wordmark className="h-4 w-auto opacity-70" />
          <span>{he ? "בונים את עתיד התקשורת עם הלקוחות." : "Building the future of customer communication."}</span>
        </div>
      </footer>
    </div>
  );
}
