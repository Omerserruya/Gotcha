"use client";

/**
 * The one header and the one footer every public GOTCHA page wears.
 *
 * There used to be three of each. The landing page had the floating nav with
 * the real logo, /pricing drew its own bar with the word "GOTCHA." set in
 * type, and the Trust Center had a third with a small icon and no navigation
 * at all. A visitor moving between them saw the brand change shape twice, and
 * two of the three had no way back to anything except the homepage.
 *
 * Both pieces live here so that stays impossible: the logo, the nav, the CTA,
 * the language switch and the whole footer are defined once and imported.
 *
 * Two details are worth knowing before editing:
 *
 *  - In-page anchors (#how-it-works, #product-features) only exist ON the
 *    landing page. Everywhere else the same links have to be `/#how-it-works`
 *    or they scroll to nothing. `sectionHref()` decides that from the current
 *    path, so no caller has to remember.
 *  - Production serves this export with `trailingSlash`, so the path is
 *    `/pricing/`, not `/pricing`. Route comparisons go through samePath() from
 *    lib/pathname, which is the repo-wide rule: comparing the raw path against
 *    a literal is right in dev and silently wrong in production.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useI18n } from "@/context/I18nContext";
import { getTranslation, t as translate, type Locale } from "@/i18n";
import LoginLink from "@/components/LoginLink";
import SocialLinks from "@/components/landing/SocialLinks";
import { publicPricingEnabled } from "@/lib/api-public-pricing";
import { samePath, useAppPathname } from "@/lib/pathname";

/** Who owns the language choice for this page. */
export interface LocaleControl {
  locale: Locale;
  setLocale: (l: Locale) => void;
}

/** The three routes that render the landing page itself. */
const LANDING_PATHS = ["/", "/en", "/he"];

export function isLandingPath(path: string | null | undefined): boolean {
  return LANDING_PATHS.some((p) => samePath(path, p));
}

/* ───── Logo ───── */

/**
 * The brand mark. One image, one size, everywhere - including the pages that
 * used to spell the name out in type instead.
 */
export function MarketingLogo({ light, className = "" }: { light?: boolean; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/logo_icon.png"
      alt="GOTCHA"
      className={`h-7 w-auto ${light ? "brightness-0 invert" : ""} ${className}`}
    />
  );
}

/* ───── Shared bits ───── */

/**
 * The language this chrome reads and writes, and the translator for it.
 *
 * `override` is for sections that keep their own language state - the Trust
 * Center picks its language per DOCUMENT (Hebrew is the governing version of
 * every one of them), which is not the same choice as the app's UI language.
 * When one is given, the nav and footer translate in THAT language too, so the
 * frame is never in a different language from the page inside it - and the
 * visitor's app-wide language preference is left alone, which reading a legal
 * document has no business changing.
 */
function useResolvedLocale(override?: LocaleControl): LocaleControl & {
  t: (key: string, vars?: Record<string, string>) => string;
} {
  const { locale, setLocale, t } = useI18n();
  if (override) {
    return {
      ...override,
      t: (key, vars) => translate(getTranslation(override.locale), key, vars),
    };
  }
  return { locale, setLocale: (l) => { void setLocale(l); }, t };
}

