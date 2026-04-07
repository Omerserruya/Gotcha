"use client";

import { useState, useCallback } from "react";

const CARDS = ["copilot", "inbox", "insights", "knowledge"] as const;
type Card = (typeof CARDS)[number];

/* ───── Card config ───── */
const CARD_CONFIG: Record<Card, { icon: JSX.Element; accentBg: string; accentBorder: string; accentText: string; glowColor: string }> = {
  copilot: {
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09Z" />
        <path d="M18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 0 0-2.455 2.456Z" />
      </svg>
    ),
    accentBg: "bg-violet-50",
    accentBorder: "border-violet-200",
    accentText: "text-violet-600",
    glowColor: "shadow-violet-500/20",
  },
  inbox: {
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M2.25 13.5h3.86a2.25 2.25 0 0 1 2.012 1.244l.256.512a2.25 2.25 0 0 0 2.013 1.244h2.21a2.25 2.25 0 0 0 2.013-1.244l.256-.512a2.25 2.25 0 0 1 2.013-1.244h3.859M12 3v8.25m0 0-3-3m3 3 3-3" />
      </svg>
    ),
    accentBg: "bg-blue-50",
    accentBorder: "border-blue-200",
    accentText: "text-blue-600",
    glowColor: "shadow-blue-500/20",
  },
  insights: {
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z" />
      </svg>
    ),
    accentBg: "bg-amber-50",
    accentBorder: "border-amber-200",
    accentText: "text-amber-600",
    glowColor: "shadow-amber-500/20",
  },
  knowledge: {
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25" />
      </svg>
    ),
    accentBg: "bg-rose-50",
    accentBorder: "border-rose-200",
    accentText: "text-rose-600",
    glowColor: "shadow-rose-500/20",
  },
};

/* ───── Main Section ───── */

export default function FeaturesSection({
  t,
}: {
  t: (key: string) => string;
  isRtl?: boolean;
}) {
  const [active, setActive] = useState<Card | null>(null);
  const handleEnter = useCallback((card: Card) => setActive(card), []);
  const handleLeave = useCallback(() => setActive(null), []);
  const handleTap = useCallback((card: Card) => {
    setActive((prev) => (prev === card ? null : card));
  }, []);

  return (
    <section id="product-features" className="py-20 sm:py-36 px-4 sm:px-12 lg:px-20 bg-gradient-to-b from-[#fafafa] to-white">
      <div className="max-w-[1240px] mx-auto">
        {/* Header */}
        <div className="text-center max-w-2xl mx-auto mb-12 sm:mb-16">
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

        {/* Cards — horizontal expand on hover */}
        {/* Mobile: vertical stack. Desktop: flex row where active card grows wider */}
        <div
          className="flex flex-col lg:flex-row gap-3 sm:gap-4"
          onMouseLeave={handleLeave}
        >
          {CARDS.map((card) => {
            const config = CARD_CONFIG[card];
            const isActive = active === card;
            const hasActive = active !== null;
            const bullets = t(`landing.productFeatures.cards.${card}.bullets`) as unknown as string[];

            return (
              <div
                key={card}
                onMouseEnter={() => handleEnter(card)}
                onClick={() => handleTap(card)}
                className={`
                  relative bg-white rounded-2xl border cursor-pointer overflow-hidden
                  transition-all duration-300 ease-out
                  ${isActive
                    ? `${config.accentBorder} shadow-lg ${config.glowColor} z-10`
                    : hasActive
                      ? "border-gray-100/60 shadow-sm opacity-65"
                      : "border-gray-100 shadow-sm hover:shadow-md hover:border-gray-200"
                  }
                `}
                style={{
                  flex: isActive ? "2.4 1 0%" : hasActive ? "0.6 1 0%" : "1 1 0%",
                  transition: "flex 300ms ease-out, opacity 300ms ease-out, box-shadow 300ms ease-out, border-color 300ms ease-out",
                }}
              >
                <div className={`flex h-full ${isActive ? "flex-col sm:flex-row" : "flex-col"} transition-all duration-300`}>
                  {/* Compact side — icon, title, hint (always visible) */}
                  <div className={`p-5 sm:p-6 flex flex-col justify-center ${isActive ? "sm:w-[45%] flex-shrink-0 border-b sm:border-b-0 sm:border-e" : ""} ${isActive ? config.accentBorder : ""}`}>
                    <div className={`w-11 h-11 rounded-xl ${config.accentBg} flex items-center justify-center mb-4 transition-transform duration-300 ${isActive ? "scale-110" : ""}`}>
                      <span className={config.accentText}>{config.icon}</span>
                    </div>
                    <h3 className="text-[15px] sm:text-base font-semibold text-gray-900 mb-1.5 tracking-[-0.01em]">
                      {t(`landing.productFeatures.cards.${card}.title`)}
                    </h3>
                    <p className="text-[12px] sm:text-[13px] text-[#9a9a9a] leading-relaxed">
                      {t(`landing.productFeatures.cards.${card}.hint`)}
                    </p>
                  </div>

                  {/* Expanded side — description + bullets (only when active) */}
                  {isActive && (
                    <div className="flex-1 p-5 sm:p-6 flex flex-col justify-center animate-[featureExpandIn_0.3s_ease-out]">
                      <p className="text-[12px] sm:text-[13px] text-[#6a6a6a] leading-[1.7] mb-4">
                        {t(`landing.productFeatures.cards.${card}.desc`)}
                      </p>
                      <ul className="space-y-2.5">
                        {Array.isArray(bullets) && bullets.map((b, i) => (
                          <li
                            key={i}
                            className="flex items-start gap-2 text-[12px] sm:text-[13px] text-gray-600"
                            style={{
                              opacity: 1,
                              animation: `featureExpandIn 250ms ease-out ${80 + i * 60}ms both`,
                            }}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className={`${config.accentText} flex-shrink-0 mt-0.5`}>
                              <path d="M4.5 12.75l6 6 9-13.5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                            {b}
                          </li>
                        ))}
                      </ul>
                      <div className={`mt-4 flex items-center gap-1.5 ${config.accentText}`}>
                        <div className="w-1.5 h-1.5 rounded-full bg-current animate-pulse opacity-40" />
                        <span className="text-[10px] font-medium opacity-50">AI-powered</span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <style jsx global>{`
        @keyframes featureExpandIn {
          from { opacity: 0; transform: translateX(-8px); }
          to { opacity: 1; transform: translateX(0); }
        }
      `}</style>
    </section>
  );
}
