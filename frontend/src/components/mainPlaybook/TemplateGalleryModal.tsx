"use client";

import { useState } from "react";
import { FLOW_TEMPLATES, FlowTemplate, instantiateTemplate } from "./templates";

interface Props {
  open: boolean;
  onClose: () => void;
  onPick: (graph: { nodes: any[]; edges: any[] }) => void;
}

const CATEGORIES: Array<FlowTemplate["category"] | "All"> = [
  "All", "Welcome", "Support", "Sales", "FAQ", "Blank",
];

const CATEGORY_TONE: Record<FlowTemplate["category"], { dot: string; chip: string }> = {
  Welcome:  { dot: "bg-sky-400",     chip: "bg-sky-50 text-sky-700" },
  Support:  { dot: "bg-emerald-400", chip: "bg-emerald-50 text-emerald-700" },
  Sales:    { dot: "bg-violet-400",  chip: "bg-violet-50 text-violet-700" },
  FAQ:      { dot: "bg-amber-400",   chip: "bg-amber-50 text-amber-700" },
  Blank:    { dot: "bg-gray-400",    chip: "bg-gray-50 text-gray-700" },
};

export function TemplateGalleryModal({ open, onClose, onPick }: Props) {
  const [filter, setFilter] = useState<typeof CATEGORIES[number]>("All");

  if (!open) return null;

  const visible = FLOW_TEMPLATES.filter(
    (t) => filter === "All" || t.category === filter,
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-5xl max-h-[85vh] bg-white rounded-3xl shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-5 border-b border-gray-100 flex items-start justify-between gap-4 shrink-0">
          <div>
            <h2 className="text-lg font-bold text-gray-900">Start from a template</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Pick a starting point. You can edit every piece — nothing here is locked.
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full hover:bg-gray-100 flex items-center justify-center text-gray-500 shrink-0"
            aria-label="Close"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Category filter */}
        <div className="px-6 py-3 border-b border-gray-100 flex items-center gap-1.5 overflow-x-auto shrink-0">
          {CATEGORIES.map((c) => (
            <button
              key={c}
              onClick={() => setFilter(c)}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold transition shrink-0 ${
                filter === c
                  ? "bg-violet-600 text-white shadow-sm"
                  : "bg-gray-50 text-gray-600 hover:bg-gray-100"
              }`}
            >
              {c}
            </button>
          ))}
        </div>

        {/* Grid */}
        <div className="p-6 overflow-y-auto flex-1">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {visible.map((t) => {
              const tone = CATEGORY_TONE[t.category];
              return (
                <button
                  key={t.id}
                  onClick={() => {
                    const { nodes, edges } = instantiateTemplate(t);
                    onPick({ nodes, edges });
                    onClose();
                  }}
                  className="group text-left rounded-2xl border border-gray-200 bg-white hover:border-violet-300 hover:shadow-lg transition-all duration-150 overflow-hidden flex flex-col"
                >
                  {/* Thumbnail region — stylized preview */}
                  <div className="h-28 bg-gradient-to-br from-gray-50 to-gray-100 p-3 relative overflow-hidden">
                    <MiniPreview template={t} />
                    <span className={`absolute top-2 right-2 text-[10px] font-semibold px-2 py-0.5 rounded-full ${tone.chip}`}>
                      {t.category}
                    </span>
                  </div>
                  <div className="p-4 flex-1 flex flex-col">
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className={`w-1.5 h-1.5 rounded-full ${tone.dot}`} />
                      <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">
                        {t.tagline}
                      </p>
                    </div>
                    <h3 className="text-sm font-bold text-gray-900 mb-1 group-hover:text-violet-700 transition">
                      {t.name}
                    </h3>
                    <p className="text-xs text-gray-500 leading-relaxed flex-1">{t.description}</p>
                    <div className="mt-3 text-[11px] font-semibold text-violet-600 group-hover:underline">
                      Use this template →
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Tiny schematic preview — just shows dots at each node position scaled down.
 * Not a pixel-perfect render of the real node UI, but gives a structural hint.
 */
function MiniPreview({ template }: { template: FlowTemplate }) {
  const pad = 8;
  const W = 380;
  const H = 96;
  if (template.nodes.length === 0) return null;

  const xs = template.nodes.map((n) => n.position.x);
  const ys = template.nodes.map((n) => n.position.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const dx = Math.max(1, maxX - minX);
  const dy = Math.max(1, maxY - minY);

  const project = (x: number, y: number) => ({
    x: pad + ((x - minX) / dx) * (W - pad * 2),
    y: pad + ((y - minY) / dy) * (H - pad * 2),
  });

  const nodeColor = (type: string) => {
    if (type.startsWith("send_")) return "#38bdf8";
    if (type === "condition_group") return "#f59e0b";
    if (type === "route_target" || type === "default_fallback") return "#a78bfa";
    if (type === "end") return "#f43f5e";
    if (type === "start" || type === "channel_entry" || type.endsWith("_trigger")) return "#10b981";
    if (type === "wait") return "#f97316";
    if (type === "collect_input" || type === "set_variable") return "#3b82f6";
    if (type === "update_customer") return "#ec4899";
    if (type === "bring_user_data") return "#f43f5e";
    if (type === "http_request") return "#52525b";
    if (type === "ai_generate") return "#8b5cf6";
    return "#cbd5e1";
  };

  const idToPos = new Map(template.nodes.map((n) => [n.id, project(n.position.x, n.position.y)]));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-full">
      {template.edges.map((e) => {
        const s = idToPos.get(e.source);
        const t = idToPos.get(e.target);
        if (!s || !t) return null;
        return <line key={e.id} x1={s.x} y1={s.y} x2={t.x} y2={t.y} stroke="#cbd5e1" strokeWidth={1.25} />;
      })}
      {template.nodes.map((n) => {
        const p = idToPos.get(n.id)!;
        return <circle key={n.id} cx={p.x} cy={p.y} r={4.5} fill={nodeColor(n.type)} stroke="white" strokeWidth={1.25} />;
      })}
    </svg>
  );
}
