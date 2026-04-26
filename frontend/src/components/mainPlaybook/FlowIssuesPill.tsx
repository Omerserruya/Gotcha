"use client";

/**
 * Toolbar pill that surfaces flow validation issues without blocking saves.
 *
 * - Green "Ready" when zero issues.
 * - Amber "N warnings" when warnings only.
 * - Red "N issues" when at least one error.
 * Clicking expands a panel that lists each issue; clicking a row calls
 * onSelectNode(id) so the editor can pan to and highlight that node.
 */

import { useMemo, useState } from "react";
import { FlowIssue } from "./flow-validator";

interface Props {
  issues: FlowIssue[];
  onSelectNode?: (nodeId: string) => void;
}

export function FlowIssuesPill({ issues, onSelectNode }: Props) {
  const [open, setOpen] = useState(false);

  const { errorCount, warnCount } = useMemo(() => {
    let e = 0, w = 0;
    for (const i of issues) {
      if (i.severity === "error") e++;
      else w++;
    }
    return { errorCount: e, warnCount: w };
  }, [issues]);

  const total = errorCount + warnCount;

  let tone: "good" | "warn" | "bad";
  let label: string;
  if (total === 0) {
    tone = "good";
    label = "Ready";
  } else if (errorCount === 0) {
    tone = "warn";
    label = `${warnCount} warning${warnCount === 1 ? "" : "s"}`;
  } else {
    tone = "bad";
    label = `${errorCount} issue${errorCount === 1 ? "" : "s"}`;
  }

  const toneClasses =
    tone === "good"
      ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
      : tone === "warn"
      ? "bg-amber-50 text-amber-700 ring-amber-200"
      : "bg-rose-50 text-rose-700 ring-rose-200";

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={total === 0}
        className={`px-2.5 md:px-3 py-2 rounded-xl text-xs font-semibold transition flex items-center gap-1.5 shrink-0 ring-1 ${toneClasses} ${total > 0 ? "hover:shadow-sm cursor-pointer" : "cursor-default opacity-90"}`}
      >
        <span
          className={`w-1.5 h-1.5 rounded-full ${
            tone === "good" ? "bg-emerald-500" : tone === "warn" ? "bg-amber-500 animate-pulse" : "bg-rose-500 animate-pulse"
          }`}
        />
        {label}
      </button>

      {open && total > 0 && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-2 z-40 w-80 max-h-96 overflow-y-auto bg-white rounded-xl shadow-2xl border border-gray-200">
            <div className="px-3 py-2 border-b border-gray-100 flex items-center justify-between">
              <span className="text-xs font-semibold text-gray-700">Flow check</span>
              <span className="text-[10px] text-gray-400">
                {errorCount} error{errorCount === 1 ? "" : "s"} · {warnCount} warning{warnCount === 1 ? "" : "s"}
              </span>
            </div>
            <ul className="py-1">
              {issues.map((i) => (
                <li key={i.id}>
                  <button
                    onClick={() => {
                      if (i.nodeId && onSelectNode) onSelectNode(i.nodeId);
                      setOpen(false);
                    }}
                    className="w-full text-left px-3 py-2 hover:bg-gray-50 transition flex items-start gap-2"
                  >
                    <span
                      className={`mt-0.5 w-4 h-4 shrink-0 rounded-full flex items-center justify-center text-[9px] font-bold ${
                        i.severity === "error"
                          ? "bg-rose-100 text-rose-700"
                          : "bg-amber-100 text-amber-700"
                      }`}
                    >
                      {i.severity === "error" ? "!" : "?"}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-gray-900 truncate">{i.title}</p>
                      <p className="text-[11px] text-gray-500 leading-relaxed mt-0.5">{i.message}</p>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
