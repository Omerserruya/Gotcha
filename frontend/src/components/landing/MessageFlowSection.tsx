"use client";

import { memo, useEffect, useRef, useState } from "react";

/* ───── Config ───── */

const CHANNELS = [
  { name: "WhatsApp", icon: "/icons/wa.png", color: "#25D366" },
  { name: "Instagram", icon: "/icons/ins.png", color: "#E1306C" },
  { name: "Gmail", icon: "/icons/gm.png", color: "#EA4335" },
  { name: "Messenger", icon: "/icons/msn.png", color: "#0084FF" },
  { name: "Outlook", icon: "/icons/ol.png", color: "#0078D4" },
  { name: "Slack", icon: "/icons/slk.png", color: "#4A154B" },
] as const;

const MESSAGES = Array.from({ length: 30 }, (_, i) => ({
  id: i,
  channel: CHANNELS[i % CHANNELS.length],
  y: ((i * 37 + i * i * 3) % 80) + 10,
  speed: 0.7 + ((i * 13) % 30) / 100,
  size: i % 5 === 0 ? "lg" : i % 3 === 0 ? "md" : "sm",
}));

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/* ───── Floating Text (positioned near content) ───── */
const FloatingText = memo(function FloatingText({
  text,
  desc,
  opacity,
  style,
  className = "",
}: {
  text: string;
  desc?: string;
  opacity: number;
  style?: React.CSSProperties;
  className?: string;
}) {
  if (opacity <= 0) return null;
  return (
    <div
      className={`absolute pointer-events-none z-40 ${className}`}
      style={{
        opacity,
        transform: `translateY(${(1 - opacity) * 12}px)`,
        willChange: "opacity, transform",
        ...style,
      }}
    >
      {/* Subtle backdrop on mobile - fades out at bottom */}
      <div className="md:hidden absolute -inset-4 -z-10 rounded-xl" style={{ background: "linear-gradient(180deg, rgba(14,14,18,0.8) 0%, rgba(14,14,18,0.5) 70%, transparent 100%)" }} />
      <p className="text-base sm:text-xl md:text-2xl font-light tracking-[-0.02em] text-white/90 leading-snug">
        {text}
      </p>
      {desc && (
        <p className="mt-1.5 text-xs sm:text-sm font-light text-white/40 leading-relaxed max-w-sm">
          {desc}
        </p>
      )}
    </div>
  );
});

