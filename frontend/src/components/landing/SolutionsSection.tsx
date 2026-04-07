"use client";

import { useState, useCallback } from "react";
import Link from "next/link";

const TEAMS = ["ops", "sales", "support", "social"] as const;
type Team = (typeof TEAMS)[number];

/* ───── Color themes per team ───── */
const THEMES: Record<Team, { descBg: string; descText: string; demoBg: string; accent: string; ctaBg: string; ctaHover: string; featureCheck: string; border: string }> = {
  ops: {
    descBg: "bg-gradient-to-br from-violet-600 to-violet-500",
    descText: "text-white",
    demoBg: "bg-gradient-to-br from-violet-50 to-white",
    accent: "text-violet-300",
    ctaBg: "bg-white text-violet-600 hover:bg-violet-50",
    ctaHover: "",
    featureCheck: "text-violet-300",
    border: "border-violet-200/30",
  },
  sales: {
    descBg: "bg-gradient-to-br from-emerald-600 to-emerald-500",
    descText: "text-white",
    demoBg: "bg-gradient-to-br from-emerald-50 to-white",
    accent: "text-emerald-300",
    ctaBg: "bg-white text-emerald-600 hover:bg-emerald-50",
    ctaHover: "",
    featureCheck: "text-emerald-300",
    border: "border-emerald-200/30",
  },
  support: {
    descBg: "bg-gradient-to-br from-blue-600 to-blue-500",
    descText: "text-white",
    demoBg: "bg-gradient-to-br from-blue-50 to-white",
    accent: "text-blue-300",
    ctaBg: "bg-white text-blue-600 hover:bg-blue-50",
    ctaHover: "",
    featureCheck: "text-blue-300",
    border: "border-blue-200/30",
  },
  social: {
    descBg: "bg-gradient-to-br from-pink-600 to-rose-500",
    descText: "text-white",
    demoBg: "bg-gradient-to-br from-pink-50 to-white",
    accent: "text-pink-300",
    ctaBg: "bg-white text-pink-600 hover:bg-pink-50",
    ctaHover: "",
    featureCheck: "text-pink-300",
    border: "border-pink-200/30",
  },
};

/* ───── Mockup Visuals ───── */

