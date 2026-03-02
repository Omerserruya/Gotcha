"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useI18n } from "@/context/I18nContext";
import type { Locale } from "@/i18n";
import JsonLd from "@/components/JsonLd";

/* ───── Scroll Story: Platform Config ───── */

const INBOX_PLATFORMS = [
  { name: "WhatsApp", color: "#25D366", icon: "/platforms/wa-logo.png", badge: 12, contact: "Sarah M.", initial: "S", message: "Hi, is my order on the way?" },
  { name: "Instagram", color: "#E1306C", icon: "/platforms/ins-logo.png", badge: 8, contact: "david_k", initial: "D", message: "Hey can I return this?" },
  { name: "Messenger", color: "#0084FF", icon: "/platforms/fb-logo.png", badge: 23, contact: "Rachel B.", initial: "R", message: "When does the sale end?" },
  { name: "Gmail", color: "#EA4335", icon: "/platforms/gm-logo.png", badge: 4, contact: "Mike Johnson", initial: "M", message: "RE: Invoice #4812 question" },
  { name: "Facebook", color: "#1877F2", icon: "/platforms/fb-logo.png", badge: 3, contact: "TechStore", initial: "T", message: "New message from customer" },
] as const;

const CHAOS_POSITIONS = [
  { x: -240, y: -130, rotate: -10, scale: 0.88 },
  { x: 210,  y: -85,  rotate: 7,   scale: 0.92 },
  { x: -150, y: 30,   rotate: -14, scale: 0.85 },
  { x: 190,  y: 110,  rotate: 5,   scale: 0.9 },
  { x: 10,   y: 185,  rotate: -3,  scale: 0.87 },
];

const STACKED_POSITIONS = [
  { x: 0, y: -116 },
  { x: 0, y: -58 },
  { x: 0, y: 0 },
  { x: 0, y: 58 },
  { x: 0, y: 116 },
];

/* ───── Product Features Config ───── */

const PRODUCT_FEATURES = [
  {
    key: "unifiedInbox",
    gradient: "from-primary-500/10 to-purple-500/10",
    iconColor: "text-primary-500",
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 8V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2" />
        <path d="m7 8 5 4 5-4" />
      </svg>
    ),
  },
  {
    key: "aiCopilot",
    gradient: "from-cyan-500/10 to-blue-500/10",
    iconColor: "text-cyan-500",
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09Z" />
        <path d="M18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 0 0-2.455 2.456Z" />
      </svg>
    ),
  },
  {
    key: "smartBot",
    gradient: "from-amber-500/10 to-orange-500/10",
    iconColor: "text-amber-500",
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z" />
      </svg>
    ),
  },
  {
    key: "knowledgeBase",
    gradient: "from-green-500/10 to-emerald-500/10",
    iconColor: "text-green-500",
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25" />
      </svg>
    ),
  },
  {
    key: "smartRouting",
    gradient: "from-blue-500/10 to-indigo-500/10",
    iconColor: "text-blue-500",
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M7.5 21 3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
      </svg>
    ),
  },
  {
    key: "analytics",
    gradient: "from-rose-500/10 to-pink-500/10",
    iconColor: "text-rose-500",
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z" />
      </svg>
    ),
  },
] as const;

/* ───── ConversationItem (for chaos + stack phases) ───── */

