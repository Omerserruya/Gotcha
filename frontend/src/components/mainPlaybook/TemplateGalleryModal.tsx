"use client";

import { useState } from "react";
import {
  FLOW_TEMPLATES,
  FlowTemplate,
  FormFieldDef,
  FormValues,
  instantiateTemplate,
} from "./templates";

interface Props {
  open: boolean;
  onClose: () => void;
  onPick: (graph: { nodes: any[]; edges: any[] }) => void;
}

const CATEGORIES: Array<FlowTemplate["category"] | "All"> = [
  "All", "Welcome", "Lead Magnet", "Booking", "Support", "Sales", "FAQ", "AI",
];

const CATEGORY_TONE: Record<FlowTemplate["category"], { dot: string; chip: string }> = {
  Welcome:       { dot: "bg-sky-400",     chip: "bg-sky-50 text-sky-700" },
  Support:       { dot: "bg-emerald-400", chip: "bg-emerald-50 text-emerald-700" },
  Sales:         { dot: "bg-violet-400",  chip: "bg-violet-50 text-violet-700" },
  FAQ:           { dot: "bg-amber-400",   chip: "bg-amber-50 text-amber-700" },
  "Lead Magnet": { dot: "bg-pink-400",    chip: "bg-pink-50 text-pink-700" },
  Booking:       { dot: "bg-indigo-400",  chip: "bg-indigo-50 text-indigo-700" },
  AI:            { dot: "bg-fuchsia-400", chip: "bg-fuchsia-50 text-fuchsia-700" },
};

export function TemplateGalleryModal({ open, onClose, onPick }: Props) {
  const [filter, setFilter] = useState<typeof CATEGORIES[number]>("All");
  // Two-step flow: null = gallery, set = the picked template's form.
  const [selected, setSelected] = useState<FlowTemplate | null>(null);

  if (!open) return null;

  const visible = FLOW_TEMPLATES.filter(
    (t) => filter === "All" || t.category === filter,
  );

  const close = () => {
    setSelected(null);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm"
      onClick={close}
    >
      {/* Side panel — slides in from the right. Full height, fixed width on
          desktop, full width on mobile. */}
      <div
        className="absolute top-0 right-0 h-full w-full sm:w-[520px] bg-white shadow-2xl flex flex-col overflow-hidden animate-slide-in-right"
        onClick={(e) => e.stopPropagation()}
      >
        {selected ? (
          <TemplateFormView
            template={selected}
            onBack={() => setSelected(null)}
            onClose={close}
            onSubmit={(values) => {
              const { nodes, edges } = instantiateTemplate(selected, values);
              onPick({ nodes, edges });
              close();
            }}
          />
        ) : (
          <GalleryView
            visible={visible}
            filter={filter}
            setFilter={setFilter}
            onClose={close}
            onPick={(t) => {
              // Templates with no form fields go straight onto the canvas.
              if (!t.formFields || t.formFields.length === 0) {
                const { nodes, edges } = instantiateTemplate(t);
                onPick({ nodes, edges });
                close();
                return;
              }
              setSelected(t);
            }}
          />
        )}
      </div>
    </div>
  );
}

// ─── Step 1: gallery ─────────────────────────────────────────────

