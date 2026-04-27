"use client";

import React from "react";
import { Handle, Position, NodeProps } from "reactflow";

// Single trigger card rendered ON the canvas as a non-draggable node.
// Layout (top-down):
//   ⚡ When...                ← small black icon + dark-mid gray label
//   [icon] <Channel/Title>   ← channel/category icon + main title
//          Incoming message  ← gray secondary line
//                      Then ●← bottom-right outgoing connection dot
//
// Each trigger type produces its own (icon, title, subtitle) — the chrome is
// identical so the cards read as a clean column at the canvas's left edge.

const CHANNEL_LOGOS: Record<
  string,
  { label: string; bg: string; fg: string; icon: React.ReactNode }
> = {
  whatsapp: {
    label: "WhatsApp",
    bg: "bg-emerald-50",
    fg: "text-emerald-600",
    icon: (
      <svg viewBox="0 0 32 32" fill="currentColor" className="w-full h-full">
        <path d="M16 3C8.82 3 3 8.82 3 16c0 2.3.6 4.45 1.66 6.32L3 29l6.84-1.62A12.94 12.94 0 0 0 16 29c7.18 0 13-5.82 13-13S23.18 3 16 3zm0 23.5c-2.06 0-3.99-.55-5.66-1.5l-.4-.23-4.06.96.97-3.95-.26-.41A10.49 10.49 0 0 1 5.5 16C5.5 10.2 10.2 5.5 16 5.5S26.5 10.2 26.5 16 21.8 26.5 16 26.5zm5.92-7.86c-.32-.16-1.9-.94-2.2-1.04-.29-.11-.5-.16-.72.16-.21.32-.83 1.04-1.02 1.26-.18.21-.37.24-.69.08-.32-.16-1.36-.5-2.6-1.6-.96-.86-1.6-1.92-1.79-2.24-.18-.32-.02-.49.14-.65.14-.14.32-.37.48-.55.16-.18.21-.32.32-.53.11-.21.05-.4-.03-.55-.08-.16-.72-1.74-.99-2.39-.26-.62-.53-.54-.72-.55-.18-.01-.4-.01-.61-.01-.21 0-.55.08-.84.4-.29.32-1.1 1.07-1.1 2.6 0 1.54 1.13 3.02 1.29 3.23.16.21 2.22 3.4 5.39 4.76.75.32 1.34.51 1.8.66.76.24 1.45.21 2 .13.61-.09 1.9-.78 2.17-1.53.27-.75.27-1.4.19-1.53-.08-.13-.29-.21-.61-.37z"/>
      </svg>
    ),
  },
  instagram: {
    label: "Instagram",
    bg: "bg-pink-50",
    fg: "text-pink-600",
    icon: (
      <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth={2} className="w-full h-full">
        <rect x="5" y="5" width="22" height="22" rx="6" />
        <circle cx="16" cy="16" r="5" />
        <circle cx="22.5" cy="9.5" r="1.2" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
  messenger: {
    label: "Messenger",
    bg: "bg-blue-50",
    fg: "text-blue-600",
    icon: (
      <svg viewBox="0 0 32 32" fill="currentColor" className="w-full h-full">
        <path d="M16 3C8.82 3 3 8.49 3 15.6c0 4.05 1.93 7.65 4.96 10.01V29l4.55-2.5c1.13.31 2.31.48 3.49.48 7.18 0 13-5.49 13-12.6S23.18 3 16 3zm1.31 16.7l-3.32-3.55-6.49 3.55 7.13-7.55 3.4 3.55 6.4-3.55-7.12 7.55z"/>
      </svg>
    ),
  },
  facebook: {
    label: "Facebook",
    bg: "bg-blue-50",
    fg: "text-blue-600",
    icon: (
      <svg viewBox="0 0 32 32" fill="currentColor" className="w-full h-full">
        <path d="M29 16c0-7.18-5.82-13-13-13S3 8.82 3 16c0 6.49 4.76 11.87 11 12.85V19.77H10.7V16H14v-2.86c0-3.26 1.94-5.06 4.91-5.06 1.42 0 2.91.25 2.91.25v3.2H20.2c-1.61 0-2.12 1-2.12 2.03V16h3.6l-.58 3.77H18.08v9.08c6.24-.98 11-6.36 11-12.85z"/>
      </svg>
    ),
  },
};

const FALLBACK_LOGO = {
  label: "Channel",
  bg: "bg-gray-100",
  fg: "text-gray-600",
  icon: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-full h-full">
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  ),
};

// Lightning glyph used as the small "trigger" mark above the When... label.
const TriggerMark = (
  <svg
    className="w-4 h-4"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M13 2L3 14h7l-1 8 11-14h-8l1-6z" />
  </svg>
);

export function TriggerCardNode(props: NodeProps) {
  const { type, data, selected } = props;
  const { icon, title, subtitle } = describe(type, data);

  return (
    <div
      style={{
        background: "var(--surface-card)",
        boxShadow: "var(--shadow-card)",
        borderRadius: "var(--radius-card)",
      }}
      className={[
        "min-w-[260px] max-w-[280px] border border-[var(--border-hairline)] select-none",
        "transition-all duration-150",
        selected
          ? "outline outline-2 outline-violet-500 outline-offset-[3px]"
          : "",
        "hover:shadow-lg",
      ].join(" ")}
    >
      {/* Top: trigger mark + "When..." caption */}
      <div className="flex items-center gap-1.5 px-4 pt-3.5">
        <span className="text-gray-900">{TriggerMark}</span>
        <span className="text-[12px] font-medium tracking-wide text-gray-500">
          When…
        </span>
      </div>

      {/* Body: channel/type icon + title + subtitle */}
      <div className="px-4 pt-2 pb-3 flex items-center gap-3">
        <div className={`w-9 h-9 rounded-lg shrink-0 flex items-center justify-center ${icon.bg} ${icon.fg}`}>
          <span className="block w-5 h-5">{icon.node}</span>
        </div>
        <div className="min-w-0 flex-1">
          <p
            className="text-[15px] font-semibold truncate"
            style={{ color: "var(--canvas-text-primary)" }}
            title={title}
          >
            {title}
          </p>
          <p
            className="text-[12px] truncate"
            style={{ color: "var(--canvas-text-secondary)" }}
            title={subtitle}
          >
            {subtitle}
          </p>
        </div>
      </div>

      {/* Footer: bottom-right "Then" label; the connection dot sits ON the
          card's right edge at footer height. */}
      <div className="px-4 pb-3 pt-1 flex items-center justify-end">
        <span
          className="text-[12px] font-medium tracking-wide"
          style={{ color: "var(--canvas-text-secondary)" }}
        >
          Then
        </span>
      </div>
      <Handle
        type="source"
        position={Position.Right}
        id="out"
        style={{ top: "auto", bottom: 14 }}
        className="!w-2.5 !h-2.5 !bg-[var(--edge-color)] !border-2 !border-white"
      />
    </div>
  );
}

// ─── Per-type description ─────────────────────────────────────────
function describe(
  type: string | undefined,
  data: any,
): {
  icon: { node: React.ReactNode; bg: string; fg: string };
  title: string;
  subtitle: string;
} {
  const d = data || {};
  switch (type) {
    case "channel_entry": {
      const ch = String(d.channelType || "").toLowerCase();
      const logo = CHANNEL_LOGOS[ch] || FALLBACK_LOGO;
      // Prefer the connected-channel display name (e.g. "@gotcha.inbox") over
      // the platform name. Fall back to the platform if the user hasn't picked
      // a specific account yet.
      const connectedName = typeof d.label === "string" ? d.label.trim() : "";
      const title = connectedName || (ch ? logo.label : "Any channel");
      return {
        icon: { node: logo.icon, bg: logo.bg, fg: logo.fg },
        title,
        subtitle: "Incoming message",
      };
    }
    case "comment_trigger": {
      const platform = String(d.platform || "").toLowerCase();
      const logo = platform === "facebook" ? CHANNEL_LOGOS.facebook : CHANNEL_LOGOS.instagram;
      const list: string[] = Array.isArray(d.keywords) ? d.keywords : [];
      return {
        icon: { node: logo.icon, bg: logo.bg, fg: logo.fg },
        title: `${logo.label} comment`,
        subtitle: list.length === 0
          ? "Any new comment"
          : `Matches “${list[0]}”${list.length > 1 ? ` +${list.length - 1}` : ""}`,
      };
    }
    case "keyword_trigger": {
      const list: string[] = Array.isArray(d.keywords) ? d.keywords : [];
      return {
        icon: {
          node: (
            <svg className="w-full h-full" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
            </svg>
          ),
          bg: "bg-amber-50",
          fg: "text-amber-600",
        },
        title: "Keyword match",
        subtitle: list.length === 0 ? "No keywords yet" : list.slice(0, 3).join(", ") + (list.length > 3 ? "…" : ""),
      };
    }
    case "schedule_trigger": {
      return {
        icon: {
          node: (
            <svg className="w-full h-full" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          ),
          bg: "bg-indigo-50",
          fg: "text-indigo-600",
        },
        title: "Schedule",
        subtitle: d.cron ? String(d.cron) : "Not set",
      };
    }
    default:
      return {
        icon: { node: FALLBACK_LOGO.icon, bg: FALLBACK_LOGO.bg, fg: FALLBACK_LOGO.fg },
        title: "Trigger",
        subtitle: "",
      };
  }
}
