"use client";

import { useEffect, useState } from "react";
import { useCommandCenter } from "./CommandCenterProvider";
import { useI18n } from "@/context/I18nContext";

/**
 * The command bar's own lane: a thin row at the top of the content column,
 * desktop only (md: and up). It is a real row in the layout, not a floating
 * pill - as an overlay it sat on top of page headers, alert banners and
 * toasts and hid them. Nothing else renders here, and --app-chrome-h keeps
 * every full-height page below it short by exactly this height (globals.css).
 * The lane stops at the content column: the menu keeps its full height.
 *
 * Clicking the pill is equivalent to Cmd/Ctrl+K.
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
    // sticky + opaque: the pages that scroll the window (the ones that don't
    // manage their own scroll) must slide *under* the lane, not through it.
    <div className="hidden md:flex shrink-0 app-bar items-center justify-center sticky top-0 z-20 bg-white">
      <button
        type="button"
        onClick={open}
        className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/80 backdrop-blur border border-gray-200 shadow-sm text-gray-500 hover:text-gray-900 hover:border-gray-300 transition"
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
    </div>
  );
}