function ConversationItem({ platform, index, progress, isRtl }: {
  platform: typeof INBOX_PLATFORMS[number];
  index: number;
  progress: number;
  isRtl: boolean;
}) {
  const chaos = CHAOS_POSITIONS[index];
  const stacked = STACKED_POSITIONS[index];
  const xSign = isRtl ? -1 : 1;

  // Phase 1 (0–0.25): chaos
  // Phase 2 (0.25–0.50): converge to stacked list
  // Phase 3 (0.45–0.60): fade out as InboxDemo fades in
  const stackStart = 0.25;
  const stackEnd = 0.50;
  const fadeStart = 0.45;
  const fadeEnd = 0.60;

  let x: number, y: number, rotate: number, scale: number;
  let opacity = 1;

  if (progress < stackStart) {
    // Full chaos
    x = chaos.x * xSign;
    y = chaos.y;
    rotate = chaos.rotate;
    scale = chaos.scale;
  } else if (progress < stackEnd) {
    // Interpolate chaos → stacked
    const sub = (progress - stackStart) / (stackEnd - stackStart);
    const eased = 1 - Math.pow(1 - sub, 3);
    x = (chaos.x * xSign) * (1 - eased) + stacked.x * eased;
    y = chaos.y * (1 - eased) + stacked.y * eased;
    rotate = chaos.rotate * (1 - eased);
    scale = chaos.scale + (1 - chaos.scale) * eased;
  } else {
    // Fully stacked
    x = stacked.x;
    y = stacked.y;
    rotate = 0;
    scale = 1;
  }

  // Fade out during crossfade
  if (progress > fadeStart) {
    opacity = Math.max(0, 1 - (progress - fadeStart) / (fadeEnd - fadeStart));
  }

  return (
    <div
      className="absolute w-[270px] sm:w-[310px]"
      style={{
        transform: `translate(${x}px, ${y}px) rotate(${rotate}deg) scale(${scale})`,
        opacity,
        willChange: "transform, opacity",
      }}
    >
      <div className="relative bg-[#1a1a2e] rounded-xl border border-white/[0.06] px-3 py-2.5 flex items-center gap-2.5 shadow-[0_4px_24px_rgba(0,0,0,0.35)]">
        {/* Avatar */}
        <div className="w-9 h-9 rounded-full bg-gradient-to-br from-primary-400/30 to-primary-600/30 flex items-center justify-center flex-shrink-0">
          <span className="text-[11px] font-bold text-white/70">{platform.initial}</span>
        </div>
        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between mb-0.5">
            <span className="text-[11px] font-semibold text-white/80 truncate">{platform.contact}</span>
            <span className="text-[9px] text-white/30 flex-shrink-0 ms-2">2m</span>
          </div>
          <p className="text-[10px] text-white/40 truncate">{platform.message}</p>
        </div>
        {/* Platform icon (right side, prominent) */}
        <img src={platform.icon} alt={platform.name} className="w-6 h-6 flex-shrink-0" />
        {/* Unread badge */}
        <div
          className={`absolute -top-1.5 -end-1.5 min-w-[18px] h-[18px] px-1 rounded-full flex items-center justify-center text-[8px] font-bold text-white ${progress < stackStart ? "badge-pulse" : ""}`}
          style={{ background: platform.color }}
        >
          {platform.badge}
        </div>
      </div>
    </div>
  );
}

/* ───── InboxDemo (realistic app mockup) ───── */

