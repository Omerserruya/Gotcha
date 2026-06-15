"use client";

/**
 * Text input / textarea with an "{} Insert variable" picker.
 *
 * Why this exists: flow authors are not developers. Typing {{customer_email}}
 * by hand means typos render as empty strings and nobody notices until a
 * customer gets a broken reply. This component reads variables defined by
 * other nodes on the same canvas and inserts them at the cursor, so the
 * author never has to know the {{}} syntax.
 *
 * The component is a drop-in replacement for a plain <input> or <textarea>
 * in any flow node that accepts interpolated text.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useReactFlow } from "reactflow";

// ─── What shape of "variable" do we know about? ───────────────

interface VarEntry {
  name: string;          // variable identifier, e.g. "customer_email"
  source: string;        // human-friendly source label, e.g. "Collect Input"
  sourceColor: string;   // tailwind bg class for the source chip
  nodeType?: string;
  nodeId?: string;
}

// Built-in variables always available in a flow run - the user's last
// message, the channel it came in on, etc. Authors can mix these with
// anything they define on the canvas.
const BUILT_IN_VARS: VarEntry[] = [
  { name: "message",      source: "Built-in",       sourceColor: "bg-gray-200 text-gray-700" },
  { name: "channel",      source: "Built-in",       sourceColor: "bg-gray-200 text-gray-700" },
  { name: "customer_id",  source: "Built-in",       sourceColor: "bg-gray-200 text-gray-700" },
];

const SOURCE_COLORS: Record<string, string> = {
  collect_input:   "bg-blue-100 text-blue-700",
  set_variable:    "bg-purple-100 text-purple-700",
  http_request:    "bg-zinc-200 text-zinc-800",
  ai_generate:     "bg-violet-100 text-violet-700",
  bring_user_data: "bg-rose-100 text-rose-700",
};

const SOURCE_LABELS: Record<string, string> = {
  collect_input:   "Collect Input",
  set_variable:    "Set Variable",
  http_request:    "HTTP Response",
  ai_generate:     "AI Output",
  bring_user_data: "Contact Field",
};

function scanCanvasForVars(nodes: Array<{ id: string; type: string; data: any }>): VarEntry[] {
  const out: VarEntry[] = [];
  for (const n of nodes) {
    const t = n.type;
    const d = n.data || {};
    if (t === "collect_input" || t === "set_variable") {
      const name = String(d.variable || "").trim();
      if (name) {
        out.push({
          name,
          source: SOURCE_LABELS[t],
          sourceColor: SOURCE_COLORS[t],
          nodeType: t,
          nodeId: n.id,
        });
      }
    } else if (t === "http_request" || t === "ai_generate") {
      const name = String(d.responseVariable || "").trim();
      if (name) {
        out.push({
          name,
          source: SOURCE_LABELS[t],
          sourceColor: SOURCE_COLORS[t],
          nodeType: t,
          nodeId: n.id,
        });
      }
    } else if (t === "bring_user_data") {
      const prefix = String(d.prefix || "customer").replace(/[^a-z0-9_]/gi, "");
      const fields: string[] = Array.isArray(d.fields) ? d.fields : [];
      for (const f of fields) {
        out.push({
          name: `${prefix}_${f}`,
          source: SOURCE_LABELS[t],
          sourceColor: SOURCE_COLORS[t],
          nodeType: t,
          nodeId: n.id,
        });
      }
    }
  }
  // Deduplicate by variable name, preserving first occurrence.
  const seen = new Set<string>();
  return out.filter((v) => {
    if (seen.has(v.name)) return false;
    seen.add(v.name);
    return true;
  });
}

// ─── Hook: gather all available variables for the current canvas ──

export function useAvailableVariables(): VarEntry[] {
  const rf = useReactFlow();
  // Subscribe to node list changes so the dropdown refreshes when the author
  // renames a variable on another node.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 600);
    return () => clearInterval(id);
  }, []);
  // `tick` keeps the useMemo fresh at a reasonable cadence. Polling is ok -
  // there are rarely more than a few dozen nodes, and ReactFlow doesn't
  // expose a clean subscription for "node data changed without position".
  return useMemo(() => {
    const nodes = rf.getNodes();
    const canvasVars = scanCanvasForVars(nodes as any);
    return [...canvasVars, ...BUILT_IN_VARS];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rf, tick]);
}

// ─── Component ───────────────────────────────────────────────

interface Props {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
  rows?: number;
  className?: string;
  tone?: "sky" | "indigo" | "teal" | "fuchsia" | "slate" | "purple" | "zinc" | "violet" | "pink" | "rose" | "gray" | "emerald";
}

const TONE_RING: Record<NonNullable<Props["tone"]>, string> = {
  sky:     "focus-within:ring-sky-300 focus-within:border-sky-300",
  indigo:  "focus-within:ring-indigo-300 focus-within:border-indigo-300",
  teal:    "focus-within:ring-teal-300 focus-within:border-teal-300",
  fuchsia: "focus-within:ring-fuchsia-300 focus-within:border-fuchsia-300",
  slate:   "focus-within:ring-slate-300 focus-within:border-slate-300",
  purple:  "focus-within:ring-purple-300 focus-within:border-purple-300",
  zinc:    "focus-within:ring-zinc-300 focus-within:border-zinc-300",
  violet:  "focus-within:ring-violet-300 focus-within:border-violet-300",
  pink:    "focus-within:ring-pink-300 focus-within:border-pink-300",
  rose:    "focus-within:ring-rose-300 focus-within:border-rose-300",
  gray:    "focus-within:ring-gray-300 focus-within:border-gray-300",
  emerald: "focus-within:ring-emerald-300 focus-within:border-emerald-300",
};

export function VariableMentionInput({
  value,
  onChange,
  placeholder,
  multiline,
  rows = 2,
  className = "",
  tone = "gray",
}: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const available = useAvailableVariables();

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return available;
    return available.filter((v) => v.name.toLowerCase().includes(q));
  }, [filter, available]);

  function insertAtCursor(variable: string) {
    const el = inputRef.current;
    const token = `{{${variable}}}`;
    if (!el) {
      onChange(value + token);
    } else {
      const start = el.selectionStart ?? value.length;
      const end = el.selectionEnd ?? value.length;
      const next = value.slice(0, start) + token + value.slice(end);
      onChange(next);
      // Re-focus and position cursor after the inserted token.
      requestAnimationFrame(() => {
        try {
          el.focus();
          const pos = start + token.length;
          (el as HTMLInputElement).setSelectionRange(pos, pos);
        } catch {}
      });
    }
    setPickerOpen(false);
    setFilter("");
  }

  const baseInput = `flex-1 text-xs bg-transparent border-0 outline-none resize-none ${multiline ? "py-1" : ""}`;

  return (
    <div className={`relative`}>
      <div
        className={`flex items-start gap-1.5 border border-gray-200 bg-gray-50/50 rounded-lg px-2 py-1.5 transition focus-within:ring-2 ${TONE_RING[tone]} ${className}`}
      >
        {multiline ? (
          <textarea
            ref={(el) => { inputRef.current = el; }}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            rows={rows}
            className={baseInput}
          />
        ) : (
          <input
            ref={(el) => { inputRef.current = el; }}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            className={baseInput}
          />
        )}
        <button
          type="button"
          onClick={() => setPickerOpen((v) => !v)}
          title="Insert a variable from another node"
          className={`shrink-0 w-6 h-6 rounded-md flex items-center justify-center text-[10px] font-mono font-bold transition ${
            pickerOpen
              ? "bg-violet-600 text-white"
              : "bg-gray-100 text-gray-500 hover:bg-violet-100 hover:text-violet-600"
          }`}
        >
          {"{x}"}
        </button>
      </div>

      {pickerOpen && (
        <>
          {/* backdrop - click outside to close */}
          <div className="fixed inset-0 z-30" onClick={() => { setPickerOpen(false); setFilter(""); }} />
          <div className="absolute right-0 top-full mt-1 z-40 w-72 bg-white rounded-xl shadow-2xl border border-gray-200 overflow-hidden">
            <div className="px-3 py-2 border-b border-gray-100 flex items-center gap-2">
              <svg className="w-3.5 h-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
              </svg>
              <input
                autoFocus
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Search variables…"
                className="flex-1 text-xs bg-transparent outline-none"
              />
            </div>
            <div className="max-h-64 overflow-y-auto py-1">
              {filtered.length === 0 ? (
                <div className="px-3 py-4 text-xs text-gray-400 text-center">
                  No variables yet.
                  <div className="mt-1 text-[10px]">
                    Add a Collect Input, Set Variable, or HTTP Request node to define one.
                  </div>
                </div>
              ) : (
                filtered.map((v) => (
                  <button
                    key={`${v.nodeId ?? ""}::${v.name}`}
                    onClick={() => insertAtCursor(v.name)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-violet-50 transition text-left"
                  >
                    <span className="flex-1 font-mono text-[11px] text-gray-800 truncate">
                      {"{{" + v.name + "}}"}
                    </span>
                    <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-full ${v.sourceColor}`}>
                      {v.source}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
