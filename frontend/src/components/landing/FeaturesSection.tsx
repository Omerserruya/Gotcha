"use client";

import { useState, useCallback } from "react";

const CARDS = ["aiEmployee", "copilot", "intelligence", "omnichannel"] as const;
type Card = (typeof CARDS)[number];

/* ───── Card config ───── */
const CARD_CONFIG: Record<Card, { icon: JSX.Element; accentBg: string; accentBorder: string; accentText: string; glowColor: string }> = {
  aiEmployee: {
    // lightning bolt - it doesn't just chat, it acts
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
    accentBg: "bg-violet-50",
    accentBorder: "border-violet-200",
    accentText: "text-violet-600",
    glowColor: "shadow-violet-500/20",
  },
  copilot: {
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09Z" />
        <path d="M18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 0 0-2.455 2.456Z" />
      </svg>
    ),
    accentBg: "bg-indigo-50",
    accentBorder: "border-indigo-200",
    accentText: "text-indigo-600",
    glowColor: "shadow-indigo-500/20",
  },
  intelligence: {
    // customer profile - the full 360 picture
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M17.982 18.725A7.488 7.488 0 0 0 12 15.75a7.488 7.488 0 0 0-5.982 2.975m11.963 0a9 9 0 1 0-11.963 0m11.963 0A8.966 8.966 0 0 1 12 21a8.966 8.966 0 0 1-5.982-2.275M15 9.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
    accentBg: "bg-amber-50",
    accentBorder: "border-amber-200",
    accentText: "text-amber-600",
    glowColor: "shadow-amber-500/20",
  },
  omnichannel: {
    // squares - every channel, one place
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25A2.25 2.25 0 0 1 13.5 18v-2.25Z" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
    accentBg: "bg-emerald-50",
    accentBorder: "border-emerald-200",
    accentText: "text-emerald-600",
    glowColor: "shadow-emerald-500/20",
  },
};

/* ───── Main Section ───── */

export default function FeaturesSection({
  t,
  isRtl = false,
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

        {/* Cards - fixed height from the start; the active card grows ONLY sideways. */}
        <div
          className="flex flex-col lg:flex-row gap-3 sm:gap-4 lg:h-[300px]"
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
                  relative bg-white rounded-2xl border cursor-pointer overflow-hidden lg:h-full
                  ${isActive
                    ? `${config.accentBorder} shadow-lg ${config.glowColor} z-10`
                    : hasActive
                      ? "border-gray-100/60 shadow-sm opacity-65"
                      : "border-gray-100 shadow-sm hover:shadow-md hover:border-gray-200"
                  }
                `}
                style={{
                  flex: isActive ? "2.4 1 0%" : hasActive ? "0.6 1 0%" : "1 1 0%",
                  transition: "flex 320ms cubic-bezier(0.4,0,0.2,1), opacity 320ms ease-out, box-shadow 320ms ease-out, border-color 320ms ease-out",
                }}
              >
                {/* Row on desktop so expansion is purely horizontal; height never changes. */}
                <div className="flex h-full flex-col lg:flex-row">
                  {/* Compact side - icon, title, hint (always visible, vertically centred) */}
                  <div className={`p-5 sm:p-6 flex flex-col justify-center lg:h-full ${isActive ? "lg:w-[44%] lg:flex-shrink-0 lg:border-e " + config.accentBorder : ""}`}>
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

                  {/* Expanded side - description + bullets (only when active, slides in from the side) */}
                  {isActive && (
                    <div className="flex-1 min-w-0 p-5 sm:p-6 flex flex-col justify-center overflow-hidden animate-[featureExpandIn_0.32s_ease-out]">
                      <p className="text-[12px] sm:text-[13px] text-[#6a6a6a] leading-[1.65] mb-3.5">
                        {t(`landing.productFeatures.cards.${card}.desc`)}
                      </p>
                      <ul className="space-y-2">
                        {Array.isArray(bullets) && bullets.map((b, i) => (
                          <li
                            key={i}
                            className="flex items-start gap-2 text-[12px] sm:text-[13px] text-gray-600"
                            style={{ animation: `featureExpandIn 250ms ease-out ${80 + i * 60}ms both` }}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className={`${config.accentText} flex-shrink-0 mt-0.5`}>
                              <path d="M4.5 12.75l6 6 9-13.5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                            {b}
                          </li>
                        ))}
                      </ul>
                      <div className={`mt-3.5 flex items-center gap-1.5 ${config.accentText}`}>
                        <div className="w-1.5 h-1.5 rounded-full bg-current animate-pulse opacity-40" />
                        <span className="text-[10px] font-medium opacity-50">{isRtl ? "מבוסס AI" : "AI-powered"}</span>
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
          from { opacity: 0; transform: translateX(-10px); }
          to { opacity: 1; transform: translateX(0); }
        }
      `}</style>
    </section>
  );
}
