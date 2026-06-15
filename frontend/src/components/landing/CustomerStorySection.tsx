"use client";

import { memo, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * CustomerStorySection — the landing "how it works" centerpiece.
 *
 * A scripted, scroll-scrubbed film. A tall section pins an inner stage; page
 * scroll 0→1 maps onto 8 shots. The middle five shots share ONE persistent
 * conversation window — the same chat, with messages appended one-by-one as
 * you scroll — while the side panel and header morph per shot. All demo copy
 * is localized (EN/HE) and the layout is RTL-aware.
 */

const SHOTS = 8;

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

// Reveals within a scene complete in its first ~half; the rest of the scene's
// scroll is a static "hold" so the finished scene stays in full view (a
// scrolling gap) before the next one begins.
const playProgress = (lp: number) => clamp(lp / 0.5);

// One conversation, built up across shots 2–6. `at` is the scroll position
// (0–8, i.e. shot index + fraction) at which each message appears.
interface ChatMsg { at: number; side: "in" | "out"; en?: ReactNode; he?: ReactNode; chipEn?: string; chipHe?: string; highlight?: boolean; copilot?: boolean }
const CHAT: ChatMsg[] = [
  { at: 1.12, side: "in", en: <>Hi! I ordered the <b>blue</b> shirt but received <b>grey</b> 😕</>, he: <>היי! הזמנתי חולצה <b>כחולה</b> אבל קיבלתי <b>אפורה</b> 😕</> },
  { at: 3.04, side: "out", en: <>So sorry! Let me pull up your order…</>, he: <>סליחה על כך! בודק את ההזמנה שלך…</> },
  { at: 3.14, side: "out", chipEn: "🔎 Looked up order #4812", chipHe: "🔎 אותרה הזמנה #4812" },
  { at: 3.26, side: "out", en: <>Done — I started a <b>free exchange</b> for the blue one 📦</>, he: <>בוצע — פתחתי <b>החלפה חינם</b> לכחולה 📦</>, highlight: true },
  { at: 3.36, side: "out", chipEn: "✓ Exchange created", chipHe: "✓ ההחלפה נוצרה" },
  { at: 3.48, side: "out", en: <>Ships today, arrives <b>Thu Jun 18</b> — tracking sent 📬</>, he: <>נשלח היום, מגיע ב<b>יום ה׳ 18.6</b> — מספר מעקב נשלח 📬</> },
  { at: 3.58, side: "out", chipEn: "✓ Tracking sent", chipHe: "✓ מעקב נשלח" },
  { at: 4.35, side: "in", en: <>Can I also change the size to <b>M</b>?</>, he: <>אפשר גם לשנות מידה ל-<b>M</b>?</> },
  { at: 5.62, side: "out", en: <>Of course! Set it to size <b>M</b> and kept the free exchange — plus a <b>10%</b> coupon for the trouble 💜</>, he: <>בטח! שיניתי למידה <b>M</b> ושמרתי על ההחלפה חינם — בנוסף קופון <b>10%</b> על אי הנוחות 💜</>, copilot: true },
];

function CustomerStorySection({ t, isRtl }: { t: (key: string) => string; isRtl: boolean }) {
  const [progress, setProgress] = useState(0); // 0→1 across the whole pinned track
  const sectionRef = useRef<HTMLElement>(null);
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
        const total = rect.height - window.innerHeight; // scrollable distance while pinned
        if (total <= 0) return;
        const p = clamp(-rect.top / total);
        if (Math.abs(p - lastP.current) > 0.0005) {
          lastP.current = p;
          setProgress(p);
        }
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0; // reset so a remount (StrictMode/dev) can schedule again
    };
  }, []);

  // active shot + local progress within it (drives narration + rail)
  const pos = progress * SHOTS;
  const shot = Math.min(SHOTS - 1, Math.floor(pos));
  const local = clamp(pos - shot);
  const title = t(`landing.story.scene${shot + 1}Title`);
  const sub = t(`landing.story.scene${shot + 1}Sub`);
  const he = isRtl;

  const shotStyle = (i: number): React.CSSProperties => {
    const d = Math.abs(pos - (i + 0.5));
    const o = clamp((0.55 - d) / 0.13); // full while |d|<=0.42 (long dwell), quick fade at the seam
    return { opacity: o, transform: `translateY(${(pos - (i + 0.5)) * -10}px)`, pointerEvents: o > 0.5 ? "auto" : "none" };
  };

  // The conversation arc owns shots 2–6 (indices 1–5). The chat is persistent;
  // only the side panel cross-fades between scenes.
  const arc: { i: number; panel: ReactNode }[] = [
    { i: 1, panel: <LeadCard he={he} /> },
    { i: 2, panel: <IntentPanel lp={clamp(pos - 2)} he={he} /> },
    { i: 3, panel: <HitlPanel he={he} /> },
    { i: 4, panel: <IntelPanel lp={clamp(pos - 4)} he={he} /> },
    { i: 5, panel: <CopilotPanel lp={clamp(pos - 5)} he={he} /> },
  ];
  const convoOpacity = clamp(Math.min((pos - 0.68) / 0.3, (6.32 - pos) / 0.3));

  const standalone: { i: number; el: ReactNode }[] = [
    { i: 0, el: <Shot2 lp={clamp(pos)} isRtl={isRtl} /> },
    { i: 6, el: <Shot7 lp={clamp(pos - 6)} isRtl={isRtl} /> },
    { i: 7, el: <Shot8 lp={clamp(pos - 7)} isRtl={isRtl} /> },
  ];

  return (
    <section ref={sectionRef} id="how-it-works" className="relative" style={{ minHeight: "1760vh" }}>
      <div className="sticky top-0 h-screen flex flex-col overflow-hidden">
        <div className="absolute inset-0" style={{ background: "linear-gradient(to top right,#cdd9ff 0%,#e6ecff 38%,#f5f8ff 68%,#ffffff 100%)" }} />
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -bottom-40 -left-24 w-[680px] h-[680px] rounded-full opacity-50" style={{ background: "radial-gradient(circle,#aec4ff,transparent 62%)", filter: "blur(110px)" }} />
          <div className="absolute -top-28 right-[8%] w-[540px] h-[540px] rounded-full opacity-40" style={{ background: "radial-gradient(circle,#d2c6ff,transparent 62%)", filter: "blur(120px)" }} />
        </div>
        <div className="pointer-events-none absolute inset-0 mix-blend-overlay" style={{ opacity: 0.22, backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")" }} />

        <div dir={isRtl ? "rtl" : "ltr"} className="relative z-10 flex-1 flex flex-col w-full max-w-[1000px] mx-auto px-4 sm:px-8 pt-[clamp(6rem,14vh,9rem)] pb-6">
          {/* ── narration ── */}
          <p className="text-center text-[11px] font-medium text-primary-600 uppercase tracking-[0.22em]">{t("landing.story.label")}</p>
          <h3 className="text-center text-[clamp(1.45rem,3.6vw,2.4rem)] font-semibold tracking-[-0.03em] leading-[1.12] text-gray-900 mt-2.5">
            {t("landing.story.headline")}
            {(shot === 4 || shot === 5) && <span key="agent" className="landing-fade-in text-primary-600"> {t("landing.story.headlineAgent")}</span>}
          </h3>
          <div className="mt-4 mb-2 h-[52px] sm:h-[46px] text-center max-w-[640px] mx-auto">
            <p key={`t${shot}`} className="landing-fade-in text-[15px] sm:text-[17px] font-semibold text-gray-900">{title}</p>
            <p key={`s${shot}`} className="landing-fade-in text-[12.5px] sm:text-[13.5px] text-gray-500 mt-0.5">{sub}</p>
          </div>

          {/* ── stage ── */}
          <div className="relative flex-1 min-h-0">
            {/* persistent conversation arc (shots 2–6) */}
            <div className="absolute inset-0 flex items-center justify-center transition-[opacity] duration-200" style={{ opacity: convoOpacity, pointerEvents: convoOpacity > 0.5 ? "auto" : "none" }}>
              <div className="flex items-stretch justify-center gap-3">
                <ChatWindow pos={pos} he={he} />
                <div className="relative hidden sm:block w-[244px]">
                  {arc.map(({ i, panel }) => {
                    const o = clamp((0.58 - Math.abs(pos - (i + 0.5))) / 0.16);
                    return o > 0.02 ? (
                      <div key={i} className="absolute inset-0 flex items-center justify-center" style={{ opacity: o, transform: `translateY(${(1 - o) * 8}px)`, pointerEvents: o > 0.5 ? "auto" : "none" }}>{panel}</div>
                    ) : null;
                  })}
                </div>
              </div>
            </div>

            {/* standalone full-stage scenes */}
            {standalone.map(({ i, el }) => (
              <div key={i} className="absolute inset-0 flex items-center justify-center transition-[opacity] duration-200" style={shotStyle(i)}>{el}</div>
            ))}
          </div>

          {/* ── progress rail ── */}
          <div className="mt-4 flex items-center justify-center gap-1.5" aria-hidden>
            {Array.from({ length: SHOTS }).map((_, i) => (
              <span key={i} className="h-1.5 rounded-full overflow-hidden bg-gray-300/60" style={{ width: i === shot ? 30 : 14 }}>
                <span className="block h-full bg-primary-500 rounded-full transition-all duration-150" style={{ width: i < shot ? "100%" : i === shot ? `${local * 100}%` : "0%" }} />
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ──────────────────────────  shared primitives  ────────────────────────── */

type ShotProps = { lp: number; isRtl: boolean };

function Reveal({ lp, at, children, className = "", from = 12 }: { lp: number; at: number; children: ReactNode; className?: string; from?: number }) {
  const o = clamp((playProgress(lp) - at) / 0.14);
  return <div className={className} style={{ opacity: o, transform: `translateY(${(1 - o) * from}px)` }}>{children}</div>;
}

function Row({ children, side = "out" }: { children: ReactNode; side?: "in" | "out" }) {
  return <div className={`flex flex-col gap-1 landing-fade-in ${side === "out" ? "items-end" : "items-start"}`}>{children}</div>;
}

// RTL-aware bubble tail: the small corner sits on the speaker's side.
function Bubble({ children, side = "in", he = false }: { children: ReactNode; side?: "in" | "out"; he?: boolean }) {
  const out = side === "out";
  const tail = out ? (he ? "rounded-bl-sm" : "rounded-br-sm") : (he ? "rounded-br-sm" : "rounded-bl-sm");
  return (
    <div className={`max-w-[84%] px-3 py-2 text-[12.5px] leading-snug shadow-sm rounded-2xl ${tail} ${out ? "bg-primary-500 text-white" : "bg-white border border-gray-100 text-gray-700"}`}>{children}</div>
  );
}

function HighlightBubble({ children, he = false }: { children: ReactNode; he?: boolean }) {
  return (
    <div className="relative max-w-[88%]">
      <span className={`absolute -top-2 ${he ? "-left-1" : "-right-1"} z-10 whitespace-nowrap rounded-full bg-amber-400 px-1.5 py-[1px] text-[8.5px] font-bold text-white shadow`}>{he ? "⚡ פעולת AI" : "⚡ AI action"}</span>
      <div className={`rounded-2xl ${he ? "rounded-bl-sm" : "rounded-br-sm"} bg-primary-500 px-3 py-2 text-[12.5px] leading-snug text-white ring-2 ring-primary-300 shadow-[0_0_22px_rgba(124,92,252,0.5)]`}>{children}</div>
    </div>
  );
}

function Chip({ children, tone = "emerald" }: { children: ReactNode; tone?: "emerald" | "primary" | "amber" }) {
  const map = {
    emerald: "text-emerald-600 bg-emerald-50 border-emerald-200",
    primary: "text-primary-600 bg-primary-50 border-primary-200",
    amber: "text-amber-600 bg-amber-50 border-amber-200",
  } as const;
  return <span className={`inline-flex items-center gap-1 text-[10.5px] font-medium border rounded-full px-2 py-0.5 ${map[tone]}`}>{children}</span>;
}

function Check({ className = "w-3 h-3" }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>;
}

function TickRow({ lp, at, icon, label, sub }: { lp: number; at: number; icon?: ReactNode; label: string; sub: string }) {
  const pp = playProgress(lp);
  const done = pp > at;
  return (
    <div className="flex items-start gap-2.5 rounded-xl border p-2.5 transition-all duration-300" style={{ opacity: clamp((pp - at + 0.1) / 0.16), transform: `translateY(${(1 - clamp((pp - at + 0.1) / 0.16)) * 8}px)`, borderColor: done ? "rgb(243 244 246)" : "transparent", background: done ? "rgba(249,250,251,0.7)" : "transparent" }}>
      <span className="w-5 h-5 mt-0.5 rounded-full bg-green-500 text-white flex items-center justify-center shrink-0">{icon ?? <Check className="w-2.5 h-2.5" />}</span>
      <div><p className="text-[12px] font-semibold text-gray-800 leading-tight">{label}</p><p className="text-[10.5px] text-gray-400 mt-0.5">{sub}</p></div>
    </div>
  );
}

function IntelRow({ k, v, tone }: { k: string; v: string; tone?: "warn" }) {
  return <div className="flex items-center justify-between py-1 border-t border-gray-50"><span className="text-[11px] text-gray-400">{k}</span><span className={`text-[11px] font-semibold ${tone === "warn" ? "text-amber-500" : "text-gray-700"}`}>{v}</span></div>;
}

function Avatar({ size = "w-9 h-9", text = "text-sm", he = false }: { size?: string; text?: string; he?: boolean }) {
  return <div className={`${size} ${text} rounded-full bg-gradient-to-br from-rose-400 to-pink-500 text-white font-bold flex items-center justify-center shrink-0`}>{he ? "ד" : "D"}</div>;
}

function LevelRow({ label, desc, tag, active }: { label: string; desc: string; tag?: string; active?: boolean }) {
  return (
    <div className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 border ${active ? "border-primary-300 bg-primary-50" : "border-gray-100 bg-gray-50/60"}`}>
      <span className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center shrink-0 ${active ? "border-primary-500" : "border-gray-300"}`}>
        {active && <span className="w-1.5 h-1.5 rounded-full bg-primary-500" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className={`text-[11.5px] font-semibold leading-tight ${active ? "text-primary-700" : "text-gray-700"}`}>{label}</p>
        <p className="text-[10px] text-gray-400 leading-tight">{desc}</p>
      </div>
      {tag && <span className="text-[8.5px] font-bold text-amber-600 bg-amber-50 border border-amber-200 rounded px-1 py-[1px] shrink-0">{tag}</span>}
    </div>
  );
}

/* ──────────────────  the persistent conversation window  ────────────────── */

function ChatWindow({ pos, he }: { pos: number; he: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const msgs = CHAT.filter((m) => pos >= m.at);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [msgs.length]);
  const agent = pos >= 4.15; // handed off to a human agent (shots 5–6)

  const name = agent ? (he ? "מאיה · נציגת שירות" : "Maya · Support agent") : (he ? "עובד AI" : "AI Employee");
  const status = agent ? (he ? "Co-Pilot פעיל · #4812" : "Co-Pilot active · #4812") : (he ? "טיפול אוטומטי · אינסטגרם · #4812" : "Auto-handling · Instagram · #4812");

  return (
    <div className="w-[300px] sm:w-[324px] rounded-[14px] bg-white border border-gray-200 shadow-[0_26px_64px_-28px_rgba(30,30,60,0.4)] overflow-hidden flex flex-col">
      <div className="flex items-center gap-2.5 px-4 py-3 bg-white border-b border-gray-100">
        {agent
          ? <div className="w-9 h-9 rounded-full bg-gradient-to-br from-indigo-400 to-primary-500 text-white text-[12px] font-bold flex items-center justify-center shrink-0">{he ? "מ" : "M"}</div>
          : <div className="w-9 h-9 rounded-full bg-primary-100 text-primary-600 text-[11px] font-bold flex items-center justify-center shrink-0">AI</div>}
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold leading-tight truncate text-gray-900">{name}</p>
          <p className="text-[10.5px] text-gray-400 flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />{status}</p>
        </div>
        {agent
          ? <span className="text-[8.5px] font-bold text-primary-600 bg-primary-50 border border-primary-200 rounded-full px-1.5 py-0.5 shrink-0">⚡ Co-Pilot</span>
          : <span className="text-[16px] leading-none text-gray-300">⋯</span>}
      </div>

      <div ref={scrollRef} className="h-[336px] overflow-hidden px-3.5 py-3.5 space-y-2 bg-white">
        {msgs.map((m, i) => {
          const node = he ? m.he : m.en;
          const chip = he ? m.chipHe : m.chipEn;
          return (
            <Row key={i} side={m.side}>
              {chip ? <Chip>{chip}</Chip> : m.highlight ? <HighlightBubble he={he}>{node}</HighlightBubble> : <Bubble side={m.side} he={he}>{node}</Bubble>}
              {m.copilot && <span className="text-[9px] font-semibold text-primary-500">{he ? "⚡ דרך Co-Pilot" : "⚡ via Co-Pilot"}</span>}
            </Row>
          );
        })}
      </div>
    </div>
  );
}

/* ──────────────────────  side panels for the arc scenes  ────────────────── */

function LeadCard({ he }: { he: boolean }) {
  const fields: [string, string, string][] = he
    ? [["שם", "דנה לוי", "0.30"], ["ערוץ", "אינסטגרם DM", "0.40"], ["מקור", "בעיה בהזמנה", "0.50"]]
    : [["Name", "Dana Levi", "0.30"], ["Channel", "Instagram DM", "0.40"], ["Source", "Order issue", "0.50"]];
  return (
    <div className="story-card-pop relative w-[234px] rounded-2xl bg-white border border-gray-200 shadow-[0_28px_70px_-28px_rgba(80,40,180,0.5)] p-4 overflow-hidden">
      <span className="story-shimmer pointer-events-none absolute inset-y-0 -left-1/3 w-1/3 bg-gradient-to-r from-transparent via-white/75 to-transparent" />
      <span className="story-ring pointer-events-none absolute inset-0 rounded-2xl" />

      <div className="flex items-center gap-2 mb-3">
        <span className="ea-pop-in w-7 h-7 rounded-full bg-green-500 text-white flex items-center justify-center shadow-[0_6px_16px_rgba(34,197,94,0.5)]">
          <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="3"><path className="ea-check-draw" strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
        </span>
        <div><p className="text-[12.5px] font-bold text-gray-900 leading-tight">{he ? "נוצר ליד חדש" : "New lead created"}</p><p className="text-[10px] text-gray-400">{he ? "נשמר ל-CRM שלך" : "Captured into your CRM"}</p></div>
      </div>

      <div className="story-row-in flex items-center gap-2.5 rounded-xl bg-gray-50 border border-gray-100 p-2.5" style={{ animationDelay: "0.18s" }}>
        <Avatar he={he} />
        <div><p className="text-[12.5px] font-semibold text-gray-900 leading-tight">{he ? "דנה לוי" : "Dana Levi"}</p><p className="text-[10.5px] text-gray-400">@dana.levi · {he ? "אינסטגרם" : "Instagram"}</p></div>
      </div>

      <div className="mt-2.5 space-y-1.5">
        {fields.map(([k, v, d]) => (
          <div key={k} className="story-row-in flex items-center gap-1.5 text-[11px]" style={{ animationDelay: `${d}s` }}>
            <span className="w-3.5 h-3.5 rounded-full bg-green-100 text-green-600 flex items-center justify-center shrink-0"><Check className="w-2 h-2" /></span>
            <span className="text-gray-400">{k}</span>
            <span className="ms-auto font-medium text-gray-700">{v}</span>
          </div>
        ))}
      </div>

      <div className="story-row-in mt-3 flex flex-wrap gap-1" style={{ animationDelay: "0.6s" }}>
        <Chip tone="primary">{he ? "נוצר אוטומטית" : "Auto-created"}</Chip><Chip tone="amber">{he ? "זוהה VIP" : "VIP detected"}</Chip>
      </div>
    </div>
  );
}

function IntentPanel({ lp, he }: { lp: number; he: boolean }) {
  return (
    <div className="w-[224px] rounded-2xl bg-white border border-gray-200 shadow-[0_24px_60px_-28px_rgba(0,0,0,0.45)] p-3.5">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-primary-500 mb-2.5 flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-primary-500 animate-pulse" />{he ? "ניתוח AI" : "AI analysis"}</p>
      <div className="space-y-2">
        <Reveal lp={lp} at={0.2}><div className="flex items-center justify-between"><span className="text-[11px] text-gray-400">{he ? "כוונה" : "Intent"}</span><Chip tone="primary">{he ? "פריט שגוי · החלפה" : "Wrong item · Exchange"}</Chip></div></Reveal>
        <Reveal lp={lp} at={0.4}><div className="flex items-center justify-between"><span className="text-[11px] text-gray-400">{he ? "סנטימנט" : "Sentiment"}</span><Chip tone="amber">{he ? "מתוסכלת 😕" : "Frustrated 😕"}</Chip></div></Reveal>
        <Reveal lp={lp} at={0.6}><div className="flex items-center justify-between"><span className="text-[11px] text-gray-400">{he ? "עדיפות" : "Priority"}</span><Chip tone="amber">{he ? "גבוהה" : "High"}</Chip></div></Reveal>
      </div>
    </div>
  );
}

function HitlPanel({ he }: { he: boolean }) {
  return (
    <div className="w-[234px] rounded-2xl bg-white border border-gray-200 shadow-[0_24px_60px_-28px_rgba(124,92,252,0.5)] p-4">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-primary-500 mb-1.5">{he ? "השליטה בידיים שלך" : "You're in control"}</p>
      <p className="text-[13px] font-semibold text-gray-900 leading-snug mb-3">{he ? "אתם קובעים את רמת האוטונומיה" : "You decide the autonomy level"}</p>
      <div className="space-y-1.5">
        <LevelRow label={he ? "הצעה בלבד" : "Suggest only"} desc={he ? "ה-AI מנסח · אתם שולחים" : "AI drafts · you send"} />
        <LevelRow label={he ? "שאל אותי קודם" : "Ask me first"} desc={he ? "אדם בלולאה" : "Human-in-the-loop"} tag="HITL" />
        <LevelRow label={he ? "אוטונומי מלא" : "Fully autonomous"} desc={he ? "ה-AI פועל לבד" : "AI acts on its own"} active />
      </div>
      <p className="mt-3 text-[11px] text-gray-400 leading-snug">{he ? <>ההחלפה הזו בוצעה <b className="text-gray-600">אוטומטית</b>. אפשר לדרוש אישור לכל פעולה בכל רגע.</> : <>This exchange ran <b className="text-gray-600">automatically</b>. Require approval per-action anytime.</>}</p>
    </div>
  );
}

function IntelPanel({ lp, he }: { lp: number; he: boolean }) {
  return (
    <div className="relative w-[238px] rounded-2xl bg-white border border-primary-300 shadow-[0_0_0_4px_rgba(124,92,252,0.12),0_28px_70px_-28px_rgba(124,92,252,0.6)] p-4">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-primary-500 mb-2.5">{he ? "מודיעין לקוחות" : "Customer Intelligence"}</p>
      <div className="flex items-center gap-2.5 mb-3">
        <Avatar size="w-10 h-10" text="text-base" he={he} />
        <div><p className="text-sm font-semibold text-gray-900 leading-tight">{he ? "דנה לוי" : "Dana Levi"}</p><p className="text-[11px] text-amber-500 font-medium">{he ? "VIP · 7 הזמנות" : "VIP · 7 orders"}</p></div>
      </div>
      <Reveal lp={lp} at={0.3}><IntelRow k={he ? "ערך חיים" : "Lifetime value"} v="$2,480" /></Reveal>
      <Reveal lp={lp} at={0.42}><IntelRow k={he ? "הזמנה אחרונה" : "Last order"} v={he ? "#4812 · לפני 3 ימים" : "#4812 · 3d ago"} /></Reveal>
      <Reveal lp={lp} at={0.54}><IntelRow k={he ? "סנטימנט" : "Sentiment"} v={he ? "מתוסכלת" : "Frustrated"} tone="warn" /></Reveal>
      <Reveal lp={lp} at={0.68}><div className="mt-3 flex flex-wrap gap-1"><Chip tone="primary">{he ? "נאמנה" : "Loyal"}</Chip><Chip tone="primary">{he ? "אופנה" : "Apparel"}</Chip><Chip tone="amber">{he ? "בסיכון" : "At-risk"}</Chip></div></Reveal>
    </div>
  );
}

function ActionRow({ label, delay = "0s" }: { label: string; delay?: string }) {
  return (
    <div className="story-row-in flex items-center gap-1.5 rounded-lg border border-primary-100 bg-white px-2 py-1.5" style={{ animationDelay: delay }}>
      <span className="w-3.5 h-3.5 rounded-[5px] bg-primary-500 text-white flex items-center justify-center shrink-0"><Check className="w-2 h-2" /></span>
      <span className="text-[11px] font-medium text-gray-700">{label}</span>
    </div>
  );
}

function CopilotPanel({ lp, he }: { lp: number; he: boolean }) {
  const thinking = lp < 0.32; // generating / reasoning phase
  const applied = lp > 0.66;
  return (
    <div className="relative w-[244px] rounded-2xl bg-white border border-primary-200 shadow-[0_28px_70px_-28px_rgba(124,92,252,0.55)] p-4 overflow-hidden">
      <span className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-fuchsia-400 via-primary-500 to-indigo-400" />
      <p className="text-[10px] font-bold uppercase tracking-wide text-primary-600 mb-2.5 flex items-center gap-1.5"><span className="text-[12px] leading-none">✨</span> AI Co-Pilot</p>

      {thinking ? (
        <div className="space-y-2.5">
          <div className="flex items-center gap-2 text-[12px] font-medium text-primary-600">
            <span className="flex gap-1">{[0, 1, 2].map((d) => <span key={d} className="w-1.5 h-1.5 rounded-full bg-primary-500 animate-bounce" style={{ animationDelay: `${d * 0.15}s` }} />)}</span>
            {he ? "קורא הקשר ומנסח…" : "Reading context & drafting…"}
          </div>
          {[95, 82, 64].map((w, i) => (
            <div key={i} className="relative h-2.5 rounded bg-primary-100/70 overflow-hidden" style={{ width: `${w}%` }}>
              <span className="story-shimmer absolute inset-y-0 -left-1/3 w-1/2 bg-gradient-to-r from-transparent via-white/85 to-transparent" />
            </div>
          ))}
          <div className="flex flex-wrap gap-1 pt-0.5">
            <Chip tone="primary">{he ? "VIP · ערך $2,480" : "VIP · LTV $2,480"}</Chip><Chip tone="amber">{he ? "מתוסכלת" : "Frustrated"}</Chip>
          </div>
        </div>
      ) : (
        <div className="landing-fade-in space-y-2.5">
          <div>
            <p className="text-[9px] uppercase tracking-wide text-gray-400 mb-1">{he ? "תשובה מוצעת · מוכנה" : "Suggested reply · ready"}</p>
            <div className={`rounded-xl ${he ? "rounded-br-sm" : "rounded-bl-sm"} border border-primary-200 bg-primary-50/70 p-2.5 text-[12px] leading-snug text-gray-700`}>
              {he ? <>״בטח! שיניתי למידה <b>M</b> ושמרתי על ההחלפה חינם — בנוסף קופון נאמנות <b>10%</b> על הבלבול. 💜״</> : <>"Of course! I've set it to size <b>M</b> and kept your free exchange — plus a <b>10% loyalty</b> coupon for the mix-up. 💜"</>}
            </div>
          </div>
          <div>
            <p className="text-[9px] uppercase tracking-wide text-gray-400 mb-1">{he ? "פעולות בתור" : "Actions queued"}</p>
            <div className="space-y-1">
              <ActionRow label={he ? "עדכון מידה ← M" : "Update size → M"} delay="0.04s" />
              <ActionRow label={he ? "החלת קופון נאמנות 10%" : "Apply 10% loyalty coupon"} delay="0.12s" />
              <ActionRow label={he ? "תיעוד הפתרון ב-CRM" : "Log resolution to CRM"} delay="0.2s" />
            </div>
          </div>
          <button type="button" className={`w-full py-2 rounded-lg text-[12px] font-semibold transition-all duration-300 ${applied ? "bg-green-500 text-white" : "bg-primary-600 text-white"}`}>
            {applied ? (he ? "✓ נשלח · 3 פעולות בוצעו" : "✓ Sent · 3 actions applied") : (he ? "אשר ושלח" : "Approve & send")}
          </button>
        </div>
      )}
    </div>
  );
}

/* ────────────────────────  standalone full-stage shots  ──────────────────── */

/* Shot 1 (story position 1) — everything in one place (omnichannel) */
function Shot2({ lp, isRtl }: ShotProps) {
  const he = isRtl;
  const channels = [
    { name: he ? "אינסטגרם" : "Instagram", logo: "/icons/ins.png" },
    { name: he ? "וואטסאפ" : "WhatsApp", logo: "/icons/wa.png" },
    { name: he ? "מסנג׳ר" : "Messenger", logo: "/icons/msn.png" },
    { name: "Gmail", logo: "/icons/gm.png" },
    { name: he ? "שיחות טלפון" : "Phone Calls", logo: "/icons/twilio.svg" },
    { name: "Slack", logo: "/icons/slk.png" },
  ];
  const convos = he
    ? [
        { who: "דנה לוי", msg: "הזמינה כחול, קיבלה אפור 😕", logo: "/icons/ins.png", n: "2 דק׳" },
        { who: "יוסי כ.", msg: "איפה ההזמנה שלי?", logo: "/icons/wa.png", n: "5 דק׳" },
        { who: "+972 54-…", msg: "שיחה שלא נענתה · לחזור", logo: "/icons/twilio.svg", n: "8 דק׳" },
        { who: "רחל ב.", msg: "שאלה על חשבונית", logo: "/icons/gm.png", n: "12 דק׳" },
      ]
    : [
        { who: "Dana Levi", msg: "Ordered blue, received grey 😕", logo: "/icons/ins.png", n: "2m" },
        { who: "Yossi K.", msg: "Where's my order?", logo: "/icons/wa.png", n: "5m" },
        { who: "+972 54-…", msg: "Missed call · callback", logo: "/icons/twilio.svg", n: "8m" },
        { who: "Rachel B.", msg: "Invoice question", logo: "/icons/gm.png", n: "12m" },
      ];
  return (
    <div className="flex items-center justify-center gap-4 sm:gap-7">
      <div className="hidden sm:flex flex-col gap-2">
        {channels.map((c, i) => (
          <Reveal key={c.name} lp={lp} at={0.05 + i * 0.05} from={10}>
            <div className="flex items-center gap-2 rounded-full bg-white/85 border border-gray-200/70 shadow-sm ps-1.5 pe-3 py-1.5">
              <span className="w-6 h-6 rounded-full bg-white border border-gray-100 flex items-center justify-center"><img src={c.logo} alt="" className="w-3.5 h-3.5 object-contain" /></span>
              <span className="text-[11px] text-gray-600">{c.name}</span>
            </div>
          </Reveal>
        ))}
      </div>

      <Reveal lp={lp} at={0.35} from={0} className="text-primary-400/70">
        <svg className="w-7 h-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" style={{ transform: he ? "scaleX(-1)" : undefined }}><path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M13 6l6 6-6 6" /></svg>
      </Reveal>

      <Reveal lp={lp} at={0.3} from={18}>
        <div className="w-[320px] rounded-2xl bg-white border border-gray-200/70 shadow-[0_30px_80px_-30px_rgba(80,40,180,0.5)] overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
            <p className="text-[13px] font-semibold text-gray-900">{he ? "תיבה מאוחדת" : "Unified Inbox"}</p>
            <span className="text-[10px] font-medium text-primary-600 bg-primary-50 rounded-full px-2 py-0.5">{he ? "כל הערוצים" : "All channels"}</span>
          </div>
          <div className="divide-y divide-gray-50">
            {convos.map((c, i) => (
              <Reveal key={c.who} lp={lp} at={0.45 + i * 0.1} from={8}>
                <div className="flex items-center gap-2.5 px-3.5 py-2.5">
                  <span className="relative w-8 h-8 rounded-full bg-gray-50 border border-gray-100 flex items-center justify-center shrink-0">
                    <img src={c.logo} alt="" className="w-4 h-4 object-contain" />
                  </span>
                  <div className="min-w-0 flex-1"><p className="text-[12.5px] font-semibold text-gray-800 leading-tight truncate">{c.who}</p><p className="text-[11px] text-gray-400 truncate">{c.msg}</p></div>
                  <span className="text-[10px] text-gray-300">{c.n}</span>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </Reveal>
    </div>
  );
}

/* Shot 7 — AI Call-Pilot, live */
function Shot7({ lp, isRtl }: ShotProps) {
  const he = isRtl;
  const lines = he
    ? [
        { who: "לקוחה", txt: "…ואשמח לקבל את זה לפני סוף השבוע אם אפשר." },
        { who: "נציגה", txt: "בהחלט — בודקת אפשרויות משלוח עבורך." },
      ]
    : [
        { who: "Customer", txt: "…and I'd like it before the weekend if possible." },
        { who: "Agent", txt: "Absolutely — let me check delivery options for you." },
      ];
  return (
    <div className="flex items-stretch justify-center gap-3">
      <div className="w-[300px] rounded-2xl bg-gray-900 text-white shadow-[0_30px_80px_-28px_rgba(0,0,0,0.7)] overflow-hidden">
        <div className="px-4 py-4 flex items-center gap-3 border-b border-white/10">
          <Avatar size="w-11 h-11" text="text-base" he={he} />
          <div className="flex-1"><p className="text-sm font-semibold leading-tight">{he ? "דנה לוי" : "Dana Levi"}</p><p className="text-[11px] text-green-300 flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />{he ? "שיחה חיה · 02:14" : "Live call · 02:14"}</p></div>
          <span className="w-9 h-9 rounded-full bg-red-500 flex items-center justify-center"><svg className="w-4 h-4 rotate-[135deg]" viewBox="0 0 24 24" fill="currentColor"><path d="M6.6 10.8a15.9 15.9 0 006.6 6.6l2.2-2.2a1 1 0 011-.24 11.4 11.4 0 003.6.6 1 1 0 011 1V20a1 1 0 01-1 1A17 17 0 013 4a1 1 0 011-1h3.5a1 1 0 011 1 11.4 11.4 0 00.6 3.6 1 1 0 01-.24 1l-2.26 2.2z" /></svg></span>
        </div>
        <div className="px-4 py-3 flex items-center justify-center gap-1 h-14">
          {Array.from({ length: 22 }).map((_, i) => (
            <span key={i} className="w-1 rounded-full bg-primary-400/80 animate-pulse" style={{ height: `${20 + Math.abs(Math.sin(i * 1.3)) * 70}%`, animationDelay: `${i * 0.06}s`, animationDuration: "0.9s" }} />
          ))}
        </div>
        <div className="px-4 pb-4 space-y-1.5">
          <p className="text-[9px] uppercase tracking-wide text-white/40">{he ? "תמלול חי" : "Live transcript"}</p>
          {lines.map((l, i) => (
            <Reveal key={i} lp={lp} at={0.15 + i * 0.2} from={6}>
              <p className="text-[11.5px] text-white/85"><span className="text-white/40">{l.who}: </span>{l.txt}</p>
            </Reveal>
          ))}
        </div>
      </div>

      <Reveal lp={lp} at={0.4} from={16} className="hidden sm:block">
        <div className="w-[210px] rounded-2xl bg-white border border-gray-200/70 shadow-[0_24px_60px_-28px_rgba(124,92,252,0.5)] p-3.5">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-primary-600 mb-2.5">⚡ Call-Pilot</p>
          <div className="space-y-2">
            <Reveal lp={lp} at={0.5}><div className="rounded-lg bg-primary-50/70 border border-primary-100 p-2 text-[11.5px] text-gray-700">{he ? <>הצע משלוח ל<b>יום ה׳</b> — במלאי בחנות שלה.</> : <>Offer <b>Thu delivery</b> — in stock at her store.</>}</div></Reveal>
            <Reveal lp={lp} at={0.65}><div className="rounded-lg bg-primary-50/70 border border-primary-100 p-2 text-[11.5px] text-gray-700">{he ? <>הזכר את הטבת ה-<b>VIP</b> שלה.</> : <>Mention her <b>VIP loyalty</b> perk.</>}</div></Reveal>
            <Reveal lp={lp} at={0.8}><div className="flex items-center gap-1.5 text-[11px] text-emerald-600 font-medium"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />{he ? "סנטימנט: מתחמם" : "Sentiment: warming up"}</div></Reveal>
          </div>
        </div>
      </Reveal>
    </div>
  );
}

/* Shot 8 — seamless back office */
function Shot8({ lp, isRtl }: ShotProps) {
  const he = isRtl;
  return (
    <Reveal lp={lp} at={0.05} from={12}>
      <div className="w-[330px] rounded-2xl bg-white border border-gray-200/70 shadow-[0_30px_80px_-28px_rgba(0,0,0,0.5)] p-4">
        <div className="flex items-center gap-2 mb-3">
          <span className="w-6 h-6 rounded-full bg-green-500 text-white flex items-center justify-center"><Check className="w-3.5 h-3.5" /></span>
          <p className="text-[13px] font-semibold text-gray-900">{he ? "השיחה נסגרה — אוטומטית" : "Conversation wrapped — automatically"}</p>
        </div>
        <div className="space-y-2">
          <TickRow lp={lp} at={0.18} label={he ? "סיכום נשמר ב-CRM" : "Summary stored in CRM"} sub={he ? "החלפה · חולצה כחולה · נפתר ע״י AI" : "Exchange · blue shirt · resolved by AI"} />
          <TickRow lp={lp} at={0.36} label={he ? "מודיעין הלקוח הועשר" : "Customer intelligence enriched"} sub={he ? "ערך חיים עודכן · תויג VIP · סנטימנט תועד" : "LTV updated · tagged VIP · sentiment logged"} />
          <TickRow lp={lp} at={0.54} label={he ? "נוצרה משימה" : "Task created"} sub={he ? "שליחת החלפה · הוקצה ללוגיסטיקה" : "Ship exchange · assigned to fulfilment"} />
          <TickRow lp={lp} at={0.72} label={he ? "תוזמן מעקב" : "Follow-up scheduled"} sub={he ? "בדיקה אחרי 7 ימים · תזכורת אוטומטית" : "7-day check-in · auto-reminder"} />
        </div>
        <Reveal lp={lp} at={0.88} className="mt-3 flex flex-wrap gap-1">
          <Chip>{he ? "סונכרן · CRM" : "Synced · CRM"}</Chip><Chip>{he ? "סונכרן · ERP" : "Synced · ERP"}</Chip><Chip tone="primary">{he ? "Shopify עודכן" : "Shopify updated"}</Chip>
        </Reveal>
      </div>
    </Reveal>
  );
}

export default memo(CustomerStorySection);