/* ───── Stage 1: Messages flooding in from left ───── */
function FloodingMessages({ progress }: { progress: number }) {
  return (
    <div className="absolute top-0 bottom-0 left-0 right-0 md:right-[40%] overflow-hidden pointer-events-none">
      {MESSAGES.map((msg, i) => {
        const delay = i * 0.012;
        const p = Math.max(0, Math.min(1, (progress - delay) * 1.8));
        const ep = easeOut(p);
        const startX = -100 - (i % 5) * 35;
        const targetX = 40 + (i % 7) * 18;
        const x = lerp(startX, targetX, ep);
        const baseY = msg.y;
        const wobble = Math.sin(i * 2.1 + progress * 10) * 2.5;

        return (
          <div
            key={msg.id}
            className="absolute"
            style={{
              left: `${x}px`,
              top: `${baseY}%`,
              transform: `translateY(${wobble}px)`,
              opacity: p > 0 ? Math.min(1, p * 2) : 0,
            }}
          >
            <div
              className="rounded-lg flex items-center gap-1.5 px-2 py-1"
              style={{
                background: `${msg.channel.color}12`,
                border: `1px solid ${msg.channel.color}20`,
                boxShadow: `0 2px 8px ${msg.channel.color}10`,
              }}
            >
              <img src={msg.channel.icon} alt="" className="w-4 h-4 flex-shrink-0" />
              <div className={`rounded-full bg-white/10 ${msg.size === "lg" ? "w-14 h-1.5" : msg.size === "md" ? "w-9 h-1.5" : "w-6 h-1.5"}`} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ───── The Pipe (horizontal → curve down) ───── */
function PipeFlow({ progress }: { progress: number }) {
  const draw = Math.min(1, progress);
  return (
    <svg
      className="absolute inset-0 w-full h-full pointer-events-none hidden md:block"
      viewBox="0 0 1200 700"
      preserveAspectRatio="xMidYMid meet"
      style={{ opacity: Math.min(1, progress / 0.08) }}
    >
      <defs>
        <linearGradient id="pipeG" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#7c5cfc" stopOpacity="0.6" />
          <stop offset="50%" stopColor="#a855f7" stopOpacity="0.4" />
          <stop offset="100%" stopColor="#06b6d4" stopOpacity="0.3" />
        </linearGradient>
        <filter id="pipeGlow"><feGaussianBlur stdDeviation="8" /></filter>
      </defs>
      {/* Glow */}
      <path d="M 0,350 L 480,350 Q 580,350 580,450 L 580,700" fill="none" stroke="rgba(124,92,252,0.12)" strokeWidth="50" filter="url(#pipeGlow)" strokeDasharray="1600" strokeDashoffset={1600 - draw * 1600} />
      {/* Pipe fill */}
      <path d="M 0,350 L 480,350 Q 580,350 580,450 L 580,700" fill="none" stroke="rgba(124,92,252,0.08)" strokeWidth="36" strokeLinecap="round" strokeDasharray="1600" strokeDashoffset={1600 - draw * 1600} />
      {/* Pipe edge */}
      <path d="M 0,350 L 480,350 Q 580,350 580,450 L 580,700" fill="none" stroke="url(#pipeG)" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="1600" strokeDashoffset={1600 - draw * 1600} />
      {/* Particles */}
      {draw > 0.1 && [0, 0.18, 0.38, 0.58, 0.78].map((offset, i) => {
        const t = ((progress * 1.5 + offset) % 1);
        let px: number, py: number;
        if (t < 0.52) { px = (t / 0.52) * 540; py = 350; }
        else if (t < 0.68) { const ct = (t - 0.52) / 0.16; px = 540 + ct * 40; py = 350 + ct * 100; }
        else { px = 580; py = 450 + ((t - 0.68) / 0.32) * 250; }
        return <circle key={i} cx={px} cy={py} r={3} fill={CHANNELS[i].color} opacity={0.5} />;
      })}
    </svg>
  );
}

/* ───── Stage 2: Bot Processing ───── */
function BotZone({ progress, t }: { progress: number; t: (k: string) => string }) {
  const appear = easeOut(Math.min(1, progress / 0.15));
  const processing = Math.min(1, Math.max(0, (progress - 0.08) / 0.6));
  const incoming = Math.round(lerp(58, 12, processing));
  const resolved = Math.round(lerp(0, 46, processing));
  const pct = Math.round(lerp(0, 79, processing));

  return (
    <div
      className="absolute right-[5%] top-[35%] md:right-[12%] md:top-[25%]"
      style={{ opacity: appear, transform: `scale(${0.88 + 0.12 * appear})`, willChange: "transform, opacity" }}
    >
      {/* Bot card */}
      <div className="bg-[#16162a]/90 backdrop-blur-md border border-amber-500/15 rounded-2xl p-3 sm:p-5 min-w-[160px] sm:min-w-[200px]">
        <div className="flex items-center gap-3 mb-3">
          <div className="relative w-11 h-11 rounded-xl bg-gradient-to-br from-amber-500/20 to-green-500/15 border border-amber-400/20 flex items-center justify-center">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-amber-400">
              <path d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z" />
            </svg>
            {processing > 0 && processing < 0.95 && (
              <div className="absolute inset-0 rounded-xl border-2 border-transparent border-t-amber-400/50 flow-spin" />
            )}
          </div>
          <div>
            <span className="text-xs font-semibold text-amber-400">{t("landing.flow.smartBot")}</span>
            {processing > 0.9 && (
              <span className="block text-[9px] text-green-400/70 font-medium mt-0.5">{t("landing.flow.complete")}</span>
            )}
          </div>
        </div>

        {/* Stats */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-white/30">{t("landing.flow.incoming")}</span>
            <span className="font-mono font-semibold text-white/60">{incoming}</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-white/[0.06] overflow-hidden">
            <div className="h-full rounded-full bg-gradient-to-r from-amber-400/60 to-green-400/60 transition-none" style={{ width: `${pct}%` }} />
          </div>
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-white/30">{t("landing.flow.autoResolved")}</span>
            <span className="font-mono font-bold text-green-400/80">{resolved}</span>
          </div>
          {processing > 0.5 && (
            <div
              className="flex items-center gap-1.5 pt-1 border-t border-white/[0.04]"
              style={{ opacity: Math.min(1, (processing - 0.5) / 0.2) }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-green-400/60">
                <path d="M4.5 12.75l6 6 9-13.5" />
              </svg>
              <span className="text-[10px] text-green-400/60 font-medium">{pct}% {t("landing.flow.handledAuto")}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ───── Stage 3: Chat on screen + Intent Banner + Input ───── */
function ScreenChat({ progress, isRtl, suggestProgress, t }: { progress: number; isRtl: boolean; suggestProgress: number; t: (k: string) => string }) {
  const messages = [
    { from: "customer", text: t("landing.flow.chatMsg1"), delay: 0 },
    { from: "customer", text: t("landing.flow.chatMsg2"), delay: 0.1 },
    { from: "agent", text: t("landing.flow.chatMsg3"), delay: 0.22 },
    { from: "agent", text: t("landing.flow.chatMsg4"), delay: 0.45 },
    { from: "customer", text: t("landing.flow.chatMsg5"), delay: 0.6 },
    { from: "agent", text: t("landing.flow.chatMsg6"), delay: 0.72 },
  ];

  // Intent banner appears after first 2 customer messages
  const intentAppear = easeOut(Math.min(1, Math.max(0, (progress - 0.15) / 0.1)));

  // Suggested reply jumping into input
  const inputFilled = suggestProgress > 0.8;
  const inputText = inputFilled ? t("landing.flow.suggestText") : "";

  return (
    <div className="absolute inset-0 flex justify-center pointer-events-none">
      {/* Chat area - always centered */}
      <div className="w-full max-w-md md:max-w-lg h-full flex flex-col justify-end px-3 sm:px-6 pb-[50px] md:pb-[50px] pt-[52vh] md:pt-0">
        {/* Intent banner - above chat */}
        {intentAppear > 0 && (
          <div
            className="mb-3 md:mb-4 flex items-start gap-2 md:gap-2.5 bg-gradient-to-r from-orange-500/10 to-purple-500/8 border border-orange-500/15 rounded-xl px-2.5 py-2 md:px-3.5 md:py-2.5 backdrop-blur-sm"
            style={{ opacity: intentAppear, transform: `translateY(${(1 - intentAppear) * 8}px)` }}
          >
            <div className="w-7 h-7 rounded-lg bg-orange-500/15 flex items-center justify-center flex-shrink-0 mt-0.5">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-orange-400">
                <path d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
              </svg>
            </div>
            <div>
              <span className="text-[10px] font-semibold text-orange-400/80 uppercase tracking-wider">{t("landing.flow.intentLabel")}</span>
              <p className="text-[11px] sm:text-xs text-white/50 leading-relaxed mt-0.5">
                {t("landing.flow.intentDetail")}
              </p>
              <div className="flex gap-1.5 mt-1.5">
                <span className="text-[8px] px-1.5 py-0.5 rounded-full bg-red-500/10 text-red-400/60 border border-red-500/10">{t("landing.flow.intentFrustrated")}</span>
                <span className="text-[8px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400/60 border border-amber-500/10">{t("landing.flow.intentReturn")}</span>
                <span className="text-[8px] px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-400/60 border border-blue-500/10">{t("landing.flow.intentPriority")}</span>
              </div>
            </div>
          </div>
        )}

        {/* Chat messages - grow upward from the input, fade at top on mobile */}
        <div className="space-y-2.5 mb-4 flow-chat-fade">
          {messages.map((msg, i) => {
            const p = Math.min(1, Math.max(0, (progress - msg.delay) / 0.1));
            const ep = easeOut(p);
            if (p <= 0) return null;
            const isCustomer = msg.from === "customer";
            const align = isCustomer ? (isRtl ? "justify-end" : "justify-start") : (isRtl ? "justify-start" : "justify-end");

            return (
              <div
                key={i}
                className={`flex ${align}`}
                style={{ opacity: ep, transform: `translateY(${(1 - ep) * 14}px)`, willChange: "transform, opacity" }}
              >
                <div className={`max-w-[85%] px-3.5 py-2.5 rounded-2xl shadow-sm ${
                  isCustomer
                    ? "bg-white/[0.08] border border-white/[0.06] rounded-tl-sm"
                    : "bg-gradient-to-br from-primary-500/25 to-primary-600/20 border border-primary-400/15 rounded-tr-sm"
                }`}>
                  {isCustomer && <span className="text-[8px] text-white/25 block mb-0.5">{t("landing.flow.customer")}</span>}
                  {!isCustomer && <span className="text-[8px] text-primary-300/50 block mb-0.5">{t("landing.flow.agentName")}</span>}
                  <p className={`text-[12px] sm:text-[13px] leading-relaxed ${isCustomer ? "text-white/60" : "text-white/75"}`}>{msg.text}</p>
                </div>
              </div>
            );
          })}
        </div>

        {/* Message input bar - pill shape, white, purple glow - always at bottom */}
        <div className="w-full">
          <div className="relative">
            {/* Purple glow aura (always visible, intensifies when filled) */}
            <div
              className="absolute -inset-2 rounded-full blur-xl transition-none"
              style={{
                background: "radial-gradient(ellipse at center, rgba(124,92,252,0.25) 0%, rgba(124,92,252,0.08) 50%, transparent 70%)",
                opacity: inputFilled ? 1 : 0.5,
              }}
            />
            {/* Glow border ring */}
            <div
              className="absolute -inset-[2px] rounded-full transition-none"
              style={{
                background: inputFilled
                  ? "linear-gradient(90deg, rgba(124,92,252,0.5), rgba(168,130,255,0.6), rgba(124,92,252,0.5))"
                  : "linear-gradient(90deg, rgba(124,92,252,0.2), rgba(168,130,255,0.25), rgba(124,92,252,0.2))",
              }}
            />
            <div className="relative bg-white rounded-full flex items-center px-4 py-2.5 gap-2.5 shadow-lg">
              {inputFilled ? (
                <p className="text-[11px] sm:text-xs text-gray-700 flex-1 leading-relaxed flow-text-appear">
                  {inputText}
                </p>
              ) : (
                <span className="text-[11px] text-gray-300 flex-1">{t("landing.flow.typeMessage")}</span>
              )}
              <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 transition-none ${inputFilled ? "bg-primary-500 shadow-[0_2px_10px_rgba(124,92,252,0.4)]" : "bg-gray-100"}`}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={inputFilled ? "text-white" : "text-gray-300"}>
                  <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
                </svg>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ───── Stage 3b: Copilot Thinking (right side) ───── */
function CopilotPanel({ progress, onSuggestReady, t }: { progress: number; onSuggestReady: number; t: (k: string) => string }) {
  const appear = easeOut(Math.min(1, progress / 0.12));

  const thinkingSteps = [
    { icon: "search", text: t("landing.flow.thinkStep1"), delay: 0, color: "text-white/30" },
    { icon: "brain", text: t("landing.flow.thinkStep2"), delay: 0.08, color: "text-orange-400/60" },
    { icon: "db", text: t("landing.flow.thinkStep3"), delay: 0.16, color: "text-white/40" },
    { icon: "book", text: t("landing.flow.thinkStep4"), delay: 0.24, color: "text-green-400/50" },
    { icon: "route", text: t("landing.flow.thinkStep5"), delay: 0.32, color: "text-primary-300/60" },
    { icon: "spark", text: t("landing.flow.thinkStep6"), delay: 0.40, color: "text-primary-400/50" },
  ];

  const suggestionDelay = 0.52;
  const sP = easeOut(Math.min(1, Math.max(0, (progress - suggestionDelay) / 0.12)));

  return (
    <div
      className="absolute flex flex-col top-[14%] bottom-[14%] right-[4%] flow-copilot-panel"
      style={{
        opacity: appear,
        willChange: "transform, opacity",
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-primary-500/25 to-purple-500/20 border border-primary-500/20 flex items-center justify-center">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-primary-400">
            <path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25" />
            <path d="M18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456Z" />
          </svg>
        </div>
        <div>
          <span className="text-xs font-semibold text-primary-300">{t("landing.flow.copilotTitle")}</span>
          <span className="text-[9px] text-white/20 block">{t("landing.flow.copilotSubtitle")}</span>
        </div>
        {progress > 0 && progress < suggestionDelay && (
          <span className="inline-flex items-center gap-1 ms-auto">
            <span className="w-1.5 h-1.5 rounded-full bg-primary-400/50 flow-dot-1" />
            <span className="w-1.5 h-1.5 rounded-full bg-primary-400/50 flow-dot-2" />
            <span className="w-1.5 h-1.5 rounded-full bg-primary-400/50 flow-dot-3" />
          </span>
        )}
        {sP > 0.5 && (
          <div className="w-2 h-2 rounded-full bg-green-400 ms-auto flow-pulse-ring-sm" />
        )}
      </div>

      {/* Thinking steps */}
      <div className="space-y-2 mb-4 flex-1">
        {thinkingSteps.map((step, i) => {
          const p = Math.min(1, Math.max(0, (progress - step.delay) / 0.06));
          if (p <= 0) return null;
          const ep = easeOut(p);
          const chars = Math.round(step.text.length * ep);
          return (
            <div
              key={i}
              className="flex items-start gap-2"
              style={{ opacity: 0.4 + 0.6 * ep }}
            >
              <div className="w-4 h-4 rounded bg-white/[0.04] flex items-center justify-center flex-shrink-0 mt-0.5">
                {step.icon === "search" && <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-white/20"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>}
                {step.icon === "brain" && <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-orange-400/50"><path d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/></svg>}
                {step.icon === "db" && <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-white/20"><path d="M20 7H4m16 0v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7m16 0l-4-4H8L4 7"/></svg>}
                {step.icon === "book" && <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-green-400/40"><path d="M4.5 12.75l6 6 9-13.5"/></svg>}
                {step.icon === "route" && <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-primary-400/40"><path d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3"/></svg>}
                {step.icon === "spark" && <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-primary-400/50"><path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25"/></svg>}
              </div>
              <span className={`text-[10px] sm:text-[11px] leading-relaxed font-mono ${step.color}`}>
                {step.text.slice(0, chars)}
                {p < 1 && <span className="flow-cursor">|</span>}
              </span>
            </div>
          );
        })}
      </div>

      {/* Suggestion card */}
      {sP > 0 && (
        <div
          className="bg-gradient-to-br from-primary-500/10 to-purple-500/8 border border-primary-500/20 rounded-xl p-3.5 backdrop-blur-sm"
          style={{ opacity: easeOut(sP), transform: `translateY(${(1 - easeOut(sP)) * 12}px)` }}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-[9px] font-bold text-primary-400 uppercase tracking-wider">{t("landing.flow.suggestedReply")}</span>
            <div className="flex items-center gap-1">
              <div className="h-1 w-10 rounded-full bg-green-500/20">
                <div className="h-full rounded-full bg-green-500/60 transition-none" style={{ width: `${94 * sP}%` }} />
              </div>
              <span className="text-[9px] text-green-400/70 font-mono">{Math.round(94 * sP)}%</span>
            </div>
          </div>
          <p className="text-[11px] sm:text-xs text-white/55 leading-relaxed mb-2.5">
            &ldquo;{t("landing.flow.suggestText")}&rdquo;
          </p>
          <div className="flex items-center gap-1.5 mb-2 text-[9px] text-white/25">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-primary-400/30">
              <path d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25v14.25" />
            </svg>
            {t("landing.flow.suggestSource")}
          </div>
          {sP > 0.6 && (
            <button
              className="w-full py-2 rounded-lg bg-primary-500/30 text-[11px] font-semibold text-primary-200 flex items-center justify-center gap-1.5"
              style={{ opacity: Math.min(1, (sP - 0.6) / 0.3) }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-primary-300">
                <path d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3" />
              </svg>
              {t("landing.flow.insertMessage")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* ───── Stage 4: Summary & Scores ───── */
function SummaryView({ progress, t }: { progress: number; t: (k: string) => string }) {
  const appear = easeOut(Math.min(1, progress / 0.15));

  const summaryLines = [
    { text: t("landing.flow.summaryLine1"), delay: 0.08 },
    { text: t("landing.flow.summaryLine2"), delay: 0.18 },
    { text: t("landing.flow.summaryLine3"), delay: 0.28 },
  ];

  const tags = [
    { text: t("landing.flow.tagReturn"), color: "bg-blue-500/10 text-blue-400/70 border-blue-500/10", delay: 0.32 },
    { text: t("landing.flow.tagOrder"), color: "bg-amber-500/10 text-amber-400/70 border-amber-500/10", delay: 0.36 },
    { text: t("landing.flow.tagResolved"), color: "bg-green-500/10 text-green-400/70 border-green-500/10", delay: 0.40 },
    { text: t("landing.flow.tagKB"), color: "bg-primary-500/10 text-primary-400/70 border-primary-500/10", delay: 0.44 },
  ];

  const scores = [
    { label: t("landing.flow.metricTime"), value: "1m 24s", pct: 96, color: "bg-green-500/60", delay: 0.2 },
    { label: t("landing.flow.metricFCR"), value: t("landing.flow.metricFCRVal"), pct: 100, color: "bg-green-500/60", delay: 0.28 },
    { label: t("landing.flow.metricSentiment"), value: t("landing.flow.metricSentimentVal"), pct: 92, color: "bg-green-500/60", delay: 0.36 },
    { label: t("landing.flow.metricAccuracy"), value: "94%", pct: 94, color: "bg-primary-500/60", delay: 0.44 },
  ];

  return (
    <div className="absolute inset-0 flex items-start justify-center pt-[260px] md:pt-[240px] px-4 pointer-events-none overflow-y-auto" style={{ opacity: appear }}>
      <div className="w-full max-w-3xl mx-auto px-4 sm:px-6 flex flex-col md:flex-row gap-5 md:gap-8">
        {/* Summary */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2.5 mb-5">
            <div className="w-9 h-9 rounded-xl bg-white/[0.04] border border-white/[0.06] flex items-center justify-center">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-white/40">
                <path d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
              </svg>
            </div>
            <div>
              <span className="text-sm font-semibold text-white/60">{t("landing.flow.summaryTitle")}</span>
              <span className="text-[9px] text-white/20 block">{t("landing.flow.summaryAuto")}</span>
            </div>
          </div>

          <div className="space-y-2 mb-5">
            {summaryLines.map((line, i) => {
              const p = Math.min(1, Math.max(0, (progress - line.delay) / 0.08));
              if (p <= 0) return null;
              return (
                <p key={i} className="text-[12px] sm:text-[13px] text-white/40 leading-relaxed" style={{ opacity: easeOut(p), transform: `translateX(${(1 - easeOut(p)) * 8}px)` }}>
                  {line.text}
                </p>
              );
            })}
          </div>

          <div className="flex flex-wrap gap-1.5 mb-5">
            {tags.map((tag, i) => {
              const p = Math.min(1, Math.max(0, (progress - tag.delay) / 0.06));
              if (p <= 0) return null;
              return (
                <span key={i} className={`text-[10px] px-2.5 py-1 rounded-full border ${tag.color}`} style={{ opacity: easeOut(p), transform: `scale(${0.85 + 0.15 * easeOut(p)})` }}>
                  {tag.text}
                </span>
              );
            })}
          </div>

          {/* Customer Highlights */}
          {(() => {
            const hlDelay = 0.48;
            const hlP = Math.min(1, Math.max(0, (progress - hlDelay) / 0.15));
            if (hlP <= 0) return null;
            const highlights = [
              { emoji: "😤", label: t("landing.flow.hlFrustrated"), detail: t("landing.flow.hlFrustratedDetail"), color: "text-red-400/70" },
              { emoji: "😊", label: t("landing.flow.hlSatisfied"), detail: t("landing.flow.hlSatisfiedDetail"), color: "text-green-400/70" },
              { emoji: "⚡", label: t("landing.flow.hlFast"), detail: t("landing.flow.hlFastDetail"), color: "text-blue-400/70" },
            ];
            return (
              <div style={{ opacity: easeOut(hlP), transform: `translateY(${(1 - easeOut(hlP)) * 8}px)` }}>
                <div className="flex items-center gap-1.5 mb-2.5">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-white/30">
                    <path d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" />
                  </svg>
                  <span className="text-[10px] font-bold text-white/25 uppercase tracking-wider">{t("landing.flow.highlightsTitle")}</span>
                </div>
                <div className="space-y-1.5">
                  {highlights.map((h, i) => {
                    const hp = Math.min(1, Math.max(0, (hlP - i * 0.12) / 0.15));
                    if (hp <= 0) return null;
                    return (
                      <div
                        key={i}
                        className="flex items-center gap-2.5 bg-white/[0.03] border border-white/[0.04] rounded-lg px-3 py-1.5"
                        style={{ opacity: easeOut(hp), transform: `translateX(${(1 - easeOut(hp)) * 6}px)` }}
                      >
                        <span className="text-sm flex-shrink-0">{h.emoji}</span>
                        <div className="flex-1 min-w-0">
                          <span className={`text-[11px] font-medium ${h.color}`}>{h.label}</span>
                          <span className="text-[10px] text-white/25 ms-1.5">{h.detail}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}
        </div>

        {/* Scores */}
        <div className="w-full md:w-[240px] flex-shrink-0">
          <span className="text-[10px] font-bold text-white/20 uppercase tracking-wider block mb-3">{t("landing.flow.metricsTitle")}</span>
          <div className="space-y-3">
            {scores.map((s, i) => {
              const p = Math.min(1, Math.max(0, (progress - s.delay) / 0.12));
              if (p <= 0) return null;
              return (
                <div key={i} style={{ opacity: easeOut(p) }}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[11px] text-white/35">{s.label}</span>
                    <span className="text-[11px] font-mono text-white/55">{s.value}</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-white/[0.05] overflow-hidden">
                    <div className={`h-full rounded-full ${s.color} transition-none`} style={{ width: `${s.pct * easeOut(p)}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}


/* ═══════════════════════════════════════════
   MAIN SECTION
   ═══════════════════════════════════════════ */

export default function MessageFlowSection({
  t,
  isRtl,
}: {
  t: (key: string) => string;
  isRtl: boolean;
}) {
  const sectionRef = useRef<HTMLElement>(null);
  const [progress, setProgress] = useState(0);
  const rafRef = useRef(0);
  const lastP = useRef(0);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const onScroll = () => {
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        const rect = section.getBoundingClientRect();
        const scrolled = -rect.top;
        const total = rect.height - window.innerHeight;
        if (total > 0) {
          const p = Math.min(1, Math.max(0, scrolled / total));
          if (Math.abs(p - lastP.current) > 0.001) {
            lastP.current = p;
            setProgress(p);
          }
        }
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  /*
    Timeline (scroll 0–1):
    0.00–0.18  Stage 1: Messages flood in from left
    0.08–0.32  Pipe draws, messages flow into it
    0.18–0.45  Stage 2: Bot processes, count drops
    0.40–0.75  Stage 3: Chat + intent banner + copilot thinking
    0.72–1.00  Stage 4: Summary + scores
  */

  // Stage local progress
  const pMessages = Math.min(1, progress / 0.25);
  const pPipe = Math.min(1, Math.max(0, (progress - 0.06) / 0.30));
  const pBot = Math.min(1, Math.max(0, (progress - 0.16) / 0.28));
  const pChat = Math.min(1, Math.max(0, (progress - 0.40) / 0.32));
  const pCopilot = Math.min(1, Math.max(0, (progress - 0.43) / 0.28));
  const pSummary = Math.min(1, Math.max(0, (progress - 0.72) / 0.25));

  // Cross-fade
  const opMessages = progress < 0.22 ? 1 : Math.max(0, 1 - (progress - 0.22) / 0.08);
  const opPipe = progress < 0.06 ? 0 : progress < 0.36 ? Math.min(1, (progress - 0.06) / 0.06) : Math.max(0, 1 - (progress - 0.36) / 0.06);
  const opBot = progress < 0.16 ? 0 : progress < 0.38 ? Math.min(1, (progress - 0.16) / 0.06) : Math.max(0, 1 - (progress - 0.38) / 0.06);
  const opChat = progress < 0.40 ? 0 : progress < 0.68 ? Math.min(1, (progress - 0.40) / 0.06) : Math.max(0, 1 - (progress - 0.68) / 0.06);
  const opCopilot = progress < 0.43 ? 0 : progress < 0.68 ? Math.min(1, (progress - 0.43) / 0.06) : Math.max(0, 1 - (progress - 0.68) / 0.06);
  const opSummary = progress < 0.72 ? 0 : Math.min(1, (progress - 0.72) / 0.06);

  // Floating text - positioned near each element
  const txt1op = progress < 0.10 ? Math.min(1, progress / 0.05) : Math.max(0, 1 - (progress - 0.10) / 0.05);
  const txt2op = progress < 0.20 ? 0 : progress < 0.35 ? Math.min(1, (progress - 0.20) / 0.04) : Math.max(0, 1 - (progress - 0.35) / 0.04);
  const txt3op = progress < 0.44 ? 0 : progress < 0.62 ? Math.min(1, (progress - 0.44) / 0.04) : Math.max(0, 1 - (progress - 0.62) / 0.04);
  const txt4op = progress < 0.74 ? 0 : Math.min(1, (progress - 0.74) / 0.05);

  // Copilot suggestion -> input bar sync
  const suggestInInput = Math.min(1, Math.max(0, (pCopilot - 0.65) / 0.2));

  return (
    <section
      ref={sectionRef}
      id="how-it-works"
      className="flow-section relative"
      style={{ minHeight: "600vh" }}
    >
      {/* Background */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="landing-features-grid absolute inset-0" style={{ zIndex: 1 }} />
        <div className="absolute top-[5%] left-[-5%] w-[350px] sm:w-[500px] h-[350px] sm:h-[500px] rounded-full opacity-[0.10]" style={{ background: "radial-gradient(circle, #25D366 0%, transparent 70%)", filter: "blur(80px)" }} />
        <div className="absolute top-[30%] right-[-5%] w-[300px] sm:w-[450px] h-[300px] sm:h-[450px] rounded-full opacity-[0.08]" style={{ background: "radial-gradient(circle, #f59e0b 0%, transparent 70%)", filter: "blur(70px)" }} />
        <div className="absolute top-[55%] left-[5%] w-[350px] sm:w-[500px] h-[350px] sm:h-[500px] rounded-full opacity-[0.10]" style={{ background: "radial-gradient(circle, #7c5cfc 0%, transparent 70%)", filter: "blur(80px)" }} />
        <div className="absolute top-[80%] right-[5%] w-[300px] sm:w-[400px] h-[300px] sm:h-[400px] rounded-full opacity-[0.06]" style={{ background: "radial-gradient(circle, #6b7280 0%, transparent 70%)", filter: "blur(70px)" }} />
      </div>

      {/* Sticky viewport */}
      <div className="sticky top-0 h-screen overflow-hidden" style={{ zIndex: 2 }}>
        {/* Section label */}
        <p className="absolute top-[72px] sm:top-[76px] inset-x-0 text-center text-[10px] sm:text-xs font-medium text-primary-400 uppercase tracking-[0.15em] z-20">
          {t("landing.flow.label")}
        </p>

        {/* Stage 1: Flooding messages */}
        {opMessages > 0 && (
          <div style={{ opacity: opMessages }}>
            <FloodingMessages progress={pMessages} />
          </div>
        )}

        {/* Pipe */}
        {opPipe > 0 && (
          <div style={{ opacity: opPipe }}>
            <PipeFlow progress={pPipe} />
          </div>
        )}

        {/* Stage 2: Bot */}
        {opBot > 0 && (
          <div style={{ opacity: opBot }}>
            <BotZone progress={pBot} t={t} />
          </div>
        )}

        {/* Stage 3: Chat + Copilot - Desktop: separate panels */}
        {opChat > 0 && (
          <div className="hidden md:block" style={{ opacity: opChat }}>
            <ScreenChat progress={pChat} isRtl={isRtl} suggestProgress={suggestInInput} t={t} />
          </div>
        )}
        {opCopilot > 0 && (
          <div className="hidden md:block" style={{ opacity: opCopilot }}>
            <CopilotPanel progress={pCopilot} onSuggestReady={suggestInInput} t={t} />
          </div>
        )}

        {/* Stage 3: Mobile - stacked: copilot (compact) + chat (bottom-up) */}
        {(opChat > 0 || opCopilot > 0) && (
          <div className="md:hidden absolute inset-x-0 top-[200px] bottom-[40px] flex flex-col px-3" style={{ opacity: Math.max(opChat, opCopilot) }}>
            {/* Copilot - compact fixed-height card, lines scroll within */}
            <div className="bg-[#12121f]/95 backdrop-blur-md rounded-xl border border-primary-500/10 px-3 py-2 mb-1 flex-shrink-0 h-[22vh] flex flex-col">
              {/* Header - stays at top */}
              <div className="flex items-center gap-1.5 mb-1.5 flex-shrink-0">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-primary-400">
                  <path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25" />
                </svg>
                <span className="text-xs font-semibold text-primary-300">{t("landing.flow.copilotTitle")}</span>
                {pCopilot > 0 && pCopilot < 0.52 && (
                  <span className="inline-flex items-center gap-1 ms-auto">
                    <span className="w-1 h-1 rounded-full bg-primary-400/50 flow-dot-1" />
                    <span className="w-1 h-1 rounded-full bg-primary-400/50 flow-dot-2" />
                    <span className="w-1 h-1 rounded-full bg-primary-400/50 flow-dot-3" />
                  </span>
                )}
              </div>
              {/* Thinking lines - fill from bottom, old lines fade at top */}
              <div className="flex-1 min-h-0 overflow-hidden flex flex-col justify-end flow-copilot-fade">
              <div className="space-y-1">
                {[
                  { text: t("landing.flow.thinkStep1"), delay: 0, color: "text-white/40" },
                  { text: t("landing.flow.thinkStep2"), delay: 0.08, color: "text-orange-400/70" },
                  { text: t("landing.flow.thinkStep3"), delay: 0.16, color: "text-white/50" },
                  { text: t("landing.flow.thinkStep4"), delay: 0.24, color: "text-green-400/60" },
                  { text: t("landing.flow.thinkStep5"), delay: 0.32, color: "text-primary-300/70" },
                  { text: t("landing.flow.thinkStep6"), delay: 0.40, color: "text-primary-400/60" },
                ].map((step, i) => {
                  const p = Math.min(1, Math.max(0, (pCopilot - step.delay) / 0.06));
                  if (p <= 0) return null;
                  const ep = easeOut(p);
                  const chars = Math.round(step.text.length * ep);
                  return (
                    <p key={i} className={`text-[11px] leading-snug font-mono ${step.color}`} style={{ opacity: 0.4 + 0.6 * ep }}>
                      {step.text.slice(0, chars)}{p < 1 && <span className="flow-cursor">|</span>}
                    </p>
                  );
                })}
              </div>
              {/* Suggestion */}
              {(() => {
                const sP = easeOut(Math.min(1, Math.max(0, (pCopilot - 0.52) / 0.12)));
                if (sP <= 0) return null;
                return (
                  <div className="bg-primary-500/10 border border-primary-500/15 rounded-lg p-2 mt-1.5" style={{ opacity: sP }}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[9px] font-bold text-primary-400 uppercase">{t("landing.flow.suggestedReply")}</span>
                      <span className="text-[9px] text-green-400/70 font-mono">{Math.round(94 * sP)}%</span>
                    </div>
                    <p className="text-[11px] text-white/55 leading-snug">&ldquo;{t("landing.flow.suggestText")}&rdquo;</p>
                  </div>
                );
              })()}
              </div>{/* close flow-copilot-fade wrapper */}
            </div>

            {/* Chat - messages appear from bottom, go up, disappear behind copilot */}
            <div className="flex-1 min-h-0 flex flex-col">
              {/* Intent - AI insight */}
              {pChat > 0.15 && (
                <div className="flex items-center gap-1.5 text-[10px] text-orange-400/60 px-1 py-1 flex-shrink-0" style={{ opacity: easeOut(Math.min(1, (pChat - 0.15) / 0.1)) }}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-orange-400/50 flex-shrink-0">
                    <path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25" />
                  </svg>
                  {t("landing.flow.intentLabel")}: {t("landing.flow.intentReturn")} · #{4812}
                </div>
              )}

              {/* Messages - flex-col-reverse so they build from bottom */}
              <div className="flex-1 min-h-0 overflow-hidden flex flex-col justify-end">
                <div className="space-y-1.5 flow-chat-fade">
                  {[
                    { from: "customer", text: t("landing.flow.chatMsg1"), delay: 0 },
                    { from: "customer", text: t("landing.flow.chatMsg2"), delay: 0.1 },
                    { from: "agent", text: t("landing.flow.chatMsg3"), delay: 0.22 },
                    { from: "agent", text: t("landing.flow.chatMsg4"), delay: 0.45 },
                    { from: "customer", text: t("landing.flow.chatMsg5"), delay: 0.6 },
                    { from: "agent", text: t("landing.flow.chatMsg6"), delay: 0.72 },
                  ].map((msg, i) => {
                    const p = Math.min(1, Math.max(0, (pChat - msg.delay) / 0.1));
                    if (p <= 0) return null;
                    const ep = easeOut(p);
                    const isC = msg.from === "customer";
                    return (
                      <div key={i} className={`flex ${isC ? (isRtl ? "justify-end" : "justify-start") : (isRtl ? "justify-start" : "justify-end")}`}
                        style={{ opacity: ep }}>
                        <div className={`max-w-[82%] px-3 py-2 rounded-xl text-xs leading-relaxed ${
                          isC ? "bg-white/[0.07] text-white/60 rounded-tl-sm" : "bg-primary-500/20 text-white/70 rounded-tr-sm"
                        }`}>
                          {msg.text}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Input bar - prominent */}
              <div className="flex-shrink-0 mt-2">
                <div className="relative">
                  <div className="absolute -inset-1.5 rounded-full blur-xl" style={{ background: "radial-gradient(ellipse, rgba(124,92,252,0.3) 0%, transparent 70%)", opacity: suggestInInput > 0.8 ? 1 : 0.5 }} />
                  <div className="absolute -inset-[2px] rounded-full" style={{ background: suggestInInput > 0.8 ? "linear-gradient(90deg, rgba(124,92,252,0.5), rgba(168,130,255,0.6), rgba(124,92,252,0.5))" : "linear-gradient(90deg, rgba(124,92,252,0.15), rgba(168,130,255,0.2), rgba(124,92,252,0.15))" }} />
                  <div className="relative bg-white rounded-full flex items-center px-3.5 py-2 gap-2 shadow-lg">
                    {suggestInInput > 0.8 ? (
                      <p className="text-[11px] text-gray-700 flex-1 leading-relaxed">{t("landing.flow.suggestText")}</p>
                    ) : (
                      <span className="text-[11px] text-gray-300 flex-1">{t("landing.flow.typeMessage")}</span>
                    )}
                    <div className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 ${suggestInInput > 0.8 ? "bg-primary-500 shadow-[0_2px_8px_rgba(124,92,252,0.4)]" : "bg-gray-100"}`}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={suggestInInput > 0.8 ? "text-white" : "text-gray-300"}>
                        <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
                      </svg>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Stage 4: Summary */}
        {opSummary > 0 && (
          <div style={{ opacity: opSummary }}>
            <SummaryView progress={pSummary} t={t} />
          </div>
        )}

        {/* ── Floating text near each stage ── */}

        {/* Stage 1: bottom-center on mobile, right side on desktop */}
        <FloatingText
          text={t("landing.flow.stage1Text")}
          desc={t("landing.flow.stage1Desc")}
          opacity={txt1op}
          className="left-4 right-4 bottom-[12%] md:bottom-auto md:left-auto md:right-[8%] md:top-[38%] text-center md:text-end"
          style={{ maxWidth: "320px" }}
        />

        {/* Stage 2: bottom-center on mobile, left side on desktop */}
        <FloatingText
          text={t("landing.flow.stage2Text")}
          desc={t("landing.flow.stage2Desc")}
          opacity={txt2op}
          className="left-4 right-4 bottom-[8%] md:bottom-auto md:right-auto md:left-[8%] md:top-[55%] text-center md:text-start"
          style={{ maxWidth: "320px" }}
        />

        {/* Stage 3: top on mobile (above copilot), top-left on desktop */}
        <FloatingText
          text={t("landing.flow.stage3Text")}
          desc={t("landing.flow.stage3Desc")}
          opacity={txt3op}
          className="left-4 right-4 top-[100px] md:left-[5%] md:right-auto md:top-[110px] text-center md:text-start"
          style={{ maxWidth: "340px" }}
        />

        {/* Stage 4: top-center */}
        <FloatingText
          text={t("landing.flow.stage4Text")}
          desc={t("landing.flow.stage4Desc")}
          opacity={txt4op}
          className="left-4 right-4 top-[100px] md:top-[110px] text-center mx-auto"
          style={{ maxWidth: "400px" }}
        />

        {/* Progress bar */}
        <div className="absolute bottom-2 sm:bottom-3 inset-x-0 flex justify-center z-20">
          <div className="w-24 sm:w-32 h-1 bg-white/10 rounded-full overflow-hidden">
            <div className="h-full bg-primary-500 rounded-full transition-none" style={{ width: `${progress * 100}%` }} />
          </div>
        </div>
      </div>
    </section>
  );
}