function LocaleDropdown({
  control,
  forcedLocale,
  dark,
}: {
  control: LocaleControl;
  forcedLocale?: Locale;
  dark?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  function handleSwitch(l: Locale) {
    setOpen(false);
    // /en and /he are separate routes, so on those the language switch is a
    // navigation, not a state change.
    if (forcedLocale) router.push(`/${l}`);
    else control.setLocale(l);
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1 px-2.5 py-1.5 text-[13px] font-medium rounded-full transition-all ${
          dark ? "text-white/70 hover:text-white hover:bg-white/10" : "text-gray-500 hover:text-black hover:bg-gray-100/80"
        }`}
      >
        {control.locale.toUpperCase()}
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={`transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="absolute top-full mt-1 end-0 bg-white rounded-lg border border-gray-200/60 shadow-lg py-1 min-w-[72px] z-50">
          {(["en", "he"] as const).map((l) => (
            <button
              key={l}
              onClick={() => handleSwitch(l)}
              className={`w-full px-3 py-1.5 text-[13px] text-start transition-colors ${
                l === control.locale ? "font-semibold text-primary-500 bg-primary-50" : "text-gray-600 hover:bg-gray-50"
              }`}
            >
              {l.toUpperCase()}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ───── Mobile Menu ───── */

function MobileMenu({
  open,
  onClose,
  control,
  forcedLocale,
  homeHref,
  sectionHref,
  t,
}: {
  open: boolean;
  onClose: () => void;
  control: LocaleControl;
  forcedLocale?: Locale;
  homeHref: string;
  sectionHref: (hash: string) => string;
  t: (key: string) => string;
}) {
  const router = useRouter();

  useEffect(() => {
    if (open) document.body.style.overflow = "hidden";
    else document.body.style.overflow = "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  function handleSwitch(l: Locale) {
    onClose();
    if (forcedLocale) router.push(`/${l}`);
    else control.setLocale(l);
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] md:hidden">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="absolute top-0 inset-x-0 bg-white rounded-b-2xl shadow-xl animate-slide-up p-6 pt-20 pb-safe">
        <button onClick={onClose} className="absolute top-5 end-5 p-2 text-gray-400 hover:text-black">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
        <nav className="flex flex-col gap-1">
          <Link href={homeHref} onClick={onClose} className="px-4 py-3 text-[15px] font-medium text-gray-700 hover:bg-gray-50 rounded-xl transition-colors">
            {t("landing.nav.home")}
          </Link>
          <a href={sectionHref("how-it-works")} onClick={onClose} className="px-4 py-3 text-[15px] font-medium text-gray-700 hover:bg-gray-50 rounded-xl transition-colors">
            {t("landing.nav.howItWorks")}
          </a>
          <a href={sectionHref("product-features")} onClick={onClose} className="px-4 py-3 text-[15px] font-medium text-gray-700 hover:bg-gray-50 rounded-xl transition-colors">
            {t("landing.nav.features")}
          </a>
          <div className="h-px bg-gray-100 my-2" />
          <div className="flex items-center gap-2 px-4 py-2">
            {(["en", "he"] as const).map((l) => (
              <button
                key={l}
                onClick={() => handleSwitch(l)}
                className={`px-4 py-2 text-sm rounded-lg transition-colors ${
                  l === control.locale ? "bg-primary-50 text-primary-500 font-semibold" : "text-gray-500 hover:bg-gray-50"
                }`}
              >
                {l.toUpperCase()}
              </button>
            ))}
          </div>
          <div className="h-px bg-gray-100 my-2" />
          {publicPricingEnabled && (
            <Link href="/pricing" onClick={onClose} className="px-4 py-3 text-[15px] font-medium text-gray-700 hover:bg-gray-50 rounded-xl transition-colors">
              {t("landing.nav.pricing")}
            </Link>
          )}
          <Link href="/legal" onClick={onClose} className="px-4 py-3 text-[15px] font-medium text-gray-700 hover:bg-gray-50 rounded-xl transition-colors">
            {t("landing.footer.trustCenter")}
          </Link>
          <LoginLink onClick={onClose} className="px-4 py-3 text-[15px] font-medium text-gray-700 hover:bg-gray-50 rounded-xl transition-colors">
            {t("landing.nav.login")}
          </LoginLink>
          <Link href="/early-access" onClick={onClose} className="mt-2 px-4 py-3 text-[15px] font-semibold text-white bg-primary-500 rounded-xl text-center hover:bg-primary-600 transition-colors">
            {t("landing.nav.getStarted")}
          </Link>
        </nav>
      </div>
    </div>
  );
}

/* ───── Header ───── */

export interface MarketingHeaderProps {
  /**
   * True while the nav floats over a dark section, which only the landing page
   * tracks. Everywhere else the page is white and this stays false.
   */
  navDark?: boolean;
  /** Set on /en and /he, where the language is part of the URL. */
  forcedLocale?: Locale;
  /** For sections that own their language state (the Trust Center). */
  localeControl?: LocaleControl;
}

export function MarketingHeader({ navDark = false, forcedLocale, localeControl }: MarketingHeaderProps) {
  const pathname = useAppPathname();
  const control = useResolvedLocale(localeControl);
  const t = control.t;
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const onLanding = isLandingPath(pathname);
  const homeHref = forcedLocale ? `/${forcedLocale}` : "/";
  // On the landing page these are in-page jumps; anywhere else they have to
  // travel home first or they resolve to nothing.
  const sectionHref = (hash: string) => (onLanding ? `#${hash}` : `${homeHref}#${hash}`);

  const linkClass = navDark
    ? "text-white/60 hover:text-white hover:bg-white/10"
    : "text-gray-500 hover:text-black hover:bg-gray-100/80";

  return (
    <>
      <header className="fixed top-0 inset-x-0 z-50 flex justify-center pt-3 sm:pt-4 px-3 sm:px-4">
        <nav className={`w-full max-w-[1240px] flex items-center justify-between px-4 sm:px-5 py-2.5 rounded-2xl backdrop-blur-xl border transition-colors duration-500 ${
          navDark
            ? "bg-white/[0.06] border-white/[0.08] shadow-[0_2px_20px_rgba(0,0,0,0.3)]"
            : "bg-white/80 border-gray-200/60 shadow-[0_2px_20px_rgba(0,0,0,0.06)]"
        }`}>
          <div className="flex items-center gap-6">
            <Link href={homeHref} aria-label="GOTCHA" className="shrink-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400">
              <MarketingLogo light={navDark} />
            </Link>
            <div className="hidden md:flex items-center gap-1">
              <a href={sectionHref("how-it-works")} className={`px-3.5 py-1.5 text-[13px] font-medium rounded-full transition-all ${linkClass}`}>
                {t("landing.nav.howItWorks")}
              </a>
              {publicPricingEnabled && (
                <Link href="/pricing" className={`px-3.5 py-1.5 text-[13px] font-medium rounded-full transition-all ${linkClass}`}>
                  {t("landing.nav.pricing")}
                </Link>
              )}
              <a href={sectionHref("product-features")} className={`px-3.5 py-1.5 text-[13px] font-medium rounded-full transition-all ${linkClass}`}>
                {t("landing.nav.features")}
              </a>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="hidden md:flex items-center gap-2">
              <LocaleDropdown control={control} forcedLocale={forcedLocale} dark={navDark} />
              <LoginLink className={`px-3.5 py-1.5 text-[13px] font-medium rounded-full transition-all ${
                navDark ? "text-white/70 hover:text-white hover:bg-white/10" : "text-gray-600 hover:text-black hover:bg-gray-100/80"
              }`}>
                {t("landing.nav.login")}
              </LoginLink>
            </div>
            <Link href="/early-access" className="hidden sm:inline-flex px-5 py-2 text-[13px] font-semibold text-white bg-primary-500 rounded-full hover:bg-primary-600 transition-all">
              {t("landing.nav.getStarted")}
            </Link>
            <button
              onClick={() => setMobileMenuOpen(true)}
              aria-label={t("landing.nav.menu")}
              className={`md:hidden p-2 rounded-lg transition-colors ${
                navDark ? "text-white/70 hover:bg-white/10" : "text-gray-600 hover:bg-gray-100"
              }`}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M4 7h16M4 12h16M4 17h16" />
              </svg>
            </button>
          </div>
        </nav>
      </header>

      <MobileMenu
        open={mobileMenuOpen}
        onClose={() => setMobileMenuOpen(false)}
        control={control}
        forcedLocale={forcedLocale}
        homeHref={homeHref}
        sectionHref={sectionHref}
        t={t}
      />
    </>
  );
}

/* ───── Footer ───── */

export interface MarketingFooterProps {
  forcedLocale?: Locale;
  localeControl?: LocaleControl;
}

export function MarketingFooter({ forcedLocale, localeControl }: MarketingFooterProps) {
  const pathname = useAppPathname();
  const control = useResolvedLocale(localeControl);
  const t = control.t;

  const onLanding = isLandingPath(pathname);
  const homeHref = forcedLocale ? `/${forcedLocale}` : "/";
  const sectionHref = (hash: string) => (onLanding ? `#${hash}` : `${homeHref}#${hash}`);

  const otherLocale: Locale = control.locale === "en" ? "he" : "en";
  const otherLabel = control.locale === "en" ? "עברית" : "English";

  const item = "hover:text-gray-900 transition-colors duration-200 text-[13px]";

  return (
    <footer className="py-10 sm:py-14 px-4 sm:px-12 lg:px-20 bg-[#fafafa]">
      <div className="max-w-[1240px] mx-auto">
        <div className="flex flex-col md:flex-row justify-between gap-10">
          <div className="max-w-xs">
            <Link href={homeHref} aria-label="GOTCHA" className="inline-block">
              <MarketingLogo />
            </Link>
            <p className="mt-4 text-[13px] text-[#b0b0b0] leading-relaxed">
              {t("landing.hero.title1")}
            </p>
            <SocialLinks t={t} className="mt-5" />
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-8 sm:gap-12 text-sm">
            <div>
              <h4 className="font-medium text-gray-900 mb-3 sm:mb-4 text-[13px]">{t("landing.footer.product")}</h4>
              <ul className="space-y-2.5 text-[#b0b0b0]">
                <li><a href={sectionHref("how-it-works")} className={item}>{t("landing.nav.howItWorks")}</a></li>
                <li><a href={sectionHref("product-features")} className={item}>{t("landing.nav.features")}</a></li>
                {publicPricingEnabled && (
                  <li><Link href="/pricing" className={item}>{t("landing.nav.pricing")}</Link></li>
                )}
                <li><Link href="/early-access" className={item}>{t("landing.nav.getStarted")}</Link></li>
              </ul>
            </div>
            <div>
              <h4 className="font-medium text-gray-900 mb-3 sm:mb-4 text-[13px]">{t("landing.footer.company")}</h4>
              <ul className="space-y-2.5 text-[#b0b0b0]">
                <li><a href="#" className={item}>{t("landing.footer.about")}</a></li>
                <li><a href="#" className={item}>{t("landing.footer.blog")}</a></li>
                <li>
                  <a href="mailto:privacy@gotcha.co.il" className={item} dir="ltr">privacy@gotcha.co.il</a>
                </li>
              </ul>
            </div>
            <div>
              <h4 className="font-medium text-gray-900 mb-3 sm:mb-4 text-[13px]">{t("landing.footer.legal")}</h4>
              {/* Canonical /legal URLs, not the /terms and /privacy-policy
                  redirects: those survive only for external references. */}
              <ul className="space-y-2.5 text-[#b0b0b0]">
                <li><Link href="/legal" className={`${item} font-medium text-gray-700`}>{t("landing.footer.trustCenter")}</Link></li>
                <li><Link href="/legal/privacy-policy" className={item}>{t("landing.footer.privacy")}</Link></li>
                <li><Link href="/legal/terms-of-service" className={item}>{t("landing.footer.terms")}</Link></li>
                <li><Link href="/legal/cookie-policy" className={item}>{t("landing.footer.cookies")}</Link></li>
                <li><Link href="/legal/cancellation-refunds" className={item}>{t("landing.footer.cancellation")}</Link></li>
              </ul>
            </div>
          </div>
        </div>

        <div className="mt-8 sm:mt-10 pt-6 sm:pt-8 border-t border-gray-200/60 flex flex-col sm:flex-row items-center justify-between gap-3 text-[13px] text-[#b0b0b0]">
          <p>&copy; {new Date().getFullYear()} GOTCHA. {t("landing.footer.copyright")}</p>
          <p className="text-[11px] text-[#c0c0c0]">Founds and Operated by Omer Serruya | עומר צרויה, Matan Amran | מתן עמרן</p>
          {forcedLocale ? (
            <Link href={`/${otherLocale}`} className="hover:text-gray-900 transition-colors duration-200">
              {otherLabel}
            </Link>
          ) : (
            <button
              onClick={() => control.setLocale(otherLocale)}
              className="hover:text-gray-900 transition-colors duration-200"
            >
              {otherLabel}
            </button>
          )}
        </div>
      </div>
    </footer>
  );
}