function InboxDemo({ copilotProgress, isRtl, t }: {
  copilotProgress: number; // 0 = hidden, 1 = fully visible
  isRtl: boolean;
  t: (key: string) => string;
}) {
  const copilotEased = 1 - Math.pow(1 - copilotProgress, 3);
  const copilotTranslate = (1 - copilotEased) * (isRtl ? -100 : 100);

  return (
    <div className="w-[820px] max-w-[90vw] bg-[#12121f] rounded-2xl border border-white/[0.06] overflow-hidden shadow-[0_8px_48px_rgba(0,0,0,0.4)]">
      {/* Browser chrome */}
      <div className="flex items-center gap-2 px-4 py-2 bg-[#0d0d18] border-b border-white/[0.04]">
        <div className="flex gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full bg-[#ff5f57]" />
          <div className="w-2.5 h-2.5 rounded-full bg-[#febc2e]" />
          <div className="w-2.5 h-2.5 rounded-full bg-[#28c840]" />
        </div>
        <div className="flex-1 mx-8">
          <div className="h-4 bg-white/[0.04] rounded max-w-[180px] mx-auto" />
        </div>
      </div>

      {/* App body */}
      <div className="flex h-[380px] sm:h-[420px]" style={{ "--cp": copilotEased } as React.CSSProperties}>
        {/* Sidebar nav */}
        <div className={`hidden sm:flex flex-col w-11 bg-white/[0.02] border-white/[0.04] py-3 gap-2.5 items-center flex-shrink-0 ${isRtl ? "border-s" : "border-e"}`}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className={`w-7 h-7 rounded-lg ${i === 0 ? "bg-primary-500/20" : "bg-white/[0.04]"}`} />
          ))}
        </div>

        {/* Conversation list */}
        <div className={`inbox-demo-convlist w-[180px] sm:w-[200px] bg-white/[0.02] flex flex-col flex-shrink-0 ${isRtl ? "border-s border-white/[0.04]" : "border-e border-white/[0.04]"}`}>
          {/* Search */}
          <div className="p-2">
            <div className="h-7 bg-white/[0.04] rounded-lg" />
          </div>
          {/* My Active section */}
          <div className="px-2 py-1">
            <span className="text-[8px] font-semibold text-primary-400 uppercase tracking-wider">{t("landing.features.myActive")}</span>
          </div>
          {/* Active items */}
          {INBOX_PLATFORMS.slice(0, 2).map((p, i) => (
            <div key={p.name} className={`mx-1.5 mb-1 px-2 py-1.5 rounded-lg flex items-center gap-2 ${i === 0 ? "bg-primary-500/10 border border-primary-500/15" : "bg-white/[0.02]"}`}>
              <div className="w-7 h-7 rounded-full bg-gradient-to-br from-primary-400/30 to-primary-600/30 flex items-center justify-center flex-shrink-0">
                <span className="text-[8px] font-bold text-white/70">{p.initial}</span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1">
                  <span className="text-[9px] font-semibold text-white/80 truncate">{p.contact}</span>
                  <img src={p.icon} alt="" className="w-4 h-4 flex-shrink-0" />
                </div>
                <p className="text-[8px] text-white/30 truncate">{p.message}</p>
              </div>
              {i === 0 && <div className="w-1.5 h-1.5 rounded-full bg-primary-400 flex-shrink-0" />}
            </div>
          ))}
          {/* Queue section */}
          <div className="px-2 py-1 mt-1">
            <span className="text-[8px] font-semibold text-white/30 uppercase tracking-wider">{t("landing.features.queue")}</span>
          </div>
          {INBOX_PLATFORMS.slice(2, 5).map((p) => (
            <div key={p.name} className="mx-1.5 mb-1 px-2 py-1.5 rounded-lg flex items-center gap-2 bg-white/[0.02]">
              <div className="w-7 h-7 rounded-full bg-gradient-to-br from-white/[0.06] to-white/[0.03] flex items-center justify-center flex-shrink-0">
                <span className="text-[8px] font-bold text-white/50">{p.initial}</span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1">
                  <span className="text-[9px] font-medium text-white/60 truncate">{p.contact}</span>
                  <img src={p.icon} alt="" className="w-4 h-4 flex-shrink-0 opacity-60" />
                </div>
                <p className="text-[8px] text-white/25 truncate">{p.message}</p>
              </div>
            </div>
          ))}
        </div>

        {/* Chat area */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Chat header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-white/[0.04]">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-full bg-gradient-to-br from-primary-400/30 to-primary-600/30 flex items-center justify-center">
                <span className="text-[9px] font-bold text-white/70">S</span>
              </div>
              <div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] font-semibold text-white/80">Sarah M.</span>
                  <span className="text-[7px] px-1.5 py-0.5 rounded-full bg-green-500/15 text-green-400 font-medium">WhatsApp</span>
                </div>
                <span className="text-[8px] text-white/30">+972 50-123-4567</span>
              </div>
            </div>
            <div className="flex gap-1.5">
              <div className="px-2 py-1 rounded-md bg-primary-500/15 text-[8px] font-medium text-primary-300">Claim</div>
              <div className="px-2 py-1 rounded-md bg-white/[0.04] text-[8px] font-medium text-white/40">Transfer</div>
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 p-3 space-y-2 overflow-hidden bg-white/[0.01]">
            {/* Bot greeting */}
            <div className={`flex ${isRtl ? "justify-end" : "justify-start"}`}>
              <div className="max-w-[75%] bg-amber-500/10 border border-amber-500/10 rounded-xl rounded-tl-sm px-3 py-1.5">
                <div className="flex items-center gap-1 mb-0.5">
                  <span className="text-[7px] text-amber-400 font-semibold">BOT</span>
                </div>
                <p className="text-[9px] text-white/60 leading-[1.5]">{t("landing.features.botGreeting")}</p>
              </div>
            </div>
            {/* Customer message */}
            <div className={`flex ${isRtl ? "justify-start" : "justify-end"}`}>
              <div className="max-w-[75%] bg-white/[0.06] rounded-xl rounded-tr-sm px-3 py-1.5">
                <p className="text-[9px] text-white/70 leading-[1.5]">{t("landing.features.customerMsg")}</p>
              </div>
            </div>
            {/* Bot handover reply */}
            <div className={`flex ${isRtl ? "justify-end" : "justify-start"}`}>
              <div className="max-w-[75%] bg-amber-500/10 border border-amber-500/10 rounded-xl rounded-tl-sm px-3 py-1.5">
                <p className="text-[9px] text-white/60 leading-[1.5]">{t("landing.features.botReply")}</p>
              </div>
            </div>
            {/* System divider: bot handover */}
            <div className="flex items-center gap-2 py-1">
              <div className="flex-1 h-px bg-amber-500/20" />
              <span className="text-[7px] text-amber-400/70 font-medium whitespace-nowrap">{t("landing.features.botDivider")}</span>
              <div className="flex-1 h-px bg-amber-500/20" />
            </div>
            {/* System divider: agent joined */}
            <div className="flex items-center gap-2 py-0.5">
              <div className="flex-1 h-px bg-green-500/20" />
              <span className="text-[7px] text-green-400/70 font-medium whitespace-nowrap">{t("landing.features.agentJoined")}</span>
              <div className="flex-1 h-px bg-green-500/20" />
            </div>
            {/* Agent message */}
            <div className={`flex ${isRtl ? "justify-start" : "justify-end"}`}>
              <div className="max-w-[80%] bg-primary-500/20 border border-primary-500/15 rounded-xl rounded-tr-sm px-3 py-1.5">
                <p className="text-[9px] text-white/70 leading-[1.5]">{t("landing.features.agentReply")}</p>
                <div className="flex items-center justify-end gap-1 mt-0.5">
                  <span className="text-[7px] text-white/25">Just now</span>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-blue-400">
                    <path d="M1 12l6 6L18 6M6 12l6 6L23 6" />
                  </svg>
                </div>
              </div>
            </div>
          </div>

          {/* Input */}
          <div className="px-3 py-2 border-t border-white/[0.04] flex items-center gap-2">
            <div className="flex-1 h-7 bg-white/[0.03] border border-white/[0.06] rounded-lg" />
            <div className="w-7 h-7 rounded-lg bg-primary-500/30 flex items-center justify-center">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-primary-300"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" /></svg>
            </div>
          </div>
        </div>

        {/* Copilot panel (slides in) */}
        <div
          className={`inbox-demo-copilot w-[140px] sm:w-[170px] md:w-[200px] flex-shrink-0 flex flex-col bg-white/[0.02] overflow-hidden ${isRtl ? "border-e border-white/[0.04]" : "border-s border-white/[0.04]"}`}
          style={{
            transform: `translateX(${copilotTranslate}%)`,
            opacity: copilotEased,
            willChange: "transform, opacity",
          }}
        >
          {/* Header */}
          <div className="flex items-center gap-1.5 px-3 py-2 border-b border-white/[0.04]">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-primary-400">
              <path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25" />
            </svg>
            <span className="text-[9px] font-semibold text-primary-300">{t("landing.features.copilotLabel")}</span>
            <div className="ms-auto w-1.5 h-1.5 rounded-full bg-green-400" />
          </div>
          {/* Context */}
          <div className="p-2 space-y-2">
            <div className="bg-primary-500/5 border border-primary-500/10 rounded-lg p-2">
              <span className="text-[7px] font-semibold text-primary-400 uppercase tracking-wider">Context</span>
              <p className="text-[8px] text-white/50 leading-[1.5] mt-1">{t("landing.features.contextSummary")}</p>
            </div>
            {/* Suggestions */}
            <div className="space-y-1.5">
              <span className="text-[7px] font-semibold text-white/30 uppercase tracking-wider">Suggestions</span>
              <div className="bg-white/[0.04] border border-white/[0.04] rounded-lg p-2 hover:border-primary-500/20 transition-colors cursor-pointer">
                <p className="text-[8px] text-white/60 leading-[1.5]">{t("landing.features.copilotSuggestion1")}</p>
                <div className="flex items-center gap-1 mt-1">
                  <div className="h-1 flex-1 rounded-full bg-green-500/30">
                    <div className="h-full w-[92%] rounded-full bg-green-500/60" />
                  </div>
                  <span className="text-[7px] text-green-400/70">92%</span>
                </div>
              </div>
              <div className="bg-white/[0.04] border border-white/[0.04] rounded-lg p-2 hover:border-primary-500/20 transition-colors cursor-pointer">
                <p className="text-[8px] text-white/60 leading-[1.5]">{t("landing.features.copilotSuggestion2")}</p>
                <div className="flex items-center gap-1 mt-1">
                  <div className="h-1 flex-1 rounded-full bg-amber-500/30">
                    <div className="h-full w-[87%] rounded-full bg-amber-500/60" />
                  </div>
                  <span className="text-[7px] text-amber-400/70">87%</span>
                </div>
              </div>
            </div>
            <button className="w-full py-1.5 rounded-lg bg-primary-500/15 text-[8px] font-medium text-primary-300">
              {t("landing.features.copilotInsert")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ───── StoryPhaseText ───── */

function StoryPhaseText({ text, desc, opacity, bottom }: { text: string; desc?: string; opacity: number; bottom?: boolean }) {
  return (
    <div
      className="absolute inset-x-0 text-center px-6 pointer-events-none max-w-2xl mx-auto"
      style={{ opacity, willChange: "opacity", ...(bottom ? { bottom: "8%" } : { top: "14%" }) }}
    >
      <p className="text-lg sm:text-2xl md:text-3xl font-light tracking-[-0.02em] text-white/90">
        {text}
      </p>
      {desc && (
        <p className="mt-2 text-sm sm:text-base font-light text-white/40 leading-relaxed">
          {desc}
        </p>
      )}
    </div>
  );
}

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
          <a href="#how-it-works" onClick={onClose} className="px-4 py-3 text-[15px] font-medium text-gray-700 hover:bg-gray-50 rounded-xl transition-colors">
            {t("landing.nav.howItWorks")}
          </a>
          <a href="#product-features" onClick={onClose} className="px-4 py-3 text-[15px] font-medium text-gray-700 hover:bg-gray-50 rounded-xl transition-colors">
            {t("landing.nav.features")}
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
          <Link href="/early-access" onClick={onClose} className="mt-2 px-4 py-3 text-[15px] font-semibold text-white bg-primary-500 rounded-xl text-center hover:bg-primary-600 transition-colors">
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
      src="/logo_icon.png"
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


/* ───── Main Component ───── */

export default function LandingPage({ forcedLocale }: { forcedLocale?: Locale }) {
  const { t, locale, setLocale, dir } = useI18n();
  const featuresRef = useRef<HTMLElement>(null);
  const [storyProgress, setStoryProgress] = useState(0);
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
        setStoryProgress(progress);
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
              <a href="#how-it-works" className={`px-3.5 py-1.5 text-[13px] font-medium rounded-full transition-all ${
                navDark ? "text-white/60 hover:text-white hover:bg-white/10" : "text-gray-500 hover:text-black hover:bg-gray-100/80"
              }`}>
                {t("landing.nav.howItWorks")}
              </a>
              <a href="#product-features" className={`px-3.5 py-1.5 text-[13px] font-medium rounded-full transition-all ${
                navDark ? "text-white/60 hover:text-white hover:bg-white/10" : "text-gray-500 hover:text-black hover:bg-gray-100/80"
              }`}>
                {t("landing.nav.features")}
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
            <Link href="/early-access" className="hidden sm:inline-flex px-5 py-2 text-[13px] font-semibold text-white bg-primary-500 rounded-full hover:bg-primary-600 transition-all">
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
                href="/early-access"
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

      {/* ───── How It Works: Scroll-Driven Story ───── */}
      <section
        id="how-it-works"
        ref={featuresRef}
        className="landing-features relative"
        style={{ "--fp": "0", minHeight: "400vh" } as React.CSSProperties}
      >
        {/* Grid overlay */}
        <div className="landing-features-grid pointer-events-none absolute inset-0" style={{ zIndex: 1 }} />

        {/* Rotating gradient blobs */}
        <div className="landing-features-gradients pointer-events-none absolute -inset-20 overflow-hidden">
          <div className="absolute top-[10%] left-0 w-[300px] sm:w-[500px] h-[300px] sm:h-[500px] rounded-full opacity-[0.18]" style={{ background: "radial-gradient(circle, #7C3291 0%, transparent 70%)", filter: "blur(100px)" }} />
          <div className="absolute top-[40%] right-0 w-[250px] sm:w-[400px] h-[250px] sm:h-[400px] rounded-full opacity-[0.15]" style={{ background: "radial-gradient(circle, #5A72B3 0%, transparent 70%)", filter: "blur(100px)" }} />
          <div className="absolute bottom-[10%] left-[20%] w-[300px] sm:w-[500px] h-[300px] sm:h-[500px] rounded-full opacity-[0.18]" style={{ background: "radial-gradient(circle, #6DCED9 0%, transparent 70%)", filter: "blur(100px)" }} />
        </div>

        {/* ── Scroll-driven story (all screen sizes) ── */}
        <div className="relative" style={{ zIndex: 2, minHeight: "400vh" }}>
          <div className="sticky top-0 h-screen flex items-center justify-center overflow-hidden">
            {/* Section label */}
            <p className="absolute top-6 sm:top-8 inset-x-0 text-center text-[10px] sm:text-xs font-medium text-primary-400 uppercase tracking-[0.15em]">
              {t("landing.features.label")}
            </p>

            {/* Phase 1 & 2: Chaos → stacked conversation items */}
            <div className="relative w-full h-full flex items-center justify-center scale-[0.75] sm:scale-[0.8] md:scale-[0.9] lg:scale-100 origin-center">
              {INBOX_PLATFORMS.map((platform, i) => (
                <ConversationItem
                  key={platform.name}
                  platform={platform}
                  index={i}
                  progress={storyProgress}
                  isRtl={isRtl}
                />
              ))}
            </div>

            {/* Phase 3 & 4: Full inbox demo (crossfades in) */}
            {(() => {
              const demoFadeStart = 0.45;
              const demoFadeEnd = 0.60;
              const sub = Math.min(1, Math.max(0, (storyProgress - demoFadeStart) / (demoFadeEnd - demoFadeStart)));
              const eased = 1 - Math.pow(1 - sub, 3);
              const scale = 0.92 + 0.08 * eased;
              // Copilot slides in later (0.70–0.90)
              const copilotP = Math.min(1, Math.max(0, (storyProgress - 0.70) / 0.20));
              return (
                <div
                  className="absolute inset-0 flex items-center justify-center pointer-events-none"
                  style={{ opacity: eased, transform: `scale(${scale}) translateY(-4%)`, willChange: "transform, opacity" }}
                >
                  <div className="scale-[0.78] sm:scale-[0.82] md:scale-[0.88] lg:scale-100 origin-center">
                    <InboxDemo
                      copilotProgress={copilotP}
                      isRtl={isRtl}
                      t={t as (key: string) => string}
                    />
                  </div>
                </div>
              );
            })()}

            {/* Phase text overlays */}
            {/* Phase 1: Chaos — top */}
            <StoryPhaseText
              text={t("landing.features.chaosText") as string}
              desc={t("landing.features.chaosDesc") as string}
              opacity={storyProgress < 0.18 ? 1 : Math.max(0, 1 - (storyProgress - 0.18) / 0.06)}
            />
            {/* Phase 2: Converge — top, fades out before demo appears */}
            <StoryPhaseText
              text={t("landing.features.convergeText") as string}
              desc={t("landing.features.convergeDesc") as string}
              opacity={
                storyProgress < 0.28 ? Math.max(0, (storyProgress - 0.22) / 0.06)
                : storyProgress > 0.36 ? Math.max(0, 1 - (storyProgress - 0.36) / 0.06)
                : 1
              }
            />
            {/* Phase 3: One inbox — bottom, appears when demo fades in */}
            <StoryPhaseText
              text={t("landing.features.resolveText") as string}
              desc={t("landing.features.resolveDesc") as string}
              opacity={
                storyProgress < 0.50 ? Math.max(0, (storyProgress - 0.44) / 0.06)
                : storyProgress > 0.56 ? Math.max(0, 1 - (storyProgress - 0.56) / 0.06)
                : 1
              }
              bottom
            />
            {/* Phase 4: Bot handover — bottom */}
            <StoryPhaseText
              text={t("landing.features.botText") as string}
              desc={t("landing.features.botDesc") as string}
              opacity={
                storyProgress < 0.64 ? Math.max(0, (storyProgress - 0.58) / 0.06)
                : storyProgress > 0.72 ? Math.max(0, 1 - (storyProgress - 0.72) / 0.06)
                : 1
              }
              bottom
            />
            {/* Phase 5: AI Copilot — bottom */}
            <StoryPhaseText
              text={t("landing.features.copilotText") as string}
              desc={t("landing.features.copilotDesc") as string}
              opacity={storyProgress < 0.80 ? 0 : Math.min(1, (storyProgress - 0.80) / 0.10)}
              bottom
            />

            {/* Progress bar */}
            <div className="absolute bottom-2 sm:bottom-3 inset-x-0 flex justify-center">
              <div className="w-24 sm:w-32 h-1 bg-white/10 rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary-500 rounded-full transition-none"
                  style={{ width: `${storyProgress * 100}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ───── Features: 2x3 Grid ───── */}
      <section id="product-features" className="py-14 sm:py-28 px-4 sm:px-12 lg:px-20 bg-gray-50/50">
        <div className="max-w-[1240px] mx-auto">
          <div className="text-center max-w-xl mx-auto mb-10 sm:mb-16">
            <p className="text-xs font-medium text-primary-500 uppercase tracking-[0.15em] mb-3">
              {t("landing.productFeatures.label")}
            </p>
            <h2 className="text-[clamp(1.5rem,3.5vw,2.5rem)] font-semibold tracking-[-0.03em] leading-[1.15] mb-4">
              {t("landing.productFeatures.title")}
            </h2>
            <p className="text-[#757575] text-sm sm:text-base">
              {t("landing.productFeatures.subtitle")}
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
            {PRODUCT_FEATURES.map((feature) => (
              <div
                key={feature.key}
                className="bg-white rounded-2xl border border-gray-100 p-5 sm:p-6 hover:shadow-lg hover:shadow-gray-200/50 transition-all duration-300"
              >
                <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${feature.gradient} flex items-center justify-center mb-4`}>
                  <span className={feature.iconColor}>{feature.icon}</span>
                </div>
                <h3 className="text-[15px] sm:text-base font-semibold text-black mb-2">
                  {t(`landing.productFeatures.${feature.key}.title`)}
                </h3>
                <p className="text-sm text-[#757575] leading-[1.6]">
                  {t(`landing.productFeatures.${feature.key}.desc`)}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ───── Get Started: Zigzag ───── */}
      <section id="get-started" className="py-14 sm:py-28 px-4 sm:px-12 lg:px-20 bg-white">
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
                      className="bg-[#1a1a2e] rounded-2xl border border-white/[0.06] overflow-hidden"
                      style={{ boxShadow: "0 6px 30px rgba(0,0,0,0.15)" }}
                    >
                      <img
                        src={["/get_gifs/connect.gif", "/get_gifs/knowladge.gif", "/get_gifs/ai.gif", "/get_gifs/chat.gif"][i]}
                        alt={t(`landing.howItWorks.${step}.title`) as string}
                        className="w-full h-auto block"
                      />
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
            href="/early-access"
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
                  <li><a href="#how-it-works" className="hover:text-black transition-colors text-[13px] inline-block py-0.5">{t("landing.nav.howItWorks")}</a></li>
                  <li><a href="#product-features" className="hover:text-black transition-colors text-[13px] inline-block py-0.5">{t("landing.nav.features")}</a></li>
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
