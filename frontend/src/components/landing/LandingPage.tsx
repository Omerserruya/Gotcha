"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useI18n } from "@/context/I18nContext";
import type { Locale } from "@/i18n";
import JsonLd from "@/components/JsonLd";

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

/* ───── Rotating Platform Names ───── */

const PLATFORMS = ["WhatsApp", "Instagram", "Facebook", "Messenger"];

function RotatingPlatform({ locale }: { locale: string }) {
  const [index, setIndex] = useState(0);
  const prefix = locale === "he" ? "-" : "";

  useEffect(() => {
    const id = setInterval(() => {
      setIndex((i) => (i + 1) % PLATFORMS.length);
    }, 2000);
    return () => clearInterval(id);
  }, []);

  return (
    <span className="inline-flex overflow-hidden h-[1.2em] align-bottom">
      <span key={index} className="landing-platform-rotate">
        {prefix}{PLATFORMS[index]}
      </span>
    </span>
  );
}

/* ───── Locale Dropdown ───── */

function LocaleDropdown({ locale, setLocale }: { locale: string; setLocale: (l: "en" | "he") => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 px-2.5 py-1.5 text-[13px] font-medium text-gray-500 hover:text-black rounded-full hover:bg-gray-100/80 transition-all"
      >
        {locale.toUpperCase()}
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={`transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="absolute top-full mt-1 end-0 bg-white rounded-lg border border-gray-200/60 shadow-lg py-1 min-w-[72px] z-50">
          {(["en", "he"] as const).map((l) => (
            <button
              key={l}
              onClick={() => { setLocale(l); setOpen(false); }}
              className={`w-full px-3 py-1.5 text-[13px] text-start transition-colors ${
                l === locale ? "font-semibold text-primary-500 bg-primary-50" : "text-gray-600 hover:bg-gray-50"
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
  t,
  locale,
  setLocale,
  navDark,
}: {
  open: boolean;
  onClose: () => void;
  t: (key: string) => any;
  locale: string;
  setLocale: (l: "en" | "he") => void;
  navDark: boolean;
}) {
  useEffect(() => {
    if (open) document.body.style.overflow = "hidden";
    else document.body.style.overflow = "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] md:hidden">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="absolute top-0 inset-x-0 bg-white rounded-b-2xl shadow-xl animate-slide-up p-6 pt-20 pb-safe">
        <button onClick={onClose} className="absolute top-5 end-5 p-2 text-gray-400 hover:text-black">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
        <nav className="flex flex-col gap-1">
          <a href="#features" onClick={onClose} className="px-4 py-3 text-[15px] font-medium text-gray-700 hover:bg-gray-50 rounded-xl transition-colors">
            {t("landing.nav.features")}
          </a>
          <a href="#how-it-works" onClick={onClose} className="px-4 py-3 text-[15px] font-medium text-gray-700 hover:bg-gray-50 rounded-xl transition-colors">
            {t("landing.nav.channels")}
          </a>
          <div className="h-px bg-gray-100 my-2" />
          <div className="flex items-center gap-2 px-4 py-2">
            {(["en", "he"] as const).map((l) => (
              <button
                key={l}
                onClick={() => setLocale(l)}
                className={`px-4 py-2 text-sm rounded-lg transition-colors ${
                  l === locale ? "bg-primary-50 text-primary-500 font-semibold" : "text-gray-500 hover:bg-gray-50"
                }`}
              >
                {l.toUpperCase()}
              </button>
            ))}
          </div>
          <div className="h-px bg-gray-100 my-2" />
          <Link href="/login" onClick={onClose} className="px-4 py-3 text-[15px] font-medium text-gray-700 hover:bg-gray-50 rounded-xl transition-colors">
            {t("landing.nav.login")}
          </Link>
          <Link href="/login" onClick={onClose} className="mt-2 px-4 py-3 text-[15px] font-semibold text-white bg-primary-500 rounded-xl text-center hover:bg-primary-600 transition-colors">
            {t("landing.nav.getStarted")}
          </Link>
        </nav>
      </div>
    </div>
  );
}

/* ───── Logo ───── */

function Logo({ light }: { light?: boolean }) {
  return (
    <img
      src="/logo.png"
      alt="GOTCHA"
      className={`h-7 w-auto ${light ? "brightness-0 invert" : ""}`}
    />
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

/* ───── FAQ Accordion Item ───── */

function FaqItem({ question, answer }: { question: string; answer: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-gray-100 last:border-0">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between py-4 sm:py-5 text-start gap-3 sm:gap-4 group min-h-[48px]"
      >
        <span className="text-sm sm:text-[15px] font-medium text-black group-hover:text-primary-500 transition-colors">{question}</span>
        <svg
          width="24" height="24" viewBox="0 0 24 24" fill="none"
          className={`flex-shrink-0 text-gray-400 transition-transform duration-300 ${open ? "rotate-45" : ""}`}
        >
          <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      <div
        className={`grid transition-all duration-300 ease-out ${open ? "grid-rows-[1fr] opacity-100 pb-4 sm:pb-5" : "grid-rows-[0fr] opacity-0"}`}
      >
        <div className="overflow-hidden">
          <p className="text-[#757575] text-sm leading-[1.7]">{answer}</p>
        </div>
      </div>
    </div>
  );
}

/* ───── Feature Visual Card ───── */

function FeatureVisual({ index: i }: { index: number }) {
  return (
    <div
      className="w-full bg-white/[0.04] rounded-2xl border border-white/[0.06] overflow-hidden p-5 sm:p-8"
      style={{ aspectRatio: "4/3", boxShadow: "0 8px 40px rgba(0,0,0,0.2)" }}
    >
      {i === 0 && (
        /* Copilot */
        <div className="flex flex-col gap-3 h-full justify-center max-w-xs mx-auto">
          <div className="self-start bg-white/[0.08] rounded-2xl rounded-tl-sm px-4 py-3 max-w-[80%]">
            <div className="h-2.5 bg-white/20 rounded w-full mb-2" />
            <div className="h-2.5 bg-white/20 rounded w-3/4" />
          </div>
          <div className="self-end bg-primary-500/20 border border-primary-500/20 rounded-2xl rounded-tr-sm px-4 py-3 max-w-[85%]">
            <div className="flex items-center gap-1.5 mb-2.5">
              <div className="w-4 h-4 rounded bg-primary-500/40 flex items-center justify-center">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-primary-300"><path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25" /></svg>
              </div>
              <span className="text-[10px] text-primary-300 font-medium">AI Suggestion</span>
            </div>
            <div className="h-2.5 bg-white/15 rounded w-full mb-2" />
            <div className="h-2.5 bg-white/15 rounded w-2/3" />
          </div>
          <div className="self-start bg-white/[0.08] rounded-2xl rounded-tl-sm px-4 py-3 max-w-[70%]">
            <div className="h-2.5 bg-white/20 rounded w-full" />
          </div>
        </div>
      )}
      {i === 1 && (
        /* Channels */
        <div className="flex flex-col items-center gap-4 sm:gap-5 h-full justify-center max-w-xs mx-auto">
          <div className="flex items-center gap-3 sm:gap-5">
            <img src="/integrations/whatsapp.svg" alt="" className="h-7 sm:h-9 opacity-80" />
            <img src="/integrations/facebook.svg" alt="" className="h-7 sm:h-9 opacity-80" />
            <img src="/integrations/instagram.svg" alt="" className="h-7 sm:h-9 opacity-80" />
            <img src="/integrations/gmail.svg" alt="" className="h-7 sm:h-9 opacity-80" />
          </div>
          <div className="flex flex-col items-center gap-1 text-white/20">
            <div className="w-px h-4 sm:h-6 bg-current" />
            <svg width="12" height="8" viewBox="0 0 12 8" fill="currentColor"><path d="M6 8L0 0h12z" /></svg>
          </div>
          <div className="bg-white/[0.06] rounded-xl p-2.5 sm:p-3 w-full space-y-2">
            {[1, 2, 3].map(n => (
              <div key={n} className="flex items-center gap-2.5 bg-white/[0.04] rounded-lg p-2 sm:p-2.5">
                <div className={`w-6 sm:w-7 h-6 sm:h-7 rounded-full ${n === 1 ? "bg-green-500/30" : n === 2 ? "bg-blue-500/30" : "bg-pink-500/30"}`} />
                <div className="flex-1">
                  <div className="h-2 bg-white/15 rounded w-20 mb-1.5" />
                  <div className="h-2 bg-white/10 rounded w-full" />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {i === 2 && (
        /* Routing */
        <div className="flex flex-col items-center gap-3 sm:gap-4 h-full justify-center max-w-sm mx-auto">
          <div className="bg-white/[0.08] rounded-xl px-4 py-2.5 flex items-center gap-2">
            <div className="w-5 h-5 rounded-full bg-green-500/40" />
            <div className="h-2.5 bg-white/20 rounded w-20 sm:w-24" />
          </div>
          <svg width="80" height="40" viewBox="0 0 80 40" className="text-white/20">
            <path d="M40 0 V15 M40 15 L15 35 M40 15 L65 35" stroke="currentColor" strokeWidth="1.5" fill="none" />
          </svg>
          <div className="flex gap-4 sm:gap-6 w-full justify-center">
            {["Sales", "Support"].map(label => (
              <div key={label} className="bg-primary-500/15 border border-primary-500/20 rounded-xl px-3 sm:px-4 py-2.5 sm:py-3 text-center">
                <div className="w-7 sm:w-8 h-7 sm:h-8 rounded-full bg-primary-500/30 mx-auto mb-2" />
                <span className="text-[10px] text-primary-300 font-medium">{label}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {i === 3 && (
        /* Knowledge */
        <div className="flex flex-col gap-3 sm:gap-4 h-full justify-center max-w-xs mx-auto">
          <div className="bg-white/[0.06] rounded-xl px-3 sm:px-4 py-2.5 flex items-center gap-2 border border-white/[0.06]">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-white/40 flex-shrink-0"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /></svg>
            <div className="h-2.5 bg-white/15 rounded w-24 sm:w-32" />
          </div>
          <div className="grid grid-cols-2 gap-2 sm:gap-2.5">
            {[1, 2, 3, 4].map(n => (
              <div key={n} className="bg-white/[0.05] rounded-xl p-2.5 sm:p-3 border border-white/[0.04]">
                <div className="h-2 bg-white/15 rounded w-full mb-2" />
                <div className="h-2 bg-white/10 rounded w-3/4 mb-2" />
                <div className="h-2 bg-white/10 rounded w-1/2" />
              </div>
            ))}
          </div>
        </div>
      )}
      {i === 4 && (
        /* Analytics */
        <div className="flex flex-col gap-3 sm:gap-4 h-full justify-center max-w-xs mx-auto">
          <div className="grid grid-cols-3 gap-2 sm:gap-2.5">
            {["#7c5cfc", "#06b6d4", "#22c55e"].map(color => (
              <div key={color} className="bg-white/[0.06] rounded-xl p-2.5 sm:p-3 text-center">
                <div className="text-sm font-bold mb-1" style={{ color }}>--</div>
                <div className="h-2 bg-white/10 rounded w-10 sm:w-12 mx-auto" />
              </div>
            ))}
          </div>
          <div className="bg-white/[0.04] rounded-xl p-3 sm:p-4 flex items-end gap-1.5 sm:gap-2 h-24 sm:h-32">
            {[40, 65, 45, 80, 55, 70, 90, 60, 75, 85].map((h, j) => (
              <div key={j} className="flex-1 rounded-t" style={{ height: `${h}%`, background: j === 9 ? "#7c5cfc" : "rgba(124,92,252,0.25)" }} />
            ))}
          </div>
        </div>
      )}
      {i === 5 && (
        /* Bot Builder */
        <div className="flex flex-col items-center gap-2 sm:gap-3 h-full justify-center max-w-xs mx-auto">
          {[
            { label: "Trigger", color: "bg-blue-500/25 border-blue-500/30" },
            { label: "Condition", color: "bg-amber-500/25 border-amber-500/30" },
            { label: "Reply", color: "bg-green-500/25 border-green-500/30" },
          ].map((node, ni) => (
            <div key={node.label}>
              {ni > 0 && <div className="w-px h-3 sm:h-4 bg-white/15 mx-auto mb-2 sm:mb-3" />}
              <div className={`${node.color} border rounded-xl px-5 sm:px-6 py-2.5 sm:py-3 text-center`}>
                <span className="text-[11px] text-white/70 font-medium">{node.label}</span>
                <div className="h-2 bg-white/15 rounded w-20 mx-auto mt-1.5" />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ───── Main Component ───── */

export default function LandingPage({ forcedLocale }: { forcedLocale?: Locale }) {
  const { t, locale, setLocale, dir } = useI18n();
  const featuresRef = useRef<HTMLElement>(null);
  const [activeFeature, setActiveFeature] = useState(0);
  const [navDark, setNavDark] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    if (forcedLocale && forcedLocale !== locale) {
      setLocale(forcedLocale);
    }
  }, [forcedLocale, locale, setLocale]);

  useEffect(() => {
    const features = featuresRef.current;
    if (!features) return;
    const onScroll = () => {
      const rect = features.getBoundingClientRect();
      const scrolled = -rect.top;
      const sectionHeight = rect.height - window.innerHeight;
      if (sectionHeight > 0) {
        const progress = Math.min(1, Math.max(0, scrolled / sectionHeight));
        const idx = Math.min(featureKeys.length - 1, Math.floor(progress * featureKeys.length));
        setActiveFeature(idx);
        features.style.setProperty("--fp", String(progress));
      }
      // Check if nav overlaps a dark section
      const darkEls = document.querySelectorAll(".landing-features, .landing-dark-section");
      let overDark = false;
      darkEls.forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.top < 60 && r.bottom > 60) overDark = true;
      });
      setNavDark(overDark);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const otherLabel = locale === "en" ? "עברית" : "English";
  const otherPath = locale === "en" ? "/he" : "/en";
  const isRtl = dir === "rtl";

  return (
    <div dir={dir} className="min-h-screen bg-white text-black" style={{ overflowX: "clip" }}>

      {/* ───── Structured Data (JSON-LD) ───── */}
      <JsonLd data={{
        "@context": "https://schema.org",
        "@type": "Organization",
        name: "GOTCHA",
        url: "https://gotcha.co.il",
        logo: "https://gotcha.co.il/logo.png",
        description: "AI-powered customer communication platform that unifies WhatsApp, Messenger, and Instagram into one smart inbox.",
      }} />
      <JsonLd data={{
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        name: "GOTCHA",
        applicationCategory: "BusinessApplication",
        operatingSystem: "Web",
        url: "https://gotcha.co.il",
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD", description: "Free tier available" },
        description: "AI-powered multi-channel customer communication platform with smart routing, co-pilot, and analytics.",
      }} />
      <JsonLd data={{
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: ((t("landing.faq.items") as unknown) as { q: string; a: string }[])?.map((item) => ({
          "@type": "Question",
          name: item.q,
          acceptedAnswer: { "@type": "Answer", text: item.a },
        })) ?? [],
      }} />

      {/* ───── Floating Nav ───── */}
      <header className="fixed top-0 inset-x-0 z-50 flex justify-center pt-3 sm:pt-4 px-3 sm:px-4">
        <nav className={`w-full max-w-[1240px] flex items-center justify-between px-4 sm:px-5 py-2.5 rounded-2xl backdrop-blur-xl border transition-colors duration-500 ${
          navDark
            ? "bg-white/[0.06] border-white/[0.08] shadow-[0_2px_20px_rgba(0,0,0,0.3)]"
            : "bg-white/80 border-gray-200/60 shadow-[0_2px_20px_rgba(0,0,0,0.06)]"
        }`}>
          <div className="flex items-center gap-6">
            <Logo light={navDark} />
            <div className="hidden md:flex items-center gap-1">
              <a href="#features" className={`px-3.5 py-1.5 text-[13px] font-medium rounded-full transition-all ${
                navDark ? "text-white/60 hover:text-white hover:bg-white/10" : "text-gray-500 hover:text-black hover:bg-gray-100/80"
              }`}>
                {t("landing.nav.features")}
              </a>
              <a href="#how-it-works" className={`px-3.5 py-1.5 text-[13px] font-medium rounded-full transition-all ${
                navDark ? "text-white/60 hover:text-white hover:bg-white/10" : "text-gray-500 hover:text-black hover:bg-gray-100/80"
              }`}>
                {t("landing.nav.channels")}
              </a>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="hidden md:flex items-center gap-2">
              <LocaleDropdown locale={locale} setLocale={setLocale} />
              <Link href="/login" className={`px-3.5 py-1.5 text-[13px] font-medium rounded-full transition-all ${
                navDark ? "text-white/70 hover:text-white hover:bg-white/10" : "text-gray-600 hover:text-black hover:bg-gray-100/80"
              }`}>
                {t("landing.nav.login")}
              </Link>
            </div>
            <Link href="/login" className="hidden sm:inline-flex px-5 py-2 text-[13px] font-semibold text-white bg-primary-500 rounded-full hover:bg-primary-600 transition-all">
              {t("landing.nav.getStarted")}
            </Link>
            {/* Mobile hamburger */}
            <button
              onClick={() => setMobileMenuOpen(true)}
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
      <MobileMenu open={mobileMenuOpen} onClose={() => setMobileMenuOpen(false)} t={t} locale={locale} setLocale={setLocale} navDark={navDark} />

      {/* ───── Hero: Split Layout ───── */}
      <section className="relative min-h-[80vh] sm:min-h-[95vh] flex items-center px-4 sm:px-12 lg:px-20 pt-20 sm:pt-24 pb-12 sm:pb-0 overflow-hidden bg-white">
        {/* Subtle gradient spots */}
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -top-32 -left-32 w-[400px] sm:w-[600px] h-[400px] sm:h-[600px] rounded-full opacity-[0.08]" style={{ background: "radial-gradient(circle, #9b59b6 0%, #7c3aed 40%, transparent 70%)", filter: "blur(80px)" }} />
          <div className="absolute top-1/4 -right-40 w-[400px] sm:w-[650px] h-[400px] sm:h-[650px] rounded-full opacity-[0.07]" style={{ background: "radial-gradient(circle, #06b6d4 0%, #3b82f6 40%, transparent 70%)", filter: "blur(90px)" }} />
        </div>
        {/* Grid overlay */}
        <div className="landing-hero-grid pointer-events-none absolute inset-0" />

        <div className="max-w-[1240px] mx-auto w-full flex flex-col lg:flex-row items-center gap-8 sm:gap-12 lg:gap-16 relative z-10">
          {/* Text side */}
          <div className={`flex-1 max-w-xl text-center lg:text-start ${isRtl ? "lg:order-2" : ""}`}>
            <h1 className="landing-fade-in mb-4 sm:mb-5">
              <span className="block text-[clamp(1.7rem,5vw,3.2rem)] font-light leading-[1.12] tracking-[-0.03em] text-black">
                {t("landing.hero.title1")}{" "}
                <RotatingPlatform locale={locale} />
              </span>
              <span className="block text-[clamp(1.15rem,3.5vw,2rem)] font-extralight leading-[1.2] tracking-[-0.02em] text-[#757575] mt-2 sm:mt-3">
                {t("landing.hero.title2")}
              </span>
            </h1>
            <p className="text-[15px] sm:text-[17px] leading-[1.6] font-light text-[#757575] mb-6 sm:mb-8 landing-fade-in landing-delay-1">
              {t("landing.hero.subtitle")}
            </p>
            <div className="flex flex-wrap gap-3 landing-fade-in landing-delay-2 justify-center lg:justify-start">
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
      <section className="py-10 sm:py-14 px-4 sm:px-6 border-t border-gray-100">
        <div className="max-w-[1240px] mx-auto">
          <p className="text-xs font-medium text-[#a3a3a3] uppercase tracking-[0.15em] mb-6 sm:mb-8 text-center">{t("landing.hero.trustedBy")}</p>
          <div className="landing-marquee">
          <div className="landing-marquee-track">
            {[0, 1, 2, 3].map((copy) => (
              <div key={copy} className="flex items-center gap-10 sm:gap-20 px-5 sm:px-10 flex-shrink-0" aria-hidden={copy > 0}>
                <img src="/integrations/whatsapp.svg" alt="WhatsApp" className="h-6 sm:h-8 flex-shrink-0 object-contain" />
                <img src="/integrations/facebook.svg" alt="Facebook Messenger" className="h-6 sm:h-8 flex-shrink-0 object-contain" />
                <img src="/integrations/instagram.svg" alt="Instagram" className="h-6 sm:h-8 flex-shrink-0 object-contain" />
                <img src="/integrations/gmail.svg" alt="Gmail" className="h-6 sm:h-8 flex-shrink-0 object-contain" />
              </div>
            ))}
          </div>
        </div>
        </div>
      </section>

      {/* ───── Features (scroll-linked: left sticky, right scrolls) ───── */}
      <section
        id="features"
        ref={featuresRef}
        className="landing-features relative"
        style={{ "--fp": "0" } as React.CSSProperties}
      >
        {/* Grid overlay — covers full section */}
        <div className="landing-features-grid pointer-events-none absolute inset-0" style={{ zIndex: 1 }} />

        {/* Rotating gradient blobs (shared background) */}
        <div className="landing-features-gradients pointer-events-none absolute -inset-20 overflow-hidden">
          <div className="absolute top-[10%] left-0 w-[300px] sm:w-[500px] h-[300px] sm:h-[500px] rounded-full opacity-[0.18]" style={{ background: "radial-gradient(circle, #7C3291 0%, transparent 70%)", filter: "blur(100px)" }} />
          <div className="absolute top-[40%] right-0 w-[250px] sm:w-[400px] h-[250px] sm:h-[400px] rounded-full opacity-[0.15]" style={{ background: "radial-gradient(circle, #5A72B3 0%, transparent 70%)", filter: "blur(100px)" }} />
          <div className="absolute bottom-[10%] left-[20%] w-[300px] sm:w-[500px] h-[300px] sm:h-[500px] rounded-full opacity-[0.18]" style={{ background: "radial-gradient(circle, #6DCED9 0%, transparent 70%)", filter: "blur(100px)" }} />
        </div>

        {/* ── Desktop: sticky left + scrolling right ── */}
        <div className={`relative hidden lg:flex max-w-[1240px] mx-auto px-6 sm:px-12 lg:px-20 ${isRtl ? "lg:flex-row-reverse" : ""}`} style={{ zIndex: 2 }}>
          {/* Left: sticky text */}
          <div className="lg:sticky lg:top-0 lg:h-screen flex-1 flex items-center">
            <div className="relative">
              <p className="text-xs font-medium text-primary-400 uppercase tracking-[0.15em] mb-6">
                {t("landing.features.label")}
              </p>
              <div className="relative min-h-[180px]">
                {featureKeys.map((key, i) => {
                  const Icon = featureIcons[i];
                  const isActive = i === activeFeature;
                  return (
                    <div
                      key={key}
                      className={`transition-all duration-700 ${
                        isActive
                          ? "opacity-100 translate-y-0 relative"
                          : i < activeFeature
                            ? "opacity-0 -translate-y-4 absolute inset-0 pointer-events-none"
                            : "opacity-0 translate-y-4 absolute inset-0 pointer-events-none"
                      }`}
                      style={{ transitionTimingFunction: "cubic-bezier(0.16, 1, 0.3, 1)" }}
                    >
                      <div className="w-11 h-11 rounded-xl bg-primary-500/20 text-primary-400 flex items-center justify-center mb-5">
                        <Icon />
                      </div>
                      <h3 className="text-[clamp(1.3rem,2.5vw,1.75rem)] font-semibold tracking-[-0.02em] leading-[1.2] mb-3 text-white">
                        {t(`landing.features.${key}.title`)}
                      </h3>
                      <p className="text-[#a3a3a3] text-base leading-[1.7]">
                        {t(`landing.features.${key}.desc`)}
                      </p>
                    </div>
                  );
                })}
              </div>
              {/* Progress dots */}
              <div className="flex gap-2 mt-8">
                {featureKeys.map((_, i) => (
                  <div
                    key={i}
                    className={`h-1.5 rounded-full transition-all duration-700 ease-out ${
                      i === activeFeature ? "w-8 bg-primary-500" : "w-1.5 bg-white/20"
                    }`}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* Right: scrolling panels — each feature gets a full viewport height */}
          <div className="flex-1 max-w-xl">
            {featureKeys.map((key, i) => (
              <div key={key} className="h-screen flex items-center justify-center px-4 lg:px-8">
                <FeatureVisual index={i} />
              </div>
            ))}
          </div>
        </div>

        {/* ── Mobile: stacked cards ── */}
        <div className="lg:hidden relative px-4 sm:px-8 py-14 sm:py-20" style={{ zIndex: 2 }}>
          <div className="text-center mb-10">
            <p className="text-xs font-medium text-primary-400 uppercase tracking-[0.15em] mb-3">
              {t("landing.features.label")}
            </p>
          </div>
          <div className="flex flex-col gap-8 max-w-md mx-auto">
            {featureKeys.map((key, i) => {
              const Icon = featureIcons[i];
              return (
                <div key={key}>
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-9 h-9 rounded-lg bg-primary-500/20 text-primary-400 flex items-center justify-center flex-shrink-0">
                      <Icon />
                    </div>
                    <h3 className="text-lg font-semibold text-white tracking-[-0.01em]">
                      {t(`landing.features.${key}.title`)}
                    </h3>
                  </div>
                  <p className="text-[#a3a3a3] text-sm leading-[1.7] mb-4">
                    {t(`landing.features.${key}.desc`)}
                  </p>
                  <FeatureVisual index={i} />
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ───── How It Works: Zigzag ───── */}
      <section id="how-it-works" className="py-14 sm:py-28 px-4 sm:px-12 lg:px-20 bg-white">
        <div className="max-w-[1240px] mx-auto">
          {/* Header */}
          <div className="text-center max-w-xl mx-auto mb-10 sm:mb-20">
            <p className="text-xs font-medium text-primary-500 uppercase tracking-[0.15em] mb-3">
              {t("landing.howItWorks.label")}
            </p>
            <h2 className="text-[clamp(1.5rem,3.5vw,2.5rem)] font-semibold tracking-[-0.03em] leading-[1.15] mb-4">
              {t("landing.howItWorks.title")}
            </h2>
            <p className="text-[#757575] text-sm sm:text-base">
              {t("landing.howItWorks.subtitle")}
            </p>
          </div>

          {/* Zigzag steps */}
          <div className="flex flex-col gap-0">
            {(["step1", "step2", "step3", "step4"] as const).map((step, i) => {
              const reverseRow = i % 2 === 1;
              return (
                <div key={step}>
                  {i > 0 && (
                    <div className="flex justify-center py-6 sm:py-14">
                      <div className="w-px h-10 sm:h-16 bg-gradient-to-b from-gray-200 to-transparent" />
                    </div>
                  )}
                <div
                  className={`flex flex-col lg:flex-row items-center gap-6 sm:gap-10 lg:gap-16 ${
                    (reverseRow && !isRtl) || (!reverseRow && isRtl) ? "lg:flex-row-reverse" : ""
                  }`}
                >
                  {/* Text */}
                  <div className="flex-1 max-w-lg">
                    <div className="flex items-center gap-3 mb-3 sm:mb-4">
                      <div className="flex-shrink-0 w-9 sm:w-10 h-9 sm:h-10 rounded-full bg-primary-500 text-white flex items-center justify-center text-sm font-bold">
                        {i + 1}
                      </div>
                      <h3 className="text-lg sm:text-2xl font-semibold tracking-[-0.02em]">
                        {t(`landing.howItWorks.${step}.title`)}
                      </h3>
                    </div>
                    <p className="text-[#757575] text-sm sm:text-base leading-[1.7] ps-12 sm:ps-[52px]">
                      {t(`landing.howItWorks.${step}.desc`)}
                    </p>
                  </div>

                  {/* Visual */}
                  <div className="flex-1 w-full max-w-md">
                    <div
                      className="bg-[#1a1a2e] rounded-2xl border border-white/[0.06] p-5 sm:p-8 overflow-hidden"
                      style={{ aspectRatio: "4/3", boxShadow: "0 6px 30px rgba(0,0,0,0.15)" }}
                    >
                      {i === 0 && (
                        /* Workspace setup */
                        <div className="flex flex-col gap-3 h-full justify-center max-w-xs mx-auto">
                          <div className="bg-white/[0.06] rounded-xl p-3 flex items-center gap-3">
                            <div className="w-8 h-8 rounded-lg bg-primary-500/30" />
                            <div className="flex-1">
                              <div className="h-2.5 bg-white/20 rounded w-24 mb-1.5" />
                              <div className="h-2 bg-white/10 rounded w-16" />
                            </div>
                          </div>
                          <div className="flex gap-2.5 mt-2">
                            {["whatsapp", "facebook", "instagram", "gmail"].map(ch => (
                              <div key={ch} className="flex-1 bg-white/[0.04] rounded-xl p-3 border border-white/[0.06] flex flex-col items-center gap-2">
                                <img src={`/integrations/${ch}.svg`} alt="" className="h-6 opacity-70" />
                                <div className="w-3 h-3 rounded-full bg-green-500/50" />
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {i === 1 && (
                        /* Train AI */
                        <div className="flex flex-col gap-3 h-full justify-center max-w-xs mx-auto">
                          <div className="bg-primary-500/15 border border-primary-500/20 rounded-xl p-4">
                            <div className="flex items-center gap-2 mb-3">
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-primary-400"><path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25" /></svg>
                              <span className="text-[11px] text-primary-300 font-medium">Knowledge Base</span>
                            </div>
                            <div className="space-y-2">
                              <div className="h-2 bg-white/15 rounded w-full" />
                              <div className="h-2 bg-white/15 rounded w-4/5" />
                              <div className="h-2 bg-white/15 rounded w-3/5" />
                            </div>
                          </div>
                          <div className="bg-white/[0.06] rounded-xl p-3 flex items-center gap-2">
                            <div className="w-6 h-6 rounded-full bg-green-500/30 flex items-center justify-center">
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="text-green-400"><path d="M5 13l4 4L19 7" /></svg>
                            </div>
                            <span className="text-[11px] text-white/50">Brand voice configured</span>
                          </div>
                        </div>
                      )}
                      {i === 2 && (
                        /* Deploy agents */
                        <div className="flex flex-col gap-3 h-full justify-center max-w-xs mx-auto">
                          {["Agent A", "Agent B", "Agent C"].map((agent, ai) => (
                            <div key={agent} className="bg-white/[0.04] rounded-xl p-3 flex items-center gap-3 border border-white/[0.04]">
                              <div className={`w-8 h-8 rounded-full ${ai === 0 ? "bg-primary-500/30" : ai === 1 ? "bg-cyan-500/30" : "bg-amber-500/30"}`} />
                              <div className="flex-1">
                                <div className="h-2.5 bg-white/15 rounded w-16 mb-1.5" />
                                <div className="h-2 bg-white/10 rounded w-24" />
                              </div>
                              <div className="flex gap-1">
                                <div className="w-5 h-5 rounded bg-green-500/20" />
                                <div className="w-5 h-5 rounded bg-blue-500/20" />
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                      {i === 3 && (
                        /* Engage everywhere */
                        <div className="flex flex-col gap-3 h-full justify-center">
                          <ProductMockup dark />
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ───── FAQ ───── */}
      <section className="py-14 sm:py-28 px-4 sm:px-12 lg:px-20 bg-gray-50/50">
        <div className="max-w-[720px] mx-auto">
          <div className="text-center mb-8 sm:mb-12">
            <p className="text-xs font-medium text-primary-500 uppercase tracking-[0.15em] mb-3">
              {t("landing.faq.label")}
            </p>
            <h2 className="text-[clamp(1.5rem,3.5vw,2.5rem)] font-semibold tracking-[-0.03em] leading-[1.15]">
              {t("landing.faq.title")}
            </h2>
          </div>
          <div className="bg-white rounded-2xl border border-gray-100 px-4 sm:px-8 shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
            {((t("landing.faq.items") as unknown) as { q: string; a: string }[])?.map?.((item, i) => (
              <FaqItem key={i} question={item.q} answer={item.a} />
            )) ?? null}
          </div>
        </div>
      </section>

      {/* ───── CTA ───── */}
      <section className="py-14 sm:py-28 px-4 sm:px-6">
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
      <footer className="border-t border-gray-100 py-8 sm:py-10 px-4 sm:px-12 lg:px-20">
        <div className="max-w-[1240px] mx-auto">
          <div className="flex flex-col md:flex-row justify-between gap-8">
            <div className="max-w-xs">
              <Logo />
              <p className="mt-3 text-sm text-[#a3a3a3] leading-relaxed">
                {t("landing.hero.subtitle").slice(0, 80)}...
              </p>
            </div>

            <div className="grid grid-cols-3 gap-6 sm:gap-8 text-sm">
              <div>
                <h4 className="font-semibold text-black mb-2.5 sm:mb-3 text-[13px]">{t("landing.footer.product")}</h4>
                <ul className="space-y-1.5 sm:space-y-2 text-[#757575]">
                  <li><a href="#features" className="hover:text-black transition-colors text-[13px] inline-block py-0.5">{t("landing.nav.features")}</a></li>
                  <li><a href="#channels" className="hover:text-black transition-colors text-[13px] inline-block py-0.5">{t("landing.nav.channels")}</a></li>
                </ul>
              </div>
              <div>
                <h4 className="font-semibold text-black mb-2.5 sm:mb-3 text-[13px]">{t("landing.footer.company")}</h4>
                <ul className="space-y-1.5 sm:space-y-2 text-[#757575]">
                  <li><a href="#" className="hover:text-black transition-colors text-[13px] inline-block py-0.5">{t("landing.footer.about")}</a></li>
                  <li><a href="#" className="hover:text-black transition-colors text-[13px] inline-block py-0.5">{t("landing.footer.blog")}</a></li>
                </ul>
              </div>
              <div>
                <h4 className="font-semibold text-black mb-2.5 sm:mb-3 text-[13px]">{t("landing.footer.legal")}</h4>
                <ul className="space-y-1.5 sm:space-y-2 text-[#757575]">
                  <li><Link href="/privacy-policy" className="hover:text-black transition-colors text-[13px] inline-block py-0.5">{t("landing.footer.privacy")}</Link></li>
                  <li><Link href="/terms" className="hover:text-black transition-colors text-[13px] inline-block py-0.5">{t("landing.footer.terms")}</Link></li>
                </ul>
              </div>
            </div>
          </div>

          <div className="mt-6 sm:mt-8 pt-5 sm:pt-6 border-t border-gray-100 flex flex-col sm:flex-row items-center justify-between gap-3 text-[13px] text-[#a3a3a3]">
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
