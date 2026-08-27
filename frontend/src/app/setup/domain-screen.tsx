"use client";

/**
 * Movement 1a - "Where does your business live online?" - extracted from
 * setup/page.tsx, following the same reasoning as connect-screen.tsx:
 * page.tsx may only export the route component, so a separate module is what
 * lets vitest render this screen directly.
 *
 * This is the first thing a customer touches, which is why the Terms and
 * Privacy Policy are accepted here. Setup used to skip this screen entirely
 * whenever a domain could be guessed from the sign-up email; it no longer can,
 * because a consent step most customers never see is not a consent step. The
 * guess still does its job - it arrives pre-filled, so this stays a
 * confirmation rather than a question.
 */

import { useState } from "react";

function Wordmark({ className = "h-7 w-auto" }: { className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src="/logo_icon.png" alt="GOTCHA" className={className} />;
}

export function DomainScreen({ he, domain, setDomain, onScan, error }: { he: boolean; domain: string; setDomain: (v: string) => void; onScan: (legalAccepted: boolean) => void; error: string }) {
  // The agreement is entered into here, at the first thing the customer does,
  // not implied three screens later by a workspace that already exists.
  const [accepted, setAccepted] = useState(false);
  const canScan = !!domain.trim() && accepted;
  return (
    <div className="min-h-screen bg-[#fafafa] flex flex-col" dir={he ? "rtl" : "ltr"}>
      <header className="px-6 md:px-10 py-6"><Wordmark /></header>
      <main className="flex-1 flex items-center px-6">
        <div className="w-full max-w-2xl mx-auto pb-24 animate-riseIn">
          <p className="text-[12px] font-semibold text-primary-500 uppercase tracking-[0.22em] mb-4">{he ? "גילוי עסקי" : "Business Discovery"}</p>
          <h1 className="text-4xl md:text-[52px] font-bold text-gray-900 tracking-tight leading-[1.06]">
            {he ? "איפה העסק שלכם חי באינטרנט?" : "Where does your business live online?"}
          </h1>
          <p className="text-lg text-gray-500 mt-4 leading-relaxed max-w-xl">
            {he ? "אני אקרא את האתר מקצה לקצה ואחזור עם כל מה שלמדתי - לפני שאשאל אתכם דבר." : "I'll read it end to end and come back with everything I learned - before asking you a single question."}
          </p>
          <div className="mt-10">
            <input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && canScan) onScan(accepted); }}
              placeholder="yourbusiness.com"
              autoFocus
              dir="ltr"
              className={"w-full bg-transparent border-0 border-b-2 border-gray-200 focus:border-primary-400 outline-none text-2xl md:text-3xl font-medium text-gray-900 placeholder-gray-300 py-3 transition-colors " + (he ? "text-right" : "")}
            />
            {error && <p className="mt-3 text-sm text-amber-600">{error}</p>}

            {/* Consent, on the screen where setup actually begins. The links
                open in a new tab so reading the terms never costs the customer
                the domain they just typed. */}
            <label className="flex items-start gap-3 mt-8 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={accepted}
                onChange={(e) => setAccepted(e.target.checked)}
                className="mt-0.5 w-4 h-4 rounded border-gray-300 text-primary-500 focus:ring-primary-400 shrink-0"
              />
              <span className="text-sm text-gray-500 leading-relaxed">
                {he ? (
                  <>
                    אני מאשר/ת את{" "}
                    <a href="/legal/terms-of-service" target="_blank" rel="noreferrer" className="text-primary-600 underline hover:text-primary-700">תנאי השימוש</a>
                    {" "}ואת{" "}
                    <a href="/legal/privacy-policy" target="_blank" rel="noreferrer" className="text-primary-600 underline hover:text-primary-700">מדיניות הפרטיות</a>
                    {" "}של GOTCHA.
                  </>
                ) : (
                  <>
                    I accept GOTCHA&apos;s{" "}
                    <a href="/legal/terms-of-service" target="_blank" rel="noreferrer" className="text-primary-600 underline hover:text-primary-700">Terms of Service</a>
                    {" "}and{" "}
                    <a href="/legal/privacy-policy" target="_blank" rel="noreferrer" className="text-primary-600 underline hover:text-primary-700">Privacy Policy</a>.
                  </>
                )}
              </span>
            </label>

            <div className="flex items-center gap-4 mt-6">
              <button type="button" onClick={() => onScan(accepted)} disabled={!canScan}
                className="inline-flex items-center justify-center px-8 py-4 bg-primary-500 hover:bg-primary-600 text-white text-base font-semibold rounded-2xl transition shadow-lg shadow-primary-500/25 disabled:opacity-40 disabled:shadow-none">
                {he ? "חקרו את העסק שלי ←" : "Investigate my business →"}
              </button>
              {canScan && <span className="text-xs text-gray-400 hidden md:block">{he ? "או הקישו Enter ↵" : "press Enter ↵"}</span>}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
