"use client";

/**
 * One tool category: a header on the page background, then ONE container
 * holding every row in the group, separated by hairlines.
 *
 * The previous layout gave each tool its own bordered card. At 62 Shopify tools
 * that is 62 borders and 62 shadows, and the eye has no way to see where a
 * group starts - which is why the page read as a long settings form rather than
 * a workspace. One container per category is the whole difference.
 */

import { useState, useRef, useEffect } from "react";
import clsx from "clsx";
import type { PermissionState, RiskGroup } from "@/lib/tool-availability-client";
import { ToolPermissionSegmentedControl, SEGMENT_ORDER, type SelectableState } from "./ToolPermissionSegmentedControl";

// ── Group-level control ─────────────────────────────────────────────────────

export type GroupMode = SelectableState | "mixed";

const GROUP_LABEL: Record<GroupMode, { en: string; he: string }> = {
  always_allow: { en: "Always allow", he: "תמיד מאושר" },
  require_approval: { en: "Ask first", he: "לשאול קודם" },
  disabled: { en: "Off", he: "כבוי" },
  mixed: { en: "Mixed", he: "מעורב" },
};

/**
 * Dropdown showing the group's shared mode, or "Mixed" when they differ.
 *
 * A dropdown rather than a second segmented control on purpose: "Mixed" is a
 * real fourth state that a three-slot control cannot express without lying.
 */
export function GroupPermissionControl({
  mode, onApply, he, disabled, idPrefix,
}: {
  mode: GroupMode;
  onApply: (next: SelectableState) => void;
  he: boolean;
  disabled?: boolean;
  idPrefix: string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const label = he ? GROUP_LABEL[mode].he : GROUP_LABEL[mode].en;

  return (
    <div ref={box} className="relative shrink-0">
      <button
        type="button"
        data-testid={`group-control-${idPrefix}`}
        data-mode={mode}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={clsx(
          "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition",
          "border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:text-gray-800",
          "dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400",
          disabled && "opacity-40 cursor-not-allowed",
        )}
      >
        <span className={clsx("w-1.5 h-1.5 rounded-full", mode === "mixed" ? "bg-amber-400" : "bg-gray-300")} />
        {label}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
          <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          data-testid={`group-menu-${idPrefix}`}
          className="absolute end-0 z-30 mt-1 w-44 rounded-xl border border-gray-100 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-900"
        >
          {SEGMENT_ORDER.map((s) => (
            <button
              key={s}
              type="button"
              role="menuitem"
              data-testid={`group-apply-${s}-${idPrefix}`}
              onClick={() => { setOpen(false); onApply(s); }}
              className="block w-full px-3 py-1.5 text-start text-[11px] text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-800"
            >
              {he ? GROUP_LABEL[s].he : GROUP_LABEL[s].en}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Tool row ────────────────────────────────────────────────────────────────

export interface CategoryTool {
  name: string;
  displayName: string;
  description: string;
  state: PermissionState;
  unavailable: boolean;
  unavailableReason?: string;
  lockedStates?: Partial<Record<SelectableState, string>>;
  saving?: boolean;
}

export function ToolRow({
  tool, he, showRawName, onChange,
}: {
  tool: CategoryTool;
  he: boolean;
  showRawName: boolean;
  onChange: (next: SelectableState) => void;
}) {
  const labelId = `tool-label-${tool.name.replace(/[^a-zA-Z0-9]/g, "-")}`;
  return (
    <div
      data-testid={`tool-row-${tool.name}`}
      className="flex items-center gap-3 px-3 py-2 min-h-[52px]"
    >
      <div className="min-w-0 flex-1">
        {/* The localized name is the label. The raw id is diagnostics only. */}
        <p id={labelId} className="text-[13px] font-medium text-gray-800 dark:text-gray-100 truncate">
          {tool.displayName}
        </p>
        {tool.description && (
          <p className="text-[11.5px] leading-snug text-gray-400 dark:text-gray-500 line-clamp-2">
            {tool.description}
          </p>
        )}
        {/* Availability is NOT policy: say which one this is. */}
        {tool.unavailable && tool.unavailableReason && (
          <p
            data-testid={`tool-unavailable-${tool.name}`}
            className="mt-0.5 inline-flex items-center gap-1 text-[10.5px] text-amber-600 dark:text-amber-500"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path d="M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {tool.unavailableReason}
          </p>
        )}
        {showRawName && (
          <p className="mt-0.5 font-mono text-[10px] text-gray-300 dark:text-gray-600" dir="ltr">{tool.name}</p>
        )}
      </div>

      <ToolPermissionSegmentedControl
        idPrefix={tool.name}
        value={tool.state}
        onChange={onChange}
        lockedStates={tool.lockedStates}
        unavailable={tool.unavailable}
        unavailableReason={tool.unavailableReason}
        saving={tool.saving}
        he={he}
        labelledBy={labelId}
      />
    </div>
  );
}

// ── Category section ────────────────────────────────────────────────────────

export function ToolCategorySection({
  group, title, tools, he, showRawName, defaultOpen, onChangeTool, onApplyGroup,
}: {
  group: RiskGroup;
  title: string;
  tools: CategoryTool[];
  he: boolean;
  showRawName: boolean;
  defaultOpen: boolean;
  onChangeTool: (tool: CategoryTool, next: SelectableState) => void;
  onApplyGroup: (next: SelectableState) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);

  // Mixed is derived from the tools that can actually hold a policy; an
  // unavailable tool has no user choice, so counting it would show "Mixed"
  // for a group the admin has set consistently.
  const governable = tools.filter((t) => !t.unavailable);
  const modes = Array.from(new Set(governable.map((t) => t.state)));
  const mode: GroupMode = modes.length === 1 ? (modes[0] as SelectableState) : "mixed";

  return (
    <section className="mb-4" data-testid={`risk-group-${group}`}>
      <div className="mb-1.5 flex items-center justify-between gap-2 px-0.5">
        <button
          type="button"
          data-testid={`category-toggle-${group}`}
          aria-expanded={open}
          aria-controls={`category-panel-${group}`}
          onClick={() => setOpen((v) => !v)}
          className="group inline-flex items-center gap-1.5 text-[13px] font-semibold text-gray-800 dark:text-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 rounded"
        >
          <svg
            width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}
            aria-hidden="true"
            className={clsx("text-gray-400 transition-transform", open ? "rotate-0" : he ? "rotate-90" : "-rotate-90")}
          >
            <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {title}
          <span className="text-[11px] font-normal text-gray-400 tabular-nums">{tools.length}</span>
        </button>

        <GroupPermissionControl
          idPrefix={group}
          mode={mode}
          he={he}
          disabled={governable.length === 0}
          onApply={onApplyGroup}
        />
      </div>

      {open && (
        <div
          id={`category-panel-${group}`}
          data-testid={`category-panel-${group}`}
          className="overflow-hidden rounded-xl border border-gray-200/80 bg-white divide-y divide-gray-100 dark:border-gray-700 dark:bg-gray-900 dark:divide-gray-800"
        >
          {tools.map((t) => (
            <ToolRow key={t.name} tool={t} he={he} showRawName={showRawName} onChange={(n) => onChangeTool(t, n)} />
          ))}
        </div>
      )}
    </section>
  );
}

export default ToolCategorySection;
