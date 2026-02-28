"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useI18n } from "@/context/I18nContext";
import type { Locale } from "@/i18n";

/* ───── Icons ───── */

function IconCopilot() {
  return (
    <svg width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z" />
    </svg>
  );
}

function IconChannels() {
  return (
    <svg width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 0 1-.825-.242m9.345-8.334a2.126 2.126 0 0 0-.476-.095 48.64 48.64 0 0 0-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0 0 11.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155" />
    </svg>
  );
}

function IconRouting() {
  return (
    <svg width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21 3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
    </svg>
  );
}

function IconKnowledge() {
  return (
    <svg width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25" />
    </svg>
  );
}

function IconAnalytics() {
  return (
    <svg width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z" />
    </svg>
  );
}

function IconBot() {
  return (
    <svg width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 0 1-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 0 1 4.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0 1 12 15a9.065 9.065 0 0 0-6.23.693L5 14.5m14.8.8 1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0 1 12 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
    </svg>
  );
}

const featureIcons = [IconCopilot, IconChannels, IconRouting, IconKnowledge, IconAnalytics, IconBot];
const featureKeys = ["copilot", "channels", "routing", "knowledge", "analytics", "botBuilder"] as const;

/* ───── Logo ───── */

function Logo({ light }: { light?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
          <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2Z" fill="white" />
        </svg>
      </div>
      <span className={`text-lg font-semibold tracking-tight ${light ? "text-white" : "text-black"}`}>GOTCHA</span>
    </div>
  );
}

/* ───── Product Mockup ───── */

