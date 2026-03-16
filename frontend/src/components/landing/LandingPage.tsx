"use client";

import { memo, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useI18n } from "@/context/I18nContext";
import type { Locale } from "@/i18n";
import JsonLd from "@/components/JsonLd";

/* ───── Scroll Story: Platform Config ───── */

const INBOX_PLATFORMS = [
  { name: "WhatsApp", color: "#25D366", icon: "/icons/wa.png", badge: 12, contact: "Sarah M.", initial: "S", message: "Hi, is my order on the way?" },
  { name: "Instagram", color: "#E1306C", icon: "/icons/ins.png", badge: 8, contact: "david_k", initial: "D", message: "Hey can I return this?" },
  { name: "Messenger", color: "#0084FF", icon: "/icons/msn.png", badge: 23, contact: "Rachel B.", initial: "R", message: "When does the sale end?" },
  { name: "Gmail", color: "#EA4335", icon: "/icons/gm.png", badge: 4, contact: "Mike Johnson", initial: "M", message: "RE: Invoice #4812 question" },
  { name: "Outlook", color: "#0078D4", icon: "/icons/ol.png", badge: 6, contact: "Lisa Chen", initial: "L", message: "Follow up on proposal" },
  { name: "Slack", color: "#4A154B", icon: "/icons/slk.png", badge: 5, contact: "#support", initial: "#", message: "New ticket from enterprise client" },
] as const;

const CHAOS_POSITIONS = [
  { x: -240, y: -130, rotate: -10, scale: 0.88 },
  { x: 210,  y: -85,  rotate: 7,   scale: 0.92 },
  { x: -150, y: 30,   rotate: -14, scale: 0.85 },
  { x: 190,  y: 110,  rotate: 5,   scale: 0.9 },
  { x: -60,  y: 185,  rotate: -3,  scale: 0.87 },
  { x: 80,   y: -170, rotate: 4,   scale: 0.86 },
];

const STACKED_POSITIONS = [
  { x: 0, y: -145 },
  { x: 0, y: -87 },
  { x: 0, y: -29 },
  { x: 0, y: 29 },
  { x: 0, y: 87 },
  { x: 0, y: 145 },
];

/* ───── Product Features Config ───── */

const PRODUCT_FEATURES = [
  {
    key: "unifiedInbox",
    gradient: "from-primary-500/[0.08] to-primary-500/[0.04]",
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
    gradient: "from-primary-500/[0.08] to-primary-500/[0.04]",
    iconColor: "text-primary-500",
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09Z" />
        <path d="M18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 0 0-2.455 2.456Z" />
      </svg>
    ),
  },
  {
    key: "smartBot",
    gradient: "from-primary-500/[0.08] to-primary-500/[0.04]",
    iconColor: "text-primary-500",
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z" />
      </svg>
    ),
  },
  {
    key: "knowledgeBase",
    gradient: "from-primary-500/[0.08] to-primary-500/[0.04]",
    iconColor: "text-primary-500",
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25" />
      </svg>
    ),
  },
  {
    key: "smartRouting",
    gradient: "from-primary-500/[0.08] to-primary-500/[0.04]",
    iconColor: "text-primary-500",
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M7.5 21 3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
      </svg>
    ),
  },
  {
    key: "analytics",
    gradient: "from-primary-500/[0.08] to-primary-500/[0.04]",
    iconColor: "text-primary-500",
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z" />
      </svg>
    ),
  },
] as const;

/* ───── ConversationItem (for chaos + stack phases) ───── */

