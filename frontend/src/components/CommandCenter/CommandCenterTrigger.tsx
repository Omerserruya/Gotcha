"use client";

import { useEffect, useState } from "react";
import { useCommandCenter } from "./CommandCenterProvider";
import { useI18n } from "@/context/I18nContext";

/**
 * Persistent desktop trigger pill. Clicking is equivalent to Cmd/Ctrl+K.
 * Rendered only on md: breakpoints and up. Pinned top-center of the
 * viewport (above main content, below the command modal).
 */
export function CommandCenterTrigger() {
  const { open } = useCommandCenter();
  const { t } = useI18n();
  const [isMac, setIsMac] = useState(false);

  useEffect(() => {
    if (typeof navigator !== "undefined") {
      setIsMac(/Mac|iPhone|iPod|iPad/.test(navigator.platform));
    }
  }, []);

  return (
    <button
      type="button"
      onClick={open}
      className="hidden md:flex fixed top-3 left-1/2 -translate-x-1/2 z-[9998] items-center gap-2 px-3 py-1.5 rounded-full bg-white/80 backdrop-blur border border-gray-200 shadow-sm text-gray-500 hover:text-gray-900 hover:border-gray-300 transition"
      aria-label="Open AI Command Center"
    >
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M10 18a8 8 0 100-16 8 8 0 000 16z" />
      </svg>
      <span className="text-xs">{t("commandCenter.triggerLabel")}</span>
      <span className="text-[9px] font-bold uppercase tracking-wide text-violet-600 bg-violet-50 border border-violet-100 rounded-full px-1.5 py-0.5">
        Beta
      </span>
      <kbd className="text-[10px] font-mono bg-gray-100 border border-gray-200 rounded px-1.5 py-0.5">
        {isMac ? "⌘" : "Ctrl"}K
      </kbd>
    </button>
  );
}