function ProductMockup({ dark }: { dark?: boolean }) {
  const bg = dark ? "bg-[#1a1a2e]" : "bg-white";
  const border = dark ? "border-white/[0.06]" : "border-gray-200";
  const chrome = dark ? "bg-[#12121f]" : "bg-gray-50";
  const chromeBorder = dark ? "border-white/[0.04]" : "border-gray-100";
  const sidebarBg = dark ? "bg-white/[0.03]" : "bg-gray-50";
  const cardBg = dark ? "bg-white/[0.04]" : "bg-gray-100";
  const activeBg = dark ? "bg-primary-500/20" : "bg-primary-100";
  const chatItemBg = dark ? "bg-white/[0.02]" : "bg-white";
  const chatItemBorder = dark ? "border-white/[0.03]" : "border-gray-100";
  const chatActiveBg = dark ? "bg-primary-500/10" : "bg-primary-50";
  const chatActiveBorder = dark ? "border-primary-500/20" : "border-primary-100";
  const bubbleIn = dark ? "bg-white/[0.06]" : "bg-gray-100";
  const bubbleOut = dark ? "bg-primary-500/50" : "bg-primary-500";
  const inputBg = dark ? "bg-white/[0.03] border-white/[0.06]" : "bg-white border-gray-200";

  return (
    <div className={`${bg} rounded-2xl border ${border} overflow-hidden`}
      style={{ boxShadow: "0 6px 40px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06)" }}
    >
      {/* Browser chrome */}
      <div className={`flex items-center gap-2 px-4 py-2.5 ${chrome} border-b ${chromeBorder}`}>
        <div className="flex gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full bg-[#ff5f57]" />
          <div className="w-2.5 h-2.5 rounded-full bg-[#febc2e]" />
          <div className="w-2.5 h-2.5 rounded-full bg-[#28c840]" />
        </div>
        <div className="flex-1 mx-8">
          <div className={`h-5 ${cardBg} rounded max-w-[200px] mx-auto`} />
        </div>
      </div>
      {/* App UI */}
      <div className="p-3 sm:p-4">
        <div className="flex gap-3 h-52 sm:h-72">
          {/* Sidebar */}
          <div className={`hidden sm:flex flex-col w-40 ${sidebarBg} rounded-xl p-2.5 gap-1.5`}>
            <div className={`h-7 ${activeBg} rounded-lg`} />
            <div className={`h-5 ${cardBg} rounded-lg`} />
            <div className={`h-5 ${cardBg} rounded-lg`} />
            <div className={`h-5 ${cardBg} rounded-lg`} />
            <div className="flex-1" />
            <div className={`h-7 ${cardBg} rounded-lg`} />
          </div>
          {/* Chat list */}
          <div className={`flex-1 flex flex-col ${sidebarBg} rounded-xl p-2.5 gap-1.5 min-w-0`}>
            <div className={`h-7 ${cardBg} rounded-lg`} />
            <div className={`h-12 ${chatItemBg} rounded-lg border ${chatItemBorder}`} />
            <div className={`h-12 ${chatActiveBg} rounded-lg border ${chatActiveBorder}`} />
            <div className={`h-12 ${chatItemBg} rounded-lg border ${chatItemBorder}`} />
            <div className="flex-1" />
          </div>
          {/* Chat area */}
          <div className={`hidden md:flex flex-[1.6] flex-col ${sidebarBg} rounded-xl p-2.5 gap-1.5`}>
            <div className={`h-7 ${cardBg} rounded-lg`} />
            <div className="flex-1 flex flex-col gap-1.5 py-1">
              <div className={`self-start w-3/5 h-7 ${bubbleIn} rounded-xl rounded-tl-sm`} />
              <div className={`self-end w-2/5 h-7 ${bubbleOut} rounded-xl rounded-tr-sm`} />
              <div className={`self-start w-2/5 h-7 ${bubbleIn} rounded-xl rounded-tl-sm`} />
              <div className={`self-end w-3/5 h-7 ${bubbleOut} rounded-xl rounded-tr-sm`} />
            </div>
            <div className={`h-8 ${inputBg} rounded-lg border`} />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ───── Main Component ───── */

export default function LandingPage({ forcedLocale }: { forcedLocale?: Locale }) {
  const { t, locale, setLocale, dir } = useI18n();

  useEffect(() => {
    if (forcedLocale && forcedLocale !== locale) {
      setLocale(forcedLocale);
    }
  }, [forcedLocale, locale, setLocale]);

  const otherLabel = locale === "en" ? "עברית" : "English";
  const otherPath = locale === "en" ? "/he" : "/en";
  const isRtl = dir === "rtl";

  return (
    <div dir={dir} className="min-h-screen bg-white text-black overflow-x-hidden">

      {/* ───── Floating Nav ───── */}
      <header className="fixed top-0 inset-x-0 z-50 flex justify-center pt-4 px-4">
        <nav className="flex items-center gap-1 px-3 py-2 rounded-xl bg-white/80 backdrop-blur-xl border border-gray-200/60 shadow-[0_2px_20px_rgba(0,0,0,0.06)]">
          <div className="px-2">
            <Logo />
          </div>

          <div className="hidden md:flex items-center ms-2">
            <a href="#features" className="px-3.5 py-1.5 text-[13px] font-medium text-gray-500 hover:text-black rounded-full hover:bg-gray-100/80 transition-all">
              {t("landing.nav.features")}
            </a>
            <a href="#how-it-works" className="px-3.5 py-1.5 text-[13px] font-medium text-gray-500 hover:text-black rounded-full hover:bg-gray-100/80 transition-all">
              {t("landing.nav.channels")}
            </a>
          </div>

          <div className="flex items-center gap-1 ms-2">
            <Link href={otherPath} className="px-3 py-1.5 text-[13px] text-gray-400 hover:text-black rounded-full hover:bg-gray-100/80 transition-all font-medium">
              {otherLabel}
            </Link>
            <Link href="/login" className="px-3 py-1.5 text-[13px] font-medium text-gray-600 hover:text-black rounded-full hover:bg-gray-100/80 transition-all">
              {t("landing.nav.login")}
            </Link>
            <Link href="/login" className="px-4 py-1.5 text-[13px] font-semibold text-white bg-primary-500 rounded-full hover:bg-primary-600 transition-all">
              {t("landing.nav.getStarted")}
            </Link>
          </div>
        </nav>
      </header>

      {/* ───── Hero: Split Layout ───── */}
      <section className="relative min-h-[95vh] flex items-center px-6 sm:px-12 lg:px-20 pt-24 overflow-hidden">
        {/* Blurred color spots */}
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -top-32 -left-32 w-[500px] h-[500px] rounded-full opacity-[0.08]" style={{ background: "#7C3291", filter: "blur(120px)" }} />
          <div className="absolute top-1/3 -right-40 w-[600px] h-[600px] rounded-full opacity-[0.07]" style={{ background: "#5A72B3", filter: "blur(140px)" }} />
          <div className="absolute -bottom-40 left-1/3 w-[500px] h-[500px] rounded-full opacity-[0.06]" style={{ background: "#6DCED9", filter: "blur(130px)" }} />
        </div>
        <div className="max-w-[1240px] mx-auto w-full flex flex-col lg:flex-row items-center gap-12 lg:gap-16 relative z-10">
          {/* Text side */}
          <div className={`flex-1 max-w-xl ${isRtl ? "lg:order-2" : ""}`}>
            <h1 className="text-[clamp(2rem,5vw,3.2rem)] font-semibold leading-[1.12] tracking-[-0.03em] text-black mb-5 landing-fade-in">
              {t("landing.hero.title1")}{" "}
              <span className="text-primary-500">{t("landing.hero.title2")}</span>
            </h1>
            <p className="text-base sm:text-[17px] leading-[1.6] text-[#757575] mb-8 landing-fade-in landing-delay-1">
              {t("landing.hero.subtitle")}
            </p>
            <div className="flex flex-wrap gap-3 landing-fade-in landing-delay-2">
              <Link
                href="/login"
                className="px-6 py-3 text-[15px] font-semibold text-white bg-primary-500 rounded-2xl hover:bg-primary-600 transition-colors"
                style={{ boxShadow: "0 2px 8px rgba(124,92,252,0.25)" }}
              >
                {t("landing.hero.cta")}
              </Link>
              <a
                href="#how-it-works"
                className="px-6 py-3 text-[15px] font-medium text-[#757575] hover:text-black transition-colors"
              >
                {t("landing.hero.ctaSecondary")} &rarr;
              </a>
            </div>
          </div>

          {/* Screenshot side */}
          <div className={`flex-1 w-full max-w-2xl landing-fade-in landing-delay-3 ${isRtl ? "lg:order-1" : ""}`}>
            <ProductMockup />
          </div>
        </div>
      </section>

      {/* ───── Supported Integrations (marquee) ───── */}
      <section className="py-14 px-6 border-t border-gray-100">
        <div className="max-w-[1240px] mx-auto">
          <p className="text-xs font-medium text-[#a3a3a3] uppercase tracking-[0.15em] mb-8 text-center">{t("landing.hero.trustedBy")}</p>
          <div className="landing-marquee">
          <div className="landing-marquee-track">
            {[0, 1, 2, 3].map((copy) => (
              <div key={copy} className="flex items-center gap-20 px-10 flex-shrink-0" aria-hidden={copy > 0}>
                <img src="/integrations/whatsapp.svg" alt="WhatsApp" className="h-8 flex-shrink-0 object-contain" />
                <img src="/integrations/facebook.svg" alt="Facebook Messenger" className="h-8 flex-shrink-0 object-contain" />
                <img src="/integrations/instagram.svg" alt="Instagram" className="h-8 flex-shrink-0 object-contain" />
                <img src="/integrations/gmail.svg" alt="Gmail" className="h-8 flex-shrink-0 object-contain" />
              </div>
            ))}
          </div>
        </div>
        </div>
      </section>

      {/* ───── Features ───── */}
      <section id="features" className="py-20 sm:py-28 px-6 sm:px-12 lg:px-20">
        <div className="max-w-[1240px] mx-auto">
          <div className="text-center max-w-xl mx-auto mb-16">
            <p className="text-xs font-medium text-primary-500 uppercase tracking-[0.15em] mb-3">
              {t("landing.features.label")}
            </p>
            <h2 className="text-[clamp(1.5rem,3.5vw,2.5rem)] font-semibold tracking-[-0.03em] leading-[1.15] mb-4">
              {t("landing.features.title")}
            </h2>
            <p className="text-[#757575] text-base">
              {t("landing.features.subtitle")}
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {featureKeys.map((key, i) => {
              const Icon = featureIcons[i];
              return (
                <div
                  key={key}
                  className="group p-6 rounded-2xl border border-gray-100 bg-white hover:border-gray-200 transition-all duration-300 hover:shadow-[0_6px_24px_rgba(0,0,0,0.06)]"
                >
                  <div className="w-10 h-10 rounded-xl bg-primary-50 text-primary-500 flex items-center justify-center mb-4 group-hover:bg-primary-500 group-hover:text-white transition-colors duration-300">
                    <Icon />
                  </div>
                  <h3 className="text-[15px] font-semibold mb-1.5 tracking-[-0.01em]">{t(`landing.features.${key}.title`)}</h3>
                  <p className="text-[#757575] text-sm leading-[1.6]">{t(`landing.features.${key}.desc`)}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ───── Dark Section: How It Works + Mockup ───── */}
      <section id="how-it-works" className="landing-dark-section py-20 sm:py-28 px-6 sm:px-12 lg:px-20">
        <div className="max-w-[1240px] mx-auto">
          <div className="flex flex-col lg:flex-row items-center gap-12 lg:gap-20">
            {/* Text */}
            <div className={`flex-1 max-w-lg ${isRtl ? "lg:order-2" : ""}`}>
              <p className="text-xs font-medium text-primary-400 uppercase tracking-[0.15em] mb-3">
                {t("landing.howItWorks.label")}
              </p>
              <h2 className="text-[clamp(1.5rem,3.5vw,2.5rem)] font-semibold tracking-[-0.03em] leading-[1.15] text-white mb-4">
                {t("landing.howItWorks.title")}
              </h2>
              <p className="text-[#757575] text-base mb-10">
                {t("landing.howItWorks.subtitle")}
              </p>

              <div className="flex flex-col gap-6">
                {(["step1", "step2", "step3"] as const).map((step, i) => (
                  <div key={step} className="flex items-start gap-4">
                    <div className="flex-shrink-0 w-9 h-9 rounded-full bg-primary-500 text-white flex items-center justify-center text-sm font-bold">
                      {i + 1}
                    </div>
                    <div>
                      <h3 className="text-[15px] font-semibold text-white mb-1">{t(`landing.howItWorks.${step}.title`)}</h3>
                      <p className="text-[#757575] text-sm leading-[1.6]">{t(`landing.howItWorks.${step}.desc`)}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Dark mockup */}
            <div className={`flex-1 w-full max-w-xl ${isRtl ? "lg:order-1" : ""}`}>
              <ProductMockup dark />
            </div>
          </div>
        </div>
      </section>

      {/* ───── CTA ───── */}
      <section className="py-20 sm:py-28 px-6">
        <div className="max-w-2xl mx-auto text-center">
          <h2 className="text-[clamp(1.5rem,3.5vw,2.5rem)] font-semibold tracking-[-0.03em] leading-[1.15] mb-4">
            {t("landing.cta.title")}
          </h2>
          <p className="text-[#757575] text-base mb-8">
            {t("landing.cta.subtitle")}
          </p>
          <Link
            href="/login"
            className="inline-flex px-8 py-3.5 text-[15px] font-semibold text-white bg-primary-500 rounded-2xl hover:bg-primary-600 transition-colors"
            style={{ boxShadow: "0 2px 12px rgba(124,92,252,0.3)" }}
          >
            {t("landing.cta.button")}
          </Link>
        </div>
      </section>

      {/* ───── Footer ───── */}
      <footer className="border-t border-gray-100 py-10 px-6 sm:px-12 lg:px-20">
        <div className="max-w-[1240px] mx-auto">
          <div className="flex flex-col md:flex-row justify-between gap-8">
            <div className="max-w-xs">
              <Logo />
              <p className="mt-3 text-sm text-[#a3a3a3] leading-relaxed">
                {t("landing.hero.subtitle").slice(0, 80)}...
              </p>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-8 text-sm">
              <div>
                <h4 className="font-semibold text-black mb-3 text-[13px]">{t("landing.footer.product")}</h4>
                <ul className="space-y-2 text-[#757575]">
                  <li><a href="#features" className="hover:text-black transition-colors text-[13px]">{t("landing.nav.features")}</a></li>
                  <li><a href="#channels" className="hover:text-black transition-colors text-[13px]">{t("landing.nav.channels")}</a></li>
                </ul>
              </div>
              <div>
                <h4 className="font-semibold text-black mb-3 text-[13px]">{t("landing.footer.company")}</h4>
                <ul className="space-y-2 text-[#757575]">
                  <li><a href="#" className="hover:text-black transition-colors text-[13px]">{t("landing.footer.about")}</a></li>
                  <li><a href="#" className="hover:text-black transition-colors text-[13px]">{t("landing.footer.blog")}</a></li>
                </ul>
              </div>
              <div>
                <h4 className="font-semibold text-black mb-3 text-[13px]">{t("landing.footer.legal")}</h4>
                <ul className="space-y-2 text-[#757575]">
                  <li><Link href="/privacy-policy" className="hover:text-black transition-colors text-[13px]">{t("landing.footer.privacy")}</Link></li>
                  <li><Link href="/terms" className="hover:text-black transition-colors text-[13px]">{t("landing.footer.terms")}</Link></li>
                </ul>
              </div>
            </div>
          </div>

          <div className="mt-8 pt-6 border-t border-gray-100 flex flex-col sm:flex-row items-center justify-between gap-3 text-[13px] text-[#a3a3a3]">
            <p>&copy; {new Date().getFullYear()} GOTCHA. {t("landing.footer.copyright")}</p>
            <Link href={otherPath} className="hover:text-black transition-colors">
              {otherLabel}
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
