"use client";

/**
 * The three-state permission control: Autonomous / HITL / Disabled.
 *
 * One control, not three buttons. The previous version rendered three separate
 * bordered text buttons, which read as three independent toggles - so nothing
 * on screen said "these are mutually exclusive modes of one setting". This is a
 * single track with three slots and exactly one filled, which is what a radio
 * group looks like.
 *
 * Implemented as a real radiogroup with roving tabindex: one tab stop for the
 * whole control, arrow keys move between modes. That is the ARIA pattern for a
 * single-choice control, and it means a keyboard user does not have to tab past
 * three targets on every one of 62 rows.
 */

import { useRef } from "react";
import clsx from "clsx";
import type { PermissionState } from "@/lib/tool-availability-client";

export type SelectableState = Exclude<PermissionState, "unavailable">;

export const SEGMENT_ORDER: SelectableState[] = ["always_allow", "require_approval", "disabled"];

/** Icons carry the meaning; colour is never the only signal. */
function Icon({ state }: { state: SelectableState }) {
  const common = {
    width: 15, height: 15, viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", strokeWidth: 1.9,
    strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
    "aria-hidden": true, focusable: "false" as const,
  };
  if (state === "always_allow") {
    // Check in a circle - "may run".
    return (<svg {...common}><circle cx="12" cy="12" r="8.5" /><path d="M8.6 12.2l2.3 2.3 4.5-4.7" /></svg>);
  }
  if (state === "require_approval") {
    // Raised hand - "stop and ask a person".
    return (
      <svg {...common}>
        <path d="M9 11V5.6a1.3 1.3 0 0 1 2.6 0V11" />
        <path d="M11.6 10.6V4.8a1.3 1.3 0 0 1 2.6 0v5.8" />
        <path d="M14.2 11V6.6a1.3 1.3 0 0 1 2.6 0V14a5.4 5.4 0 0 1-5.4 5.4h-.6A5.2 5.2 0 0 1 5.4 14v-2a1.3 1.3 0 0 1 2.6 0" />
      </svg>
    );
  }
  // Minus in a circle - "cannot run".
  return (<svg {...common}><circle cx="12" cy="12" r="8.5" /><path d="M8.4 12h7.2" /></svg>);
}

export interface SegmentedControlProps {
  value: PermissionState;
  onChange: (next: SelectableState) => void;
  /** Modes this tool cannot take, with the reason shown in the tooltip. */
  lockedStates?: Partial<Record<SelectableState, string>>;
  /** The whole control is inert - provider/plan/connection, not a user choice. */
  unavailable?: boolean;
  unavailableReason?: string;
  he: boolean;
  saving?: boolean;
  /** Labels the control for assistive tech, e.g. the tool's name. */
  labelledBy?: string;
  idPrefix: string;
}

const LABELS: Record<SelectableState, { en: string; he: string }> = {
  always_allow: { en: "Autonomous", he: "אוטונומי" },
  require_approval: { en: "Requires approval", he: "דורש אישור" },
  disabled: { en: "Disabled", he: "כבוי" },
};

const TIPS: Record<SelectableState, { en: string; he: string }> = {
  always_allow: {
    en: "AI may run this tool automatically",
    he: "ה-AI רשאי להפעיל את הכלי הזה אוטומטית",
  },
  require_approval: {
    en: "AI must request human approval before execution",
    he: "ה-AI חייב לבקש אישור אנושי לפני ההפעלה",
  },
  disabled: { en: "This tool cannot be used", he: "לא ניתן להשתמש בכלי הזה" },
};

export function ToolPermissionSegmentedControl({
  value, onChange, lockedStates, unavailable, unavailableReason, he, saving, labelledBy, idPrefix,
}: SegmentedControlProps) {
  const ref = useRef<HTMLDivElement>(null);

  function move(dir: 1 | -1) {
    const enabled = SEGMENT_ORDER.filter((s) => !lockedStates?.[s]);
    if (!enabled.length) return;
    const cur = enabled.indexOf(value as SelectableState);
    // Wrap, so the control never dead-ends at an edge.
    const next = enabled[(((cur === -1 ? 0 : cur) + dir) + enabled.length) % enabled.length];
    onChange(next);
    requestAnimationFrame(() => {
      ref.current?.querySelector<HTMLButtonElement>(`[data-state="${next}"]`)?.focus();
    });
  }

  function onKeyDown(e: React.KeyboardEvent) {
    // In RTL the visual order is mirrored, so Left means "next".
    const fwd = he ? "ArrowLeft" : "ArrowRight";
    const back = he ? "ArrowRight" : "ArrowLeft";
    if (e.key === fwd || e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === back || e.key === "ArrowUp") { e.preventDefault(); move(-1); }
  }

  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-disabled={unavailable || undefined}
      onKeyDown={onKeyDown}
      data-testid={`segmented-${idPrefix}`}
      title={unavailable ? unavailableReason : undefined}
      className={clsx(
        "inline-flex items-center gap-0.5 rounded-full p-0.5 shrink-0",
        "bg-gray-100 dark:bg-gray-800",
        unavailable && "opacity-50",
        saving && "animate-pulse",
      )}
    >
      {SEGMENT_ORDER.map((state) => {
        const selected = value === state;
        const lockedWhy = lockedStates?.[state];
        const disabled = !!lockedWhy || !!unavailable || !!saving;
        const label = he ? LABELS[state].he : LABELS[state].en;
        const tip = lockedWhy || (unavailable ? unavailableReason : undefined) || (he ? TIPS[state].he : TIPS[state].en);
        return (
          <button
            key={state}
            type="button"
            role="radio"
            data-state={state}
            data-testid={`state-${state}-${idPrefix}`}
            aria-checked={selected}
            aria-label={label}
            title={tip}
            disabled={disabled}
            // Roving tabindex: only the selected segment is a tab stop.
            tabIndex={selected ? 0 : -1}
            onClick={() => { if (!disabled && !selected) onChange(state); }}
            className={clsx(
              "w-7 h-7 rounded-full flex items-center justify-center transition-colors",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-1",
              selected
                ? "bg-white text-gray-800 shadow-sm ring-1 ring-black/[0.05] dark:bg-gray-600 dark:text-gray-100"
                : "text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300",
              disabled && !selected && "cursor-not-allowed hover:text-gray-400",
            )}
          >
            <Icon state={state} />
          </button>
        );
      })}
    </div>
  );
}

export default ToolPermissionSegmentedControl;