function OpsMockup() {
  return (
    <div className="w-full h-full bg-white/80 rounded-xl overflow-hidden flex text-[11px] shadow-sm">
      {/* Sidebar - hidden on mobile */}
      <div className="hidden sm:flex w-9 bg-white border-e border-gray-100 flex-col items-center py-3 gap-2.5">
        <div className="w-5 h-5 rounded-md bg-violet-500/10" />
        <div className="w-5 h-5 rounded-md bg-violet-500 flex items-center justify-center">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><path d="M2.25 13.5h3.86a2.25 2.25 0 0 1 2.012 1.244l.256.512a2.25 2.25 0 0 0 2.013 1.244h2.21a2.25 2.25 0 0 0 2.013-1.244l.256-.512a2.25 2.25 0 0 1 2.013-1.244h3.859M12 3v8.25m0 0-3-3m3 3 3-3" /></svg>
        </div>
        <div className="w-5 h-5 rounded-md bg-gray-100" />
        <div className="w-5 h-5 rounded-md bg-gray-100" />
      </div>
      {/* Conversation list - hidden on small mobile */}
      <div className="hidden sm:block w-[130px] bg-white border-e border-gray-100 p-2 space-y-1">
        <div className="text-[8px] font-semibold text-gray-400 uppercase tracking-wider px-1 mb-1.5">Inbox</div>
        {[
          { name: "Sarah M.", msg: "Where is my order?", ch: "/icons/wa.png", unread: true },
          { name: "David K.", msg: "Need a refund", ch: "/icons/gm.png", unread: true },
          { name: "Lisa R.", msg: "Thanks for helping!", ch: "/icons/ins.png", unread: false },
          { name: "Tom B.", msg: "API integration", ch: "/icons/slk.png", unread: false },
        ].map((c, i) => (
          <div key={i} className={`flex items-start gap-1.5 rounded-lg px-1.5 py-1 ${i === 0 ? "bg-violet-50 border border-violet-100" : ""}`}>
            <div className="w-5 h-5 rounded-full bg-gradient-to-br from-gray-200 to-gray-300 flex-shrink-0 flex items-center justify-center text-[7px] font-bold text-gray-500">{c.name[0]}</div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between">
                <span className="text-[9px] font-medium text-gray-800 truncate">{c.name}</span>
                <img src={c.ch} alt="" className="w-2.5 h-2.5 rounded-sm" />
              </div>
              <p className="text-[8px] text-gray-400 truncate">{c.msg}</p>
            </div>
            {c.unread && <div className="w-1.5 h-1.5 rounded-full bg-violet-500 mt-1 flex-shrink-0" />}
          </div>
        ))}
      </div>
      {/* Chat */}
      <div className="flex-1 flex flex-col">
        <div className="px-2.5 py-1.5 border-b border-gray-100 flex items-center gap-1.5 bg-white">
          <div className="w-5 h-5 rounded-full bg-gradient-to-br from-emerald-200 to-emerald-300 flex items-center justify-center text-[7px] font-bold text-emerald-700">S</div>
          <span className="text-[9px] font-semibold text-gray-800">Sarah M.</span>
          <span className="ms-auto text-[7px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-600 font-medium">SLA: 2m</span>
        </div>
        <div className="flex-1 p-2.5 space-y-1.5 flex flex-col justify-end">
          <div className="self-start max-w-[75%] bg-gray-50 border border-gray-100 rounded-xl rounded-tl-sm px-2 py-1">
            <p className="text-[9px] text-gray-700">Where is my order? #4812</p>
          </div>
          <div className="self-end max-w-[75%] bg-violet-500 rounded-xl rounded-br-sm px-2 py-1">
            <p className="text-[9px] text-white">Let me check that for you! 🔍</p>
          </div>
          <div className="flex items-center gap-1 self-start">
            <div className="w-3.5 h-3.5 rounded-full bg-violet-100 flex items-center justify-center">
              <svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-violet-500"><path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25" /></svg>
            </div>
            <span className="text-[8px] text-violet-500 font-medium">AI routed to shipping</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function SalesMockup() {
  return (
    <div className="w-full h-full bg-white/80 rounded-xl overflow-hidden flex text-[11px] shadow-sm">
      <div className="flex-1 flex flex-col">
        <div className="px-2.5 py-1.5 border-b border-gray-100 bg-white flex items-center gap-1.5">
          <div className="w-5 h-5 rounded-full bg-gradient-to-br from-blue-200 to-blue-300 flex items-center justify-center text-[7px] font-bold text-blue-700">J</div>
          <span className="text-[9px] font-semibold text-gray-800">James Wilson</span>
          <span className="ms-auto text-[7px] px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-600 font-semibold border border-emerald-100">Hot Lead</span>
        </div>
        <div className="flex-1 p-2.5 space-y-1.5 flex flex-col justify-end">
          <div className="self-start max-w-[80%] bg-gray-50 border border-gray-100 rounded-xl rounded-tl-sm px-2 py-1">
            <p className="text-[9px] text-gray-700">What&apos;s the pricing for a 50-person team?</p>
          </div>
          <div className="self-start max-w-[80%] bg-gray-50 border border-gray-100 rounded-xl rounded-tl-sm px-2 py-1">
            <p className="text-[9px] text-gray-700">We&apos;re switching from Zendesk</p>
          </div>
          <div className="border border-emerald-200 bg-emerald-50/50 rounded-xl px-2 py-1.5 space-y-1">
            <div className="flex items-center gap-1">
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-emerald-500"><path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25" /></svg>
              <span className="text-[8px] font-bold text-emerald-600 uppercase tracking-wider">AI Copilot</span>
              <span className="text-[8px] text-emerald-500 font-mono ms-auto">96%</span>
            </div>
            <p className="text-[9px] text-gray-600 leading-relaxed">&ldquo;For 50 users, our Growth plan is $29/seat/mo. Want a quick demo Thursday?&rdquo;</p>
            <button className="text-[8px] font-semibold text-white bg-emerald-500 rounded-md px-2.5 py-0.5">Send</button>
          </div>
        </div>
      </div>
      {/* Context sidebar - hidden on mobile */}
      <div className="hidden sm:block w-[110px] bg-white border-s border-gray-100 p-2 space-y-2.5">
        <div>
          <span className="text-[7px] font-bold text-gray-400 uppercase tracking-wider">Lead Score</span>
          <div className="flex items-center gap-1 mt-0.5">
            <div className="flex-1 h-1 rounded-full bg-gray-100 overflow-hidden"><div className="h-full w-[85%] rounded-full bg-emerald-500" /></div>
            <span className="text-[9px] font-mono font-semibold text-emerald-600">85</span>
          </div>
        </div>
        <div>
          <span className="text-[7px] font-bold text-gray-400 uppercase tracking-wider">Company</span>
          <p className="text-[9px] text-gray-700 mt-0.5">TechFlow Inc.</p>
          <p className="text-[8px] text-gray-400">50 employees</p>
        </div>
        <div>
          <span className="text-[7px] font-bold text-gray-400 uppercase tracking-wider">Intent</span>
          <div className="flex flex-wrap gap-0.5 mt-0.5">
            <span className="text-[7px] px-1 py-0.5 rounded bg-blue-50 text-blue-600">Pricing</span>
            <span className="text-[7px] px-1 py-0.5 rounded bg-amber-50 text-amber-600">Switch</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function SupportMockup() {
  return (
    <div className="w-full h-full bg-white/80 rounded-xl overflow-hidden flex text-[11px] shadow-sm">
      <div className="flex-1 flex flex-col">
        <div className="px-2.5 py-1.5 border-b border-gray-100 bg-white flex items-center gap-1.5">
          <div className="w-5 h-5 rounded-full bg-gradient-to-br from-orange-200 to-orange-300 flex items-center justify-center text-[7px] font-bold text-orange-700">A</div>
          <span className="text-[9px] font-semibold text-gray-800">Alex Chen</span>
          <span className="ms-auto text-[7px] px-1.5 py-0.5 rounded bg-red-50 text-red-500 font-medium">High</span>
        </div>
        <div className="flex-1 p-2.5 space-y-1.5 flex flex-col justify-end">
          <div className="self-start max-w-[80%] bg-gray-50 border border-gray-100 rounded-xl rounded-tl-sm px-2 py-1">
            <p className="text-[9px] text-gray-700">Can&apos;t connect WhatsApp. Getting permissions error.</p>
          </div>
          <div className="border border-amber-200 bg-amber-50/40 rounded-lg px-2 py-1 flex items-start gap-1">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-amber-500 mt-0.5 flex-shrink-0"><path d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25" /></svg>
            <div>
              <span className="text-[8px] font-bold text-amber-600 uppercase">KB Match</span>
              <p className="text-[8px] text-gray-500">WA Troubleshooting — 94%</p>
            </div>
          </div>
          <div className="self-end max-w-[85%] bg-blue-500 rounded-xl rounded-br-sm px-2 py-1">
            <p className="text-[9px] text-white">Go to Business Settings → WhatsApp → enable &quot;manage&quot;. Here&apos;s the guide: [link]</p>
          </div>
          <div className="flex items-center gap-1 self-end">
            <svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-blue-400"><path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25" /></svg>
            <span className="text-[8px] text-gray-400">AI reply from KB</span>
          </div>
        </div>
      </div>
      <div className="w-[110px] bg-white border-s border-gray-100 p-2 space-y-2.5">
        <div>
          <span className="text-[7px] font-bold text-gray-400 uppercase tracking-wider">Sentiment</span>
          <div className="flex items-center gap-1 mt-0.5">
            <span className="text-xs">😤</span>
            <span className="text-[9px] text-red-500 font-medium">Frustrated</span>
          </div>
        </div>
        <div>
          <span className="text-[7px] font-bold text-gray-400 uppercase tracking-wider">Topic</span>
          <div className="flex flex-wrap gap-0.5 mt-0.5">
            <span className="text-[7px] px-1 py-0.5 rounded bg-purple-50 text-purple-600">Integration</span>
          </div>
        </div>
        <div>
          <span className="text-[7px] font-bold text-gray-400 uppercase tracking-wider">Similar</span>
          <p className="text-[8px] text-gray-400 mt-0.5">#4801 — WA perms</p>
        </div>
        <div>
          <span className="text-[7px] font-bold text-emerald-500 font-medium">First Contact ✓</span>
        </div>
      </div>
    </div>
  );
}

function SocialMockup() {
  return (
    <div className="w-full h-full bg-white/80 rounded-xl overflow-hidden flex flex-col text-[11px] shadow-sm">
      {/* Header with channel pills */}
      <div className="px-2.5 py-1.5 border-b border-gray-100 flex items-center gap-1.5 bg-white">
        <span className="text-[9px] font-semibold text-gray-600">Social Inbox</span>
        <div className="flex gap-1 ms-auto">
          {["/icons/ins.png", "/icons/wa.png", "/icons/msn.png"].map((ch, i) => (
            <div key={i} className={`w-4.5 h-4.5 rounded-md flex items-center justify-center ${i === 0 ? "bg-pink-50 border border-pink-100" : "bg-gray-50 border border-gray-100"}`}>
              <img src={ch} alt="" className="w-2.5 h-2.5" />
            </div>
          ))}
        </div>
      </div>
      <div className="flex-1 flex">
        {/* Messages */}
        <div className="flex-1 p-2 space-y-1.5 flex flex-col justify-end">
          <div className="bg-gradient-to-r from-pink-50/60 to-white border border-pink-100/40 rounded-xl px-2 py-1.5">
            <div className="flex items-center gap-1 mb-0.5">
              <img src="/icons/ins.png" alt="" className="w-2.5 h-2.5" />
              <span className="text-[8px] font-medium text-gray-700">@emma.style</span>
              <span className="text-[7px] text-gray-400 ms-auto">2m</span>
            </div>
            <p className="text-[8px] text-gray-600">Love your product! Ship to Canada? 🇨🇦</p>
            <div className="flex items-center gap-1.5 mt-1">
              <span className="text-[7px] px-1 py-0.5 rounded bg-emerald-50 text-emerald-600">😊 Positive</span>
              <span className="text-[7px] px-1 py-0.5 rounded bg-blue-50 text-blue-600">Auto-reply ready</span>
            </div>
          </div>
          <div className="bg-gradient-to-r from-emerald-50/60 to-white border border-emerald-100/40 rounded-xl px-2 py-1.5">
            <div className="flex items-center gap-1 mb-0.5">
              <img src="/icons/wa.png" alt="" className="w-2.5 h-2.5" />
              <span className="text-[8px] font-medium text-gray-700">+1 555-0142</span>
              <span className="text-[7px] text-red-400 ms-auto font-medium">Urgent</span>
            </div>
            <p className="text-[8px] text-gray-600">Waiting 20 min for a response!</p>
            <div className="flex items-center gap-1.5 mt-1">
              <span className="text-[7px] px-1 py-0.5 rounded bg-red-50 text-red-600">😤 Frustrated</span>
              <span className="text-[7px] px-1 py-0.5 rounded bg-amber-50 text-amber-600">Escalate?</span>
            </div>
          </div>
          <div className="bg-gradient-to-r from-blue-50/60 to-white border border-blue-100/40 rounded-xl px-2 py-1.5">
            <div className="flex items-center gap-1 mb-0.5">
              <img src="/icons/msn.png" alt="" className="w-2.5 h-2.5" />
              <span className="text-[8px] font-medium text-gray-700">Mike J.</span>
              <span className="text-[7px] text-gray-400 ms-auto">5m</span>
            </div>
            <p className="text-[8px] text-gray-600">What are your hours?</p>
            <div className="flex items-center gap-1.5 mt-1">
              <span className="text-[7px] px-1 py-0.5 rounded bg-gray-50 text-gray-500">🤔 Neutral</span>
              <span className="text-[7px] px-1 py-0.5 rounded bg-emerald-50 text-emerald-600">✓ Bot handled</span>
            </div>
          </div>
        </div>
        {/* Insights - hidden on mobile */}
        <div className="hidden sm:block w-[95px] border-s border-gray-100 bg-gray-50/50 p-2 space-y-2">
          <div>
            <span className="text-[7px] font-bold text-gray-400 uppercase tracking-wider">Live</span>
            <div className="mt-1 space-y-0.5">
              <div className="flex justify-between"><span className="text-[7px] text-gray-500">Active</span><span className="text-[8px] font-semibold text-gray-700">12</span></div>
              <div className="flex justify-between"><span className="text-[7px] text-gray-500">Waiting</span><span className="text-[8px] font-semibold text-amber-500">4</span></div>
              <div className="flex justify-between"><span className="text-[7px] text-gray-500">Bot</span><span className="text-[8px] font-semibold text-emerald-500">8</span></div>
            </div>
          </div>
          <div className="h-px bg-gray-200/60" />
          <div>
            <span className="text-[7px] font-bold text-gray-400 uppercase tracking-wider">Sentiment</span>
            <div className="mt-1 space-y-0.5">
              <div className="flex items-center gap-1"><div className="flex-1 h-1 rounded-full bg-gray-100"><div className="h-full w-[65%] rounded-full bg-emerald-400" /></div><span className="text-[6px] text-gray-400">65%</span></div>
              <div className="flex items-center gap-1"><div className="flex-1 h-1 rounded-full bg-gray-100"><div className="h-full w-[20%] rounded-full bg-gray-300" /></div><span className="text-[6px] text-gray-400">20%</span></div>
              <div className="flex items-center gap-1"><div className="flex-1 h-1 rounded-full bg-gray-100"><div className="h-full w-[15%] rounded-full bg-red-400" /></div><span className="text-[6px] text-gray-400">15%</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const MOCKUPS: Record<Team, () => JSX.Element> = {
  ops: OpsMockup,
  sales: SalesMockup,
  support: SupportMockup,
  social: SocialMockup,
};

/* ───── Tab config ───── */
const TAB_ICONS: Record<Team, JSX.Element> = {
  ops: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 0 1-.825-.242m9.345-8.334a2.126 2.126 0 0 0-.476-.095 48.64 48.64 0 0 0-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0 0 11.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155" />
    </svg>
  ),
  sales: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M2.25 18L9 11.25l4.306 4.306a11.95 11.95 0 0 1 5.814-5.518l2.74-1.22m0 0-5.94-2.281m5.94 2.28-2.28 5.941" />
    </svg>
  ),
  support: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M16.712 4.33a9.027 9.027 0 0 1 1.652 1.306c.51.51.944 1.064 1.306 1.652M16.712 4.33l-3.448 4.138m3.448-4.138a9.014 9.014 0 0 0-9.424 0M19.67 7.288l-4.138 3.448m4.138-3.448a9.014 9.014 0 0 1 0 9.424m-4.138-5.976a3.736 3.736 0 0 0-.88-1.388 3.737 3.737 0 0 0-1.388-.88m2.268 2.268a3.765 3.765 0 0 1 0 2.528m-2.268-4.796l-3.448 4.138m5.716-.37-4.138 3.448m0 0a3.736 3.736 0 0 1-1.388.88 3.737 3.737 0 0 1-1.388-.88m2.776 0L9.598 19.67m3.114-3.114a3.765 3.765 0 0 1-2.528 0m0 0L7.288 19.67m2.86-3.114L7.288 19.67m0 0a9.027 9.027 0 0 1-1.652-1.306 9.027 9.027 0 0 1-1.306-1.652m2.958 2.958a9.014 9.014 0 0 1 0-9.424m0 9.424L4.33 16.712M4.33 7.288l4.138 3.448M4.33 7.288a9.014 9.014 0 0 1 9.424 0M7.288 4.33l3.448 4.138m0 0a3.736 3.736 0 0 0-1.388.88 3.736 3.736 0 0 0-.88 1.388" />
    </svg>
  ),
  social: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.076-4.076a1.526 1.526 0 0 1 1.037-.443 48.282 48.282 0 0 0 5.68-.494c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z" />
    </svg>
  ),
};

const TAB_ACTIVE_COLORS: Record<Team, string> = {
  ops: "bg-violet-500 text-white shadow-md shadow-violet-500/25",
  sales: "bg-emerald-500 text-white shadow-md shadow-emerald-500/25",
  support: "bg-blue-500 text-white shadow-md shadow-blue-500/25",
  social: "bg-pink-500 text-white shadow-md shadow-pink-500/25",
};

/* ───── Main Section ───── */

export default function SolutionsSection({
  t,
}: {
  t: (key: string) => string;
  isRtl?: boolean;
}) {
  const [active, setActive] = useState<Team>("ops");
  const handleTab = useCallback((team: Team) => setActive(team), []);

  const theme = THEMES[active];
  const features = t(`landing.solutions.${active}.features`) as unknown as string[];
  const Mockup = MOCKUPS[active];

  return (
    <section className="relative py-20 sm:py-36 px-4 sm:px-12 lg:px-20 bg-white overflow-hidden">
      {/* Hero-style gradient spots */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -top-32 -left-32 w-[400px] sm:w-[600px] h-[400px] sm:h-[600px] rounded-full opacity-[0.04]" style={{ background: "radial-gradient(circle, #9b59b6 0%, #7c3aed 40%, transparent 70%)", filter: "blur(80px)" }} />
        <div className="absolute top-1/4 -right-40 w-[400px] sm:w-[650px] h-[400px] sm:h-[650px] rounded-full opacity-[0.035]" style={{ background: "radial-gradient(circle, #06b6d4 0%, #3b82f6 40%, transparent 70%)", filter: "blur(90px)" }} />
      </div>
      <div className="landing-hero-grid pointer-events-none absolute inset-0 opacity-30" />

      <div className="max-w-[1240px] mx-auto relative z-10">
        {/* Header */}
        <div className="text-center max-w-xl mx-auto mb-10 sm:mb-14">
          <p className="text-[11px] font-medium text-primary-500 uppercase tracking-[0.2em] mb-4">
            {t("landing.solutions.label")}
          </p>
          <h2 className="text-[clamp(1.5rem,3.5vw,2.5rem)] font-semibold tracking-[-0.03em] leading-[1.15] mb-5">
            {t("landing.solutions.title")}
          </h2>
          <p className="text-[#9a9a9a] text-[15px] sm:text-base leading-relaxed">
            {t("landing.solutions.subtitle")}
          </p>
        </div>

        {/* Tabs */}
        <div className="flex justify-center mb-10 sm:mb-12">
          <div className="inline-flex items-center bg-gray-50 rounded-2xl p-1.5 gap-1 overflow-x-auto max-w-full scrollbar-hide">
            {TEAMS.map((team) => (
              <button
                key={team}
                onClick={() => handleTab(team)}
                className={`flex items-center gap-1.5 sm:gap-2 px-3 sm:px-7 py-2.5 sm:py-3 rounded-xl text-[12px] sm:text-sm font-medium transition-all duration-300 whitespace-nowrap flex-shrink-0 ${
                  active === team
                    ? TAB_ACTIVE_COLORS[team]
                    : "text-gray-400 hover:text-gray-600"
                }`}
              >
                <span className="hidden sm:inline">{TAB_ICONS[team]}</span>
                {t(`landing.solutions.${team}.title`)}
              </button>
            ))}
          </div>
        </div>

        {/* Ticket-style card: description | demo — touching with rounded edges */}
        <div key={active} className="flex flex-col lg:flex-row items-stretch rounded-2xl overflow-hidden shadow-lg animate-[fadeSlideIn_0.3s_ease-out]">
          {/* Description container */}
          <div className={`${theme.descBg} ${theme.descText} p-8 sm:p-10 lg:p-12 flex flex-col justify-center lg:w-[42%] lg:rounded-e-2xl`}>
            <h3 className="text-xl sm:text-2xl font-semibold tracking-[-0.02em] mb-4">
              {t(`landing.solutions.${active}.title`)}
            </h3>
            <p className="text-[14px] sm:text-[15px] leading-[1.8] opacity-85 mb-7">
              {t(`landing.solutions.${active}.desc`)}
            </p>
            <ul className="space-y-3 mb-8">
              {Array.isArray(features) && features.map((f, i) => (
                <li key={i} className="flex items-center gap-2.5 text-[13px] sm:text-[14px]">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className={`${theme.featureCheck} flex-shrink-0`}>
                    <path d="M4.5 12.75l6 6 9-13.5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  {f}
                </li>
              ))}
            </ul>
            <Link
              href="/early-access"
              className={`inline-flex self-start px-7 py-3 text-[13px] sm:text-[14px] font-semibold rounded-xl transition-all duration-200 hover:scale-[1.02] ${theme.ctaBg}`}
            >
              {t("landing.hero.cta")}
            </Link>
          </div>

          {/* Demo container */}
          <div className={`${theme.demoBg} p-4 sm:p-8 lg:p-10 flex items-center justify-center lg:w-[58%] lg:rounded-s-2xl`}>
            <div className="w-full h-[220px] sm:h-[320px]">
              <Mockup />
            </div>
          </div>
        </div>
      </div>

      <style jsx global>{`
        @keyframes fadeSlideIn {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </section>
  );
}