const ConversationItem = memo(function ConversationItem({ platform, index, progress, isRtl }: {
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
});

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
              <div className="relative w-7 h-7 rounded-full bg-gradient-to-br from-primary-400/30 to-primary-600/30 flex items-center justify-center flex-shrink-0">
                <span className="text-[8px] font-bold text-white/70">{p.initial}</span>
                <img src={p.icon} alt="" className="absolute -bottom-0.5 -end-0.5 w-3.5 h-3.5 rounded-full border border-[#12121f]" style={{ background: p.color + "20" }} />
              </div>
              <div className="flex-1 min-w-0">
                <span className="text-[9px] font-semibold text-white/80 truncate block">{p.contact}</span>
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
              <div className="relative w-7 h-7 rounded-full bg-gradient-to-br from-white/[0.06] to-white/[0.03] flex items-center justify-center flex-shrink-0">
                <span className="text-[8px] font-bold text-white/50">{p.initial}</span>
                <img src={p.icon} alt="" className="absolute -bottom-0.5 -end-0.5 w-3.5 h-3.5 rounded-full border border-[#12121f] opacity-70" style={{ background: p.color + "20" }} />
              </div>
              <div className="flex-1 min-w-0">
                <span className="text-[9px] font-medium text-white/60 truncate block">{p.contact}</span>
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

          {/* Input with AI glow */}
          <div className="px-3 py-2 border-t border-white/[0.04] flex items-center gap-2">
            <div className="flex-1 h-7 relative rounded-lg">
              <div className="absolute -inset-[1px] rounded-lg demo-input-ai-glow" />
              <div className="relative h-full bg-[#12121f] rounded-lg border border-white/[0.06] flex items-center px-2">
                <span className="text-[8px] text-white/20">Type a message...</span>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-primary-400/50 ms-auto">
                  <path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25" />
                </svg>
              </div>
            </div>
            <div className="w-7 h-7 rounded-lg bg-primary-500/30 flex items-center justify-center">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-primary-300"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" /></svg>
            </div>
          </div>
        </div>

        {/* Copilot panel (slides in) */}
        <div
          className={`inbox-demo-copilot w-[140px] sm:w-[170px] md:w-[200px] flex-shrink-0 flex flex-col overflow-hidden relative ${isRtl ? "border-e border-primary-500/20" : "border-s border-primary-500/20"}`}
          style={{
            transform: `translateX(${copilotTranslate}%)`,
            opacity: copilotEased,
            willChange: "transform, opacity",
            background: "linear-gradient(180deg, rgba(124,92,252,0.06) 0%, rgba(124,92,252,0.02) 50%, rgba(124,92,252,0.04) 100%)",
            boxShadow: copilotEased > 0.5 ? `inset ${isRtl ? "3px" : "-3px"} 0 12px rgba(124,92,252,0.08), ${isRtl ? "3px" : "-3px"} 0 20px rgba(124,92,252,0.06)` : "none",
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

const StoryPhaseText = memo(function StoryPhaseText({ text, desc, opacity, bottom }: { text: string; desc?: string; opacity: number; bottom?: boolean }) {
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
});

/* ───── Rotating Platform Names ───── */

const PLATFORMS = ["WhatsApp", "Instagram", "Facebook", "Messenger", "Gmail", "Outlook", "Slack"];

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

function LocaleDropdown({ locale, setLocale, forcedLocale }: { locale: string; setLocale: (l: "en" | "he") => void; forcedLocale?: string }) {
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

  function handleSwitch(l: "en" | "he") {
    setOpen(false);
    if (forcedLocale) {
      router.push(`/${l}`);
    } else {
      setLocale(l);
    }
  }

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
              onClick={() => handleSwitch(l)}
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
  forcedLocale,
}: {
  open: boolean;
  onClose: () => void;
  t: (key: string) => any;
  locale: string;
  setLocale: (l: "en" | "he") => void;
  navDark: boolean;
  forcedLocale?: string;
}) {
  const router = useRouter();

  useEffect(() => {
    if (open) document.body.style.overflow = "hidden";
    else document.body.style.overflow = "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  function handleSwitch(l: "en" | "he") {
    onClose();
    if (forcedLocale) {
      router.push(`/${l}`);
    } else {
      setLocale(l);
    }
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
                onClick={() => handleSwitch(l)}
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

function ProductMockup() {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden"
      style={{ boxShadow: "0 6px 40px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06)" }}
    >
      {/* Browser chrome */}
      <div className="flex items-center gap-2 px-4 py-2 bg-gray-50 border-b border-gray-100">
        <div className="flex gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full bg-[#ff5f57]" />
          <div className="w-2.5 h-2.5 rounded-full bg-[#febc2e]" />
          <div className="w-2.5 h-2.5 rounded-full bg-[#28c840]" />
        </div>
        <div className="flex-1 mx-8">
          <div className="h-5 bg-gray-100 rounded-full max-w-[200px] mx-auto flex items-center justify-center">
            <div className="h-1.5 w-20 bg-gray-200 rounded-full" />
          </div>
        </div>
      </div>

      {/* App UI */}
      <div className="flex h-56 sm:h-72">
        {/* Sidebar — icon nav */}
        <div className="hidden sm:flex flex-col w-12 bg-gray-50/80 border-e border-gray-100 items-center py-3 gap-1">
          <div className="w-7 h-7 rounded-lg bg-primary-500/15 flex items-center justify-center mb-2">
            <div className="w-3.5 h-3.5 rounded bg-primary-500/40" />
          </div>
          <div className="w-7 h-7 rounded-lg bg-primary-100 flex items-center justify-center">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-primary-500"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          </div>
          <div className="w-7 h-7 rounded-lg hover:bg-gray-100 flex items-center justify-center">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-400"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
          </div>
          <div className="w-7 h-7 rounded-lg hover:bg-gray-100 flex items-center justify-center">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-400"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
          </div>
          <div className="w-7 h-7 rounded-lg hover:bg-gray-100 flex items-center justify-center">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-400"><path d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25"/></svg>
          </div>
          <div className="flex-1" />
          <div className="w-7 h-7 rounded-lg hover:bg-gray-100 flex items-center justify-center">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-400"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
          </div>
        </div>

        {/* Chat list */}
        <div className="flex-1 flex flex-col border-e border-gray-100 min-w-0 max-w-[180px]">
          {/* Search */}
          <div className="px-2.5 py-2 border-b border-gray-50">
            <div className="h-7 bg-gray-50 rounded-lg flex items-center px-2 gap-1.5">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-gray-300 flex-shrink-0"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
              <div className="h-1.5 w-12 bg-gray-200 rounded-full" />
            </div>
          </div>
          {/* Chat items */}
          <div className="flex-1 overflow-hidden flex flex-col">
            {/* Active chat */}
            <div className="px-2 py-2 bg-primary-50/60 border-s-2 border-primary-500">
              <div className="flex items-center gap-2">
                <div className="relative flex-shrink-0">
                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-green-400 to-green-600 flex items-center justify-center">
                    <span className="text-[9px] font-bold text-white">SM</span>
                  </div>
                  <img src="/icons/wa.png" alt="" className="absolute -bottom-0.5 -end-0.5 w-3.5 h-3.5 rounded-full border-2 border-white bg-white" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <div className="h-1.5 w-14 bg-gray-800/70 rounded-full" />
                    <div className="h-1.5 w-6 bg-gray-300 rounded-full" />
                  </div>
                  <div className="h-1.5 w-20 bg-gray-400/50 rounded-full mt-1.5" />
                </div>
              </div>
            </div>
            {/* Chat 2 */}
            <div className="px-2 py-2 border-b border-gray-50">
              <div className="flex items-center gap-2">
                <div className="relative flex-shrink-0">
                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-pink-400 to-rose-500 flex items-center justify-center">
                    <span className="text-[9px] font-bold text-white">DK</span>
                  </div>
                  <img src="/icons/ins.png" alt="" className="absolute -bottom-0.5 -end-0.5 w-3.5 h-3.5 rounded-full border-2 border-white bg-white" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <div className="h-1.5 w-12 bg-gray-700/60 rounded-full" />
                    <div className="w-4 h-4 rounded-full bg-primary-500 flex items-center justify-center">
                      <span className="text-[7px] font-bold text-white">2</span>
                    </div>
                  </div>
                  <div className="h-1.5 w-16 bg-gray-400/40 rounded-full mt-1.5" />
                </div>
              </div>
            </div>
            {/* Chat 3 */}
            <div className="px-2 py-2 border-b border-gray-50">
              <div className="flex items-center gap-2">
                <div className="relative flex-shrink-0">
                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-400 to-blue-600 flex items-center justify-center">
                    <span className="text-[9px] font-bold text-white">RB</span>
                  </div>
                  <img src="/icons/msn.png" alt="" className="absolute -bottom-0.5 -end-0.5 w-3.5 h-3.5 rounded-full border-2 border-white bg-white" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <div className="h-1.5 w-16 bg-gray-700/60 rounded-full" />
                    <div className="h-1.5 w-6 bg-gray-300 rounded-full" />
                  </div>
                  <div className="h-1.5 w-14 bg-gray-400/40 rounded-full mt-1.5" />
                </div>
              </div>
            </div>
            {/* Chat 4 */}
            <div className="px-2 py-2">
              <div className="flex items-center gap-2">
                <div className="relative flex-shrink-0">
                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-red-400 to-red-500 flex items-center justify-center">
                    <span className="text-[9px] font-bold text-white">MJ</span>
                  </div>
                  <img src="/icons/gm.png" alt="" className="absolute -bottom-0.5 -end-0.5 w-3.5 h-3.5 rounded-full border-2 border-white bg-white" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <div className="h-1.5 w-18 bg-gray-700/60 rounded-full" />
                    <div className="h-1.5 w-6 bg-gray-300 rounded-full" />
                  </div>
                  <div className="h-1.5 w-20 bg-gray-400/40 rounded-full mt-1.5" />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Chat area */}
        <div className="hidden md:flex flex-[1.4] flex-col min-w-0">
          {/* Chat header */}
          <div className="flex items-center gap-2.5 px-3 py-2 border-b border-gray-100">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-green-400 to-green-600 flex items-center justify-center">
              <span className="text-[8px] font-bold text-white">SM</span>
            </div>
            <div>
              <div className="h-1.5 w-16 bg-gray-700/60 rounded-full" />
              <div className="h-1.5 w-10 bg-green-400/50 rounded-full mt-1" />
            </div>
            <div className="flex-1" />
            <div className="flex gap-1">
              <div className="w-5 h-5 rounded bg-gray-50 flex items-center justify-center">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-400"><path d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0" /></svg>
              </div>
              <div className="w-5 h-5 rounded bg-gray-50 flex items-center justify-center">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-400"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
              </div>
            </div>
          </div>
          {/* Messages */}
          <div className="flex-1 px-3 py-2 flex flex-col gap-2 overflow-hidden">
            {/* Incoming bubble */}
            <div className="self-start max-w-[75%]">
              <div className="bg-gray-100 rounded-2xl rounded-tl-sm px-3 py-2">
                <div className="h-1.5 w-28 bg-gray-300/70 rounded-full" />
                <div className="h-1.5 w-20 bg-gray-300/50 rounded-full mt-1.5" />
              </div>
              <div className="h-1 w-8 bg-gray-200 rounded-full mt-1 ms-1" />
            </div>
            {/* Outgoing bubble */}
            <div className="self-end max-w-[70%]">
              <div className="bg-primary-500 rounded-2xl rounded-tr-sm px-3 py-2">
                <div className="h-1.5 w-24 bg-white/40 rounded-full" />
                <div className="h-1.5 w-16 bg-white/30 rounded-full mt-1.5" />
              </div>
              <div className="h-1 w-6 bg-gray-200 rounded-full mt-1 me-1 self-end ms-auto" />
            </div>
            {/* Incoming bubble */}
            <div className="self-start max-w-[65%]">
              <div className="bg-gray-100 rounded-2xl rounded-tl-sm px-3 py-2">
                <div className="h-1.5 w-16 bg-gray-300/70 rounded-full" />
              </div>
            </div>
          </div>
          {/* Input with AI glow */}
          <div className="px-3 py-2 border-t border-gray-100">
            <div className="relative h-8 rounded-xl">
              <div className="absolute -inset-[1px] rounded-xl demo-input-ai-glow" />
              <div className="relative h-full bg-white border border-gray-200 rounded-xl flex items-center px-2.5 gap-2">
                <div className="h-1.5 w-20 bg-gray-200 rounded-full" />
                <div className="flex-1" />
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-primary-400/60"><path d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25"/></svg>
                <div className="w-5 h-5 rounded-full bg-primary-500 flex items-center justify-center">
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="text-white"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Co-Pilot panel (animated slide-in) */}
        <div className="hidden md:flex flex-col w-[160px] border-s border-primary-200/40 hero-copilot-slide overflow-hidden"
          style={{ background: "linear-gradient(180deg, rgba(124,92,252,0.04) 0%, rgba(124,92,252,0.08) 100%)" }}
        >
          {/* Header */}
          <div className="flex items-center gap-1.5 px-2.5 py-2 border-b border-primary-100/60">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-primary-500">
              <path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25" />
            </svg>
            <span className="text-[8px] font-semibold text-primary-600">AI Co-Pilot</span>
            <div className="ms-auto w-1.5 h-1.5 rounded-full bg-green-400 hero-copilot-dot" />
          </div>
          {/* Context card */}
          <div className="p-2 space-y-2 hero-copilot-content">
            <div className="bg-primary-50 border border-primary-100 rounded-lg p-2">
              <span className="text-[6px] font-bold text-primary-500 uppercase tracking-wider">Context</span>
              <div className="mt-1 space-y-1">
                <div className="h-1.5 w-full bg-primary-200/50 rounded-full" />
                <div className="h-1.5 w-3/4 bg-primary-200/40 rounded-full" />
              </div>
            </div>
            {/* Suggestion 1 */}
            <div>
              <span className="text-[6px] font-bold text-gray-400 uppercase tracking-wider">Suggested reply</span>
              <div className="mt-1 relative rounded-lg">
                <div className="absolute -inset-[1px] rounded-lg demo-input-ai-glow opacity-40" />
                <div className="relative bg-white border border-primary-100 rounded-lg p-2">
                  <div className="space-y-1">
                    <div className="h-1.5 w-full bg-primary-200/60 rounded-full" />
                    <div className="h-1.5 w-5/6 bg-primary-200/45 rounded-full" />
                  </div>
                  <div className="flex items-center gap-1 mt-1.5">
                    <div className="h-1 flex-1 rounded-full bg-green-200">
                      <div className="h-full w-[94%] rounded-full bg-green-400" />
                    </div>
                    <span className="text-[6px] font-medium text-green-500">94%</span>
                  </div>
                </div>
              </div>
            </div>
            {/* Suggestion 2 */}
            <div className="bg-white border border-gray-100 rounded-lg p-2">
              <div className="space-y-1">
                <div className="h-1.5 w-full bg-gray-200/60 rounded-full" />
                <div className="h-1.5 w-2/3 bg-gray-200/45 rounded-full" />
              </div>
              <div className="flex items-center gap-1 mt-1.5">
                <div className="h-1 flex-1 rounded-full bg-amber-200">
                  <div className="h-full w-[82%] rounded-full bg-amber-400" />
                </div>
                <span className="text-[6px] font-medium text-amber-500">82%</span>
              </div>
            </div>
            {/* Insert button */}
            <div className="h-5 bg-primary-500 rounded-md flex items-center justify-center">
              <span className="text-[7px] font-semibold text-white">Insert reply</span>
            </div>
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
    <div className="border-b border-gray-100/80 last:border-0">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between py-5 sm:py-6 text-start gap-4 group"
      >
        <span className="text-[14px] sm:text-[15px] font-medium text-gray-900 group-hover:text-primary-500 transition-colors duration-200">{question}</span>
        <svg
          width="20" height="20" viewBox="0 0 24 24" fill="none"
          className={`flex-shrink-0 text-gray-300 transition-transform duration-300 ${open ? "rotate-45" : ""}`}
        >
          <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      <div
        className={`grid transition-all duration-300 ease-out ${open ? "grid-rows-[1fr] opacity-100 pb-5 sm:pb-6" : "grid-rows-[0fr] opacity-0"}`}
      >
        <div className="overflow-hidden">
          <p className="text-[#9a9a9a] text-[13px] sm:text-sm leading-[1.8]">{answer}</p>
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
  const rafRef = useRef<number>(0);
  const lastProgressRef = useRef(0);

  useEffect(() => {
    if (forcedLocale && forcedLocale !== locale) {
      setLocale(forcedLocale);
    }
  }, [forcedLocale, locale, setLocale]);

  useEffect(() => {
    const features = featuresRef.current;
    if (!features) return;
    const onScroll = () => {
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        const rect = features.getBoundingClientRect();
        const scrolled = -rect.top;
        const sectionHeight = rect.height - window.innerHeight;
        if (sectionHeight > 0) {
          const progress = Math.min(1, Math.max(0, scrolled / sectionHeight));
          // Only re-render if progress changed meaningfully (reduces re-renders)
          if (Math.abs(progress - lastProgressRef.current) > 0.002) {
            lastProgressRef.current = progress;
            setStoryProgress(progress);
          }
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
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
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
              <LocaleDropdown locale={locale} setLocale={setLocale} forcedLocale={forcedLocale} />
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
      <MobileMenu open={mobileMenuOpen} onClose={() => setMobileMenuOpen(false)} t={t} locale={locale} setLocale={setLocale} navDark={navDark} forcedLocale={forcedLocale} />

      {/* ───── Hero: Split Layout ───── */}
      <section className="relative min-h-[80vh] sm:min-h-[95vh] flex items-center px-4 sm:px-12 lg:px-20 pt-24 sm:pt-28 pb-16 sm:pb-0 overflow-hidden bg-white">
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
              <span className="block text-[clamp(1.15rem,3.5vw,2rem)] font-extralight leading-[1.2] tracking-[-0.02em] text-[#9a9a9a] mt-3 sm:mt-4">
                {t("landing.hero.title2")}
              </span>
            </h1>
            <p className="text-[15px] sm:text-[17px] leading-[1.7] font-light text-[#9a9a9a] mb-8 sm:mb-10 landing-fade-in landing-delay-1">
              {t("landing.hero.subtitle")}
            </p>
            <div className="flex flex-wrap gap-3 landing-fade-in landing-delay-2 justify-center lg:justify-start">
              <Link
                href="/early-access"
                className="px-8 py-3.5 text-[15px] font-semibold text-white bg-primary-500 rounded-2xl hover:bg-primary-600 transition-all duration-200 hover:scale-[1.02]"
                style={{ boxShadow: "0 4px 20px rgba(124,92,252,0.25)" }}
              >
                {t("landing.hero.cta")}
              </Link>
              <a
                href="#how-it-works"
                className="px-6 py-3.5 text-[15px] font-medium text-[#9a9a9a] hover:text-black transition-colors duration-200"
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

      {/* ───── Channels Hub Section ───── */}
      <section className="py-20 sm:py-32 px-4 sm:px-12 lg:px-20 bg-white overflow-hidden">
        <div className="max-w-[1240px] mx-auto">
          {/* Header */}
          <div className="text-center max-w-xl mx-auto mb-14 sm:mb-20">
            <p className="text-[11px] font-medium text-primary-500 uppercase tracking-[0.2em] mb-4">
              {t("landing.hero.channelsLabel")}
            </p>
            <h2 className="text-[clamp(1.5rem,3.5vw,2.5rem)] font-semibold tracking-[-0.03em] leading-[1.15] mb-5">
              {t("landing.hero.channelsTitle")}
            </h2>
            <p className="text-[#9a9a9a] text-[15px] sm:text-base leading-relaxed">
              {t("landing.hero.channelsSubtitle")}
            </p>
          </div>

          {/* Channels converge visual */}
          {/* Channel pills row */}
          <div className="flex flex-wrap justify-center gap-3 sm:gap-4 max-w-2xl mx-auto">
            {[
              { name: "WhatsApp", logo: "/icons/wa.png", color: "#25D366" },
              { name: "Instagram", logo: "/icons/ins.png", color: "#E1306C" },
              { name: "Messenger", logo: "/icons/msn.png", color: "#0084FF" },
              { name: "Gmail", logo: "/icons/gm.png", color: "#EA4335" },
              { name: "Outlook", logo: "/icons/ol.png", color: "#0078D4" },
              { name: "Slack", logo: "/icons/slk.png", color: "#4A154B" },
            ].map((channel) => (
              <div
                key={channel.name}
                className="group flex items-center gap-2.5 bg-white rounded-full border border-gray-100 px-4 py-2.5 sm:px-5 sm:py-3 hover:border-gray-200 hover:shadow-md transition-all duration-300"
              >
                <div className="w-8 h-8 rounded-full bg-gray-50 flex items-center justify-center group-hover:scale-110 transition-transform duration-300">
                  <img src={channel.logo} alt={channel.name} className="w-5 h-5 object-contain" />
                </div>
                <span className="text-sm font-medium text-gray-900">{channel.name}</span>
              </div>
            ))}
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
          <div className="absolute top-[10%] left-0 w-[300px] sm:w-[500px] h-[300px] sm:h-[500px] rounded-full opacity-[0.18]" style={{ background: "radial-gradient(circle, #7C3291 0%, transparent 70%)", filter: "blur(60px)", WebkitFilter: "blur(60px)" }} />
          <div className="absolute top-[40%] right-0 w-[250px] sm:w-[400px] h-[250px] sm:h-[400px] rounded-full opacity-[0.15]" style={{ background: "radial-gradient(circle, #5A72B3 0%, transparent 70%)", filter: "blur(60px)", WebkitFilter: "blur(60px)" }} />
          <div className="absolute bottom-[10%] left-[20%] w-[300px] sm:w-[500px] h-[300px] sm:h-[500px] rounded-full opacity-[0.18]" style={{ background: "radial-gradient(circle, #6DCED9 0%, transparent 70%)", filter: "blur(60px)", WebkitFilter: "blur(60px)" }} />
        </div>

        {/* ── Scroll-driven story (all screen sizes) ── */}
        <div className="relative" style={{ zIndex: 2, minHeight: "400vh" }}>
          <div className="sticky top-0 h-screen flex items-center justify-center overflow-hidden" style={{ transform: "translateZ(0)", backfaceVisibility: "hidden" }}>
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
      <section id="product-features" className="py-20 sm:py-36 px-4 sm:px-12 lg:px-20 bg-[#fafafa]">
        <div className="max-w-[1240px] mx-auto">
          <div className="text-center max-w-xl mx-auto mb-12 sm:mb-20">
            <p className="text-[11px] font-medium text-primary-500 uppercase tracking-[0.2em] mb-4">
              {t("landing.productFeatures.label")}
            </p>
            <h2 className="text-[clamp(1.5rem,3.5vw,2.5rem)] font-semibold tracking-[-0.03em] leading-[1.15] mb-5">
              {t("landing.productFeatures.title")}
            </h2>
            <p className="text-[#9a9a9a] text-[15px] sm:text-base leading-relaxed">
              {t("landing.productFeatures.subtitle")}
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-5">
            {PRODUCT_FEATURES.map((feature) => (
              <div
                key={feature.key}
                className="bg-white rounded-2xl p-6 sm:p-7 hover:shadow-sm transition-shadow duration-200 group"
              >
                <div className={`w-11 h-11 rounded-xl bg-gradient-to-br ${feature.gradient} flex items-center justify-center mb-5 group-hover:scale-105 transition-transform duration-200`}>
                  <span className={feature.iconColor}>{feature.icon}</span>
                </div>
                <h3 className="text-[15px] font-semibold text-gray-900 mb-2">
                  {t(`landing.productFeatures.${feature.key}.title`)}
                </h3>
                <p className="text-[13px] sm:text-sm text-[#9a9a9a] leading-[1.7]">
                  {t(`landing.productFeatures.${feature.key}.desc`)}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ───── Get Started: Zigzag ───── */}
      <section id="get-started" className="py-20 sm:py-36 px-4 sm:px-12 lg:px-20 bg-white">
        <div className="max-w-[1240px] mx-auto">
          {/* Header */}
          <div className="text-center max-w-xl mx-auto mb-12 sm:mb-24">
            <p className="text-[11px] font-medium text-primary-500 uppercase tracking-[0.2em] mb-4">
              {t("landing.howItWorks.label")}
            </p>
            <h2 className="text-[clamp(1.5rem,3.5vw,2.5rem)] font-semibold tracking-[-0.03em] leading-[1.15] mb-5">
              {t("landing.howItWorks.title")}
            </h2>
            <p className="text-[#9a9a9a] text-[15px] sm:text-base leading-relaxed">
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
                    <div className="flex items-center gap-3.5 mb-4 sm:mb-5">
                      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary-500/10 text-primary-500 flex items-center justify-center text-[13px] font-semibold">
                        {i + 1}
                      </div>
                      <h3 className="text-lg sm:text-xl font-semibold tracking-[-0.02em] text-gray-900">
                        {t(`landing.howItWorks.${step}.title`)}
                      </h3>
                    </div>
                    <p className="text-[#9a9a9a] text-sm sm:text-[15px] leading-[1.75] ps-[46px]">
                      {t(`landing.howItWorks.${step}.desc`)}
                    </p>
                  </div>

                  {/* Visual */}
                  <div className="flex-1 w-full max-w-md">
                    <div className="rounded-2xl overflow-hidden shadow-sm">
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
      <section className="py-20 sm:py-36 px-4 sm:px-12 lg:px-20 bg-[#fafafa]">
        <div className="max-w-[720px] mx-auto">
          <div className="text-center mb-10 sm:mb-14">
            <p className="text-[11px] font-medium text-primary-500 uppercase tracking-[0.2em] mb-4">
              {t("landing.faq.label")}
            </p>
            <h2 className="text-[clamp(1.5rem,3.5vw,2.5rem)] font-semibold tracking-[-0.03em] leading-[1.15]">
              {t("landing.faq.title")}
            </h2>
          </div>
          <div className="bg-white rounded-2xl px-5 sm:px-8 shadow-sm">
            {((t("landing.faq.items") as unknown) as { q: string; a: string }[])?.map?.((item, i) => (
              <FaqItem key={i} question={item.q} answer={item.a} />
            )) ?? null}
          </div>
        </div>
      </section>

      {/* ───── CTA ───── */}
      <section className="py-20 sm:py-36 px-4 sm:px-6">
        <div className="max-w-2xl mx-auto text-center">
          <h2 className="text-[clamp(1.5rem,3.5vw,2.5rem)] font-semibold tracking-[-0.03em] leading-[1.15] mb-5">
            {t("landing.cta.title")}
          </h2>
          <p className="text-[#9a9a9a] text-[15px] sm:text-base leading-relaxed mb-10">
            {t("landing.cta.subtitle")}
          </p>
          <Link
            href="/early-access"
            className="inline-flex px-10 py-4 text-[15px] font-semibold text-white bg-primary-500 rounded-2xl hover:bg-primary-600 transition-all duration-200 hover:scale-[1.02]"
            style={{ boxShadow: "0 4px 20px rgba(124,92,252,0.25)" }}
          >
            {t("landing.cta.button")}
          </Link>
        </div>
      </section>

      {/* ───── Footer ───── */}
      <footer className="py-10 sm:py-14 px-4 sm:px-12 lg:px-20 bg-[#fafafa]">
        <div className="max-w-[1240px] mx-auto">
          <div className="flex flex-col md:flex-row justify-between gap-10">
            <div className="max-w-xs">
              <Logo />
              <p className="mt-4 text-[13px] text-[#b0b0b0] leading-relaxed">
                {t("landing.hero.subtitle").slice(0, 80)}...
              </p>
            </div>

            <div className="grid grid-cols-3 gap-8 sm:gap-12 text-sm">
              <div>
                <h4 className="font-medium text-gray-900 mb-3 sm:mb-4 text-[13px]">{t("landing.footer.product")}</h4>
                <ul className="space-y-2.5 text-[#b0b0b0]">
                  <li><a href="#how-it-works" className="hover:text-gray-900 transition-colors duration-200 text-[13px]">{t("landing.nav.howItWorks")}</a></li>
                  <li><a href="#product-features" className="hover:text-gray-900 transition-colors duration-200 text-[13px]">{t("landing.nav.features")}</a></li>
                </ul>
              </div>
              <div>
                <h4 className="font-medium text-gray-900 mb-3 sm:mb-4 text-[13px]">{t("landing.footer.company")}</h4>
                <ul className="space-y-2.5 text-[#b0b0b0]">
                  <li><a href="#" className="hover:text-gray-900 transition-colors duration-200 text-[13px]">{t("landing.footer.about")}</a></li>
                  <li><a href="#" className="hover:text-gray-900 transition-colors duration-200 text-[13px]">{t("landing.footer.blog")}</a></li>
                </ul>
              </div>
              <div>
                <h4 className="font-medium text-gray-900 mb-3 sm:mb-4 text-[13px]">{t("landing.footer.legal")}</h4>
                <ul className="space-y-2.5 text-[#b0b0b0]">
                  <li><Link href="/privacy-policy" className="hover:text-gray-900 transition-colors duration-200 text-[13px]">{t("landing.footer.privacy")}</Link></li>
                  <li><Link href="/terms" className="hover:text-gray-900 transition-colors duration-200 text-[13px]">{t("landing.footer.terms")}</Link></li>
                </ul>
              </div>
            </div>
          </div>

          <div className="mt-8 sm:mt-10 pt-6 sm:pt-8 border-t border-gray-200/60 flex flex-col sm:flex-row items-center justify-between gap-3 text-[13px] text-[#b0b0b0]">
            <p>&copy; {new Date().getFullYear()} GOTCHA. {t("landing.footer.copyright")}</p>
            <p className="text-[11px] text-[#c0c0c0]">Founds and Operated by Omer Serruya | עומר צרויה, Matan Amran | מתן עמרן</p>
            <Link href={otherPath} className="hover:text-gray-900 transition-colors duration-200">
              {otherLabel}
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