function GalleryView({
  visible,
  filter,
  setFilter,
  onClose,
  onPick,
}: {
  visible: FlowTemplate[];
  filter: typeof CATEGORIES[number];
  setFilter: (c: typeof CATEGORIES[number]) => void;
  onClose: () => void;
  onPick: (t: FlowTemplate) => void;
}) {
  return (
    <>
      <div className="px-6 py-5 border-b border-gray-100 flex items-start justify-between gap-4 shrink-0">
        <div>
          <h2 className="text-lg font-bold text-gray-900">Start from a template</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Pick one and fill the short form — we&apos;ll wire the nodes for you. The template adds to your existing canvas.
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

      <div className="px-6 py-3 border-b border-gray-100 flex items-center gap-1.5 overflow-x-auto shrink-0">
        {CATEGORIES.map((c) => (
          <button
            key={c}
            onClick={() => setFilter(c)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold transition shrink-0 ${
              filter === c ? "bg-violet-600 text-white shadow-sm" : "bg-gray-50 text-gray-600 hover:bg-gray-100"
            }`}
          >
            {c}
          </button>
        ))}
      </div>

      <div className="px-4 py-3 overflow-y-auto flex-1 space-y-2">
        {visible.map((t) => {
          const tone = CATEGORY_TONE[t.category];
          return (
            <button
              key={t.id}
              onClick={() => onPick(t)}
              className="group w-full text-left rounded-xl border border-gray-200 bg-white hover:border-violet-300 hover:shadow-md transition-all duration-150 overflow-hidden flex"
            >
              <div className="w-24 h-24 shrink-0 bg-gradient-to-br from-gray-50 to-gray-100 p-2 relative overflow-hidden">
                <MiniPreview template={t} />
              </div>
              <div className="px-3.5 py-2.5 flex-1 min-w-0 flex flex-col justify-between">
                <div>
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span className={`w-1.5 h-1.5 rounded-full ${tone.dot}`} />
                    <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider truncate">{t.tagline}</p>
                    <span className={`ml-auto text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${tone.chip}`}>
                      {t.category}
                    </span>
                  </div>
                  <h3 className="text-[13px] font-semibold text-gray-900 mb-0.5 group-hover:text-violet-700 transition truncate">{t.name}</h3>
                  <p className="text-[11.5px] text-gray-500 leading-snug line-clamp-2">{t.description}</p>
                </div>
                <div className="text-[11px] font-semibold text-violet-600 group-hover:underline mt-1.5">
                  {t.formFields && t.formFields.length > 0 ? "Configure & add →" : "Add to canvas →"}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </>
  );
}

// ─── Step 2: per-template form ───────────────────────────────────

function TemplateFormView({
  template,
  onBack,
  onClose,
  onSubmit,
}: {
  template: FlowTemplate;
  onBack: () => void;
  onClose: () => void;
  onSubmit: (values: FormValues) => void;
}) {
  const fields = template.formFields ?? [];
  const [values, setValues] = useState<FormValues>(() => initialValues(fields));

  const update = (id: string, v: string | number | string[]) =>
    setValues((prev) => ({ ...prev, [id]: v }));

  const submit = () => {
    if (!isFormValid(fields, values)) return;
    onSubmit(values);
  };

  const valid = isFormValid(fields, values);

  return (
    <>
      <div className="px-6 py-5 border-b border-gray-100 flex items-start justify-between gap-4 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={onBack}
            className="w-8 h-8 rounded-full hover:bg-gray-100 flex items-center justify-center text-gray-500 shrink-0"
            aria-label="Back"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-gray-900 truncate">{template.name}</h2>
            <p className="text-xs text-gray-500 mt-0.5 truncate">{template.description}</p>
          </div>
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

      <div className="p-6 overflow-y-auto flex-1 space-y-5">
        {fields.map((f) => (
          <FieldRow key={f.id} field={f} value={values[f.id]} onChange={(v) => update(f.id, v)} />
        ))}
      </div>

      <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-end gap-2 shrink-0 bg-gray-50/50">
        <button
          onClick={onBack}
          className="px-3 py-1.5 rounded-md text-xs font-medium text-gray-600 hover:bg-black/[0.04] transition"
        >
          Back
        </button>
        <button
          onClick={submit}
          disabled={!valid}
          className="bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white px-4 py-1.5 rounded-md text-sm font-medium transition"
        >
          Add to canvas
        </button>
      </div>
    </>
  );
}

// ─── Form field renderer ─────────────────────────────────────────

function FieldRow({
  field,
  value,
  onChange,
}: {
  field: FormFieldDef;
  value: string | number | string[] | undefined;
  onChange: (v: string | number | string[]) => void;
}) {
  const baseInput =
    "w-full rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-violet-300 focus:border-violet-300";

  return (
    <div>
      <label className="block text-xs font-semibold text-gray-700 mb-1.5">
        {field.label}
        {"required" in field && field.required ? <span className="text-rose-500 ml-0.5">*</span> : null}
      </label>
      {field.type === "text" && (
        <input
          type="text"
          className={baseInput}
          value={(value as string) ?? ""}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {field.type === "textarea" && (
        <textarea
          className={baseInput}
          rows={field.rows ?? 3}
          value={(value as string) ?? ""}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {field.type === "keywords" && (
        <input
          type="text"
          className={baseInput}
          value={Array.isArray(value) ? value.join(", ") : ""}
          placeholder={field.placeholder ?? "keyword1, keyword2"}
          onChange={(e) =>
            onChange(
              e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            )
          }
        />
      )}
      {field.type === "number" && (
        <input
          type="number"
          className={baseInput}
          value={typeof value === "number" ? value : ""}
          min={field.min}
          max={field.max}
          onChange={(e) => {
            const n = Number(e.target.value);
            onChange(Number.isFinite(n) ? n : 0);
          }}
        />
      )}
      {field.type === "select" && (
        <select
          className={baseInput}
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
        >
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
      {field.helper && <p className="text-[11px] text-gray-400 mt-1">{field.helper}</p>}
    </div>
  );
}

function initialValues(fields: FormFieldDef[]): FormValues {
  const out: FormValues = {};
  for (const f of fields) {
    if (f.type === "keywords") {
      const def = typeof f.default === "string"
        ? f.default.split(",").map((s) => s.trim()).filter(Boolean)
        : [];
      out[f.id] = def;
    } else if (f.type === "number") {
      out[f.id] = typeof f.default === "number" ? f.default : 0;
    } else {
      out[f.id] = typeof f.default === "string" ? f.default : "";
    }
  }
  return out;
}

function isFormValid(fields: FormFieldDef[], values: FormValues): boolean {
  for (const f of fields) {
    if (!("required" in f) || !f.required) continue;
    const v = values[f.id];
    if (v == null || v === "" || (Array.isArray(v) && v.length === 0)) return false;
  }
  return true;
}

// ─── Mini preview (unchanged from previous version) ──────────────

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
