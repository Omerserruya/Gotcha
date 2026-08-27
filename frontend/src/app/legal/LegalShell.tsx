"use client";

import { ReactNode } from "react";
import { useLegalLocale } from "./LegalKit";
import { MarketingFooter, MarketingHeader } from "@/components/marketing/MarketingChrome";

/**
 * Public page: the SAME chrome as the landing page and /pricing.
 *
 * This section used to draw its own header - a small icon, the words "Trust
 * Center", and no way to reach anything but the homepage - and its own footer
 * listing only the legal documents. A visitor arriving from the marketing
 * footer effectively left the site and landed somewhere that looked related but
 * not identical. It now wears exactly what every other public page wears.
 *
 * The one thing this section keeps for itself is its language. The Trust Center
 * picks a language per DOCUMENT (Hebrew is the governing version of every one of
 * them), which is not the same choice as the app's UI language, so LegalKit
 * still owns it. `localeControl` hands that choice to the shared header and
 * footer: the switch in the nav drives the document, and the nav labels render
 * in the document's language too. Nothing here touches the visitor's app-wide
 * language preference - opening a legal page should not restyle the rest of the
 * site around it.
 */
export function LegalShell({ children }: { children: ReactNode }) {
  const { locale, setLocale, he } = useLegalLocale();

  return (
    <div dir={he ? "rtl" : "ltr"} lang={locale} className="min-h-screen bg-white flex flex-col">
      <MarketingHeader localeControl={{ locale, setLocale }} />

      {/* The shared header floats over the page, so the content clears it. */}
      <main className="flex-1 pt-20 sm:pt-24">{children}</main>

      <MarketingFooter localeControl={{ locale, setLocale }} />
    </div>
  );
}
