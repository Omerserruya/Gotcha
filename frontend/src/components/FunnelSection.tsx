"use client";

/**
 * Funnel editor — embedded inside the AI employee configuration page.
 *
 * Funnels are scoped per department (or tenant-default when departmentId is
 * null). A Department picker at the top switches between scopes; the list
 * and editor reload automatically. The bot loads the active funnel for the
 * conversation's departmentId at every turn, falling back to the tenant-default
 * funnel when none exists for that department.
 *
 * Changes propagate within the 60s repo cache (or instantly on `ai` restart).
 */

import { useEffect, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { getDepartments } from "@/lib/api";
import {
  listFunnels,
  createFunnel,
  updateFunnel,
  activateFunnel,
  deleteFunnel,
  type FunnelRow,
  type FunnelStage,
  type ConversationStage,
} from "@/lib/api-funnel";

const BASE_STAGES: ConversationStage[] = ["initial", "exploration", "objection", "decision", "support"];

const SAAS_TEMPLATE: Pick<FunnelRow, "stages" | "transitions" | "strategyOverrides" | "playbookOverrides"> = {
  stages: [
    { id: "lead", label: "New Lead", baseStage: "initial" },
    { id: "demo", label: "Demo Scheduled", baseStage: "exploration", entry: { markers: ["demo", "see it in action", "דמו", "הדגמה"] } },
    { id: "qualified", label: "Qualified", baseStage: "exploration", entry: { intents: ["informational", "transactional"] } },
    { id: "objection", label: "Objection", baseStage: "objection" },
    { id: "closing", label: "Closing", baseStage: "decision" },
  ],
  transitions: [
    { from: "lead", to: "qualified", when: { intents: ["informational", "transactional"] } },
    { from: "qualified", to: "demo", when: { markers: ["demo", "הדגמה"] } },
    { from: "demo", to: "closing", when: { intents: ["transactional"] } },
    { from: "qualified", to: "objection", when: { markers: ["expensive", "יקר", "but"] } },
  ],
  strategyOverrides: [
    { match: { stageId: "demo", intent: "informational" }, strategy: "CONVERT", reason: "demo-stage informational → push toward booking" },
  ],
  playbookOverrides: [
    { match: { stageId: "qualified", strategy: "QUALIFY" }, playbookIds: ["lead_qualification", "demo_request"], reason: "qualified-stage QUALIFY → emphasize demo path" },
  ],
};

interface Department {
  id: string;
  name: string;
}

/** No props — the department scope is picked inside this component. */
export interface FunnelSectionProps {}

export default function FunnelSection(_props: FunnelSectionProps) {
  const { token } = useAuth();
  const [departments, setDepartments] = useState<Department[]>([]);
  // null = tenant default; string = department id.
  const [selectedDeptId, setSelectedDeptId] = useState<string | null>(null);
  const [rows, setRows] = useState<FunnelRow[]>([]);
  const [editing, setEditing] = useState<FunnelRow | "new" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Load department list once on mount.
  useEffect(() => {
    if (!token) return;
    getDepartments(token)
      .then((r) => setDepartments(r.data || []))
      .catch(() => { /* non-fatal — picker will only show "Tenant default" */ });
  }, [token]);

  async function refresh() {
    if (!token) return;
    try {
      const r = await listFunnels(token, selectedDeptId);
      setRows(r.data);
    } catch (e: any) {
      setErr(e.message);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, selectedDeptId]);

  const selectedDeptName =
    selectedDeptId === null
      ? "Tenant default"
      : departments.find((d) => d.id === selectedDeptId)?.name ?? selectedDeptId;

  return (
    <div className="space-y-4">
      <header className="flex items-start justify-between gap-4">
        <div className="flex-1 space-y-2">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-700 shrink-0">Department scope</label>
            <select
              className="border rounded px-2 py-1 text-sm"
              value={selectedDeptId ?? "__default__"}
              onChange={(e) => {
                setSelectedDeptId(e.target.value === "__default__" ? null : e.target.value);
                setEditing(null);
              }}
            >
              <option value="__default__">Tenant default</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </div>
          <p className="text-xs text-gray-500">
            Showing funnels for <strong>{selectedDeptName}</strong>. The BEL loads the active funnel for a
            conversation&apos;s department, falling back to the tenant-default when none is configured.
          </p>
        </div>
        <button
          className="px-3 py-1.5 rounded-md bg-gray-900 text-white text-sm shrink-0"
          onClick={() => setEditing("new")}
        >
          + New funnel
        </button>
      </header>

      {err && (
        <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">{err}</div>
      )}

      <div className="border rounded-xl divide-y bg-white">
        {rows.length === 0 && (
          <div className="px-4 py-6 text-sm text-gray-500 text-center">
            No funnels yet for <strong>{selectedDeptName}</strong>. Click <strong>New funnel</strong> and load
            the SaaS template inside the editor.
          </div>
        )}
        {rows.map((r) => (
          <div key={r.id} className="px-4 py-3 flex items-center justify-between">
            <div className="min-w-0 pr-3">
              <div className="font-medium text-gray-900 truncate">
                {r.funnelId}
                {r.isActive && (
                  <span className="ml-2 inline-block text-xs px-2 py-0.5 rounded bg-emerald-100 text-emerald-700">
                    Active
                  </span>
                )}
              </div>
              <div className="text-xs text-gray-600 truncate">
                {r.stages.length} stages · {r.transitions.length} transitions ·{" "}
                {r.strategyOverrides?.length || 0} strategy overrides ·{" "}
                {r.playbookOverrides?.length || 0} playbook overrides
              </div>
            </div>
            <div className="flex gap-2 shrink-0">
              {!r.isActive && (
                <button
                  className="text-sm text-emerald-700"
                  onClick={async () => {
                    if (!token) return;
                    await activateFunnel(token, r.id);
                    await refresh();
                  }}
                >
                  Activate
                </button>
              )}
              <button className="text-sm text-blue-600" onClick={() => setEditing(r)}>Edit</button>
              <button
                className="text-sm text-red-600"
                onClick={async () => {
                  if (!token) return;
                  if (confirm("Delete this funnel?")) {
                    await deleteFunnel(token, r.id);
                    await refresh();
                  }
                }}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <Editor
          departmentId={selectedDeptId}
          departmentName={selectedDeptName}
          initial={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSave={async (body) => {
            if (!token) return;
            if (editing === "new") await createFunnel(token, body);
            else await updateFunnel(token, editing.id, body);
            await refresh();
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function Editor(props: {
  departmentId: string | null;
  departmentName: string;
  initial: FunnelRow | null;
  onClose: () => void;
  onSave: (body: Partial<FunnelRow>) => Promise<void>;
}) {
  const [funnelId, setFunnelId] = useState(props.initial?.funnelId || "");
  const [stages, setStages] = useState<FunnelStage[]>(props.initial?.stages || []);
  const [transitionsJson, setTransitionsJson] = useState(JSON.stringify(props.initial?.transitions ?? [], null, 2));
  const [strategyJson, setStrategyJson] = useState(JSON.stringify(props.initial?.strategyOverrides ?? [], null, 2));
  const [playbookJson, setPlaybookJson] = useState(JSON.stringify(props.initial?.playbookOverrides ?? [], null, 2));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function loadTemplate() {
    setStages(SAAS_TEMPLATE.stages);
    setTransitionsJson(JSON.stringify(SAAS_TEMPLATE.transitions, null, 2));
    setStrategyJson(JSON.stringify(SAAS_TEMPLATE.strategyOverrides, null, 2));
    setPlaybookJson(JSON.stringify(SAAS_TEMPLATE.playbookOverrides, null, 2));
  }
  function addStage() {
    setStages((p) => [...p, { id: `stage_${p.length + 1}`, label: `Stage ${p.length + 1}`, baseStage: "exploration" }]);
  }
  function updateStage(idx: number, patch: Partial<FunnelStage>) {
    setStages((p) => p.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  }
  function removeStage(idx: number) {
    setStages((p) => p.filter((_, i) => i !== idx));
  }
  function moveStage(idx: number, dir: -1 | 1) {
    setStages((p) => {
      const next = [...p]; const j = idx + dir;
      if (j < 0 || j >= next.length) return p;
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  }
  function setStageEntry(idx: number, key: "intents" | "userTypes" | "markers", value: string) {
    setStages((p) =>
      p.map((s, i) => {
        if (i !== idx) return s;
        const entry = { ...(s.entry ?? {}) };
        const arr = value.split(",").map((x) => x.trim()).filter(Boolean);
        if (arr.length === 0) delete (entry as any)[key];
        else (entry as any)[key] = arr;
        return { ...s, entry: Object.keys(entry).length === 0 ? undefined : entry };
      }),
    );
  }

  async function save() {
    setErr(null);
    let transitions, strategyOverrides, playbookOverrides;
    try {
      transitions = JSON.parse(transitionsJson || "[]");
      strategyOverrides = JSON.parse(strategyJson || "[]");
      playbookOverrides = JSON.parse(playbookJson || "[]");
    } catch (e: any) {
      setErr(`Invalid JSON: ${e.message}`); return;
    }
    setBusy(true);
    try {
      if (props.initial) {
        await props.onSave({ stages, transitions, strategyOverrides, playbookOverrides });
      } else {
        await props.onSave({ funnelId, departmentId: props.departmentId, stages, transitions, strategyOverrides, playbookOverrides });
      }
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/30 flex items-end md:items-center justify-center p-2">
      <div className="bg-white w-full md:max-w-2xl rounded-2xl p-5 space-y-4 max-h-[92vh] overflow-y-auto">
        <header className="flex items-start justify-between">
          <h3 className="text-lg font-medium">
            {props.initial
              ? `Edit funnel: ${props.initial.funnelId}`
              : `New funnel — ${props.departmentName}`}
          </h3>
          {!props.initial && (
            <button className="text-xs text-blue-600" onClick={loadTemplate}>Load SaaS template</button>
          )}
        </header>

        {err && <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">{err}</div>}

        {!props.initial && (
          <Field label="Funnel id">
            <input
              className="w-full border rounded px-2 py-1 text-sm font-mono"
              placeholder="saas-default"
              value={funnelId}
              onChange={(e) => setFunnelId(e.target.value)}
            />
          </Field>
        )}

        <fieldset className="border rounded p-3 space-y-2">
          <legend className="text-sm font-medium px-1">Stages <span className="text-xs text-gray-500">(order matters — first match wins)</span></legend>
          {stages.length === 0 && <div className="text-xs text-gray-400 italic">No stages yet.</div>}
          {stages.map((s, idx) => (
            <div key={idx} className="border rounded p-2 space-y-1.5 bg-gray-50">
              <div className="flex items-center gap-2">
                <input className="border rounded px-2 py-1 text-xs font-mono w-32"
                  value={s.id} onChange={(e) => updateStage(idx, { id: e.target.value })} placeholder="stage_id" />
                <input className="border rounded px-2 py-1 text-xs flex-1"
                  value={s.label} onChange={(e) => updateStage(idx, { label: e.target.value })} placeholder="Display label" />
                <select className="border rounded px-2 py-1 text-xs"
                  value={s.baseStage}
                  onChange={(e) => updateStage(idx, { baseStage: e.target.value as ConversationStage })}>
                  {BASE_STAGES.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
                <button className="text-xs text-gray-500" onClick={() => moveStage(idx, -1)}>↑</button>
                <button className="text-xs text-gray-500" onClick={() => moveStage(idx, 1)}>↓</button>
                <button className="text-xs text-red-500" onClick={() => removeStage(idx)}>×</button>
              </div>
              <div className="grid grid-cols-3 gap-2 text-xs">
                <label className="flex flex-col gap-0.5">
                  <span className="text-gray-500">Entry intents</span>
                  <input className="border rounded px-2 py-1 font-mono" placeholder="informational, transactional"
                    value={s.entry?.intents?.join(", ") ?? ""}
                    onChange={(e) => setStageEntry(idx, "intents", e.target.value)} />
                </label>
                <label className="flex flex-col gap-0.5">
                  <span className="text-gray-500">Entry user types</span>
                  <input className="border rounded px-2 py-1 font-mono" placeholder="new_lead, returning"
                    value={s.entry?.userTypes?.join(", ") ?? ""}
                    onChange={(e) => setStageEntry(idx, "userTypes", e.target.value)} />
                </label>
                <label className="flex flex-col gap-0.5">
                  <span className="text-gray-500">Entry markers</span>
                  <input className="border rounded px-2 py-1" placeholder="demo, הדגמה"
                    value={s.entry?.markers?.join(", ") ?? ""}
                    onChange={(e) => setStageEntry(idx, "markers", e.target.value)} />
                </label>
              </div>
            </div>
          ))}
          <button className="text-sm text-blue-600" onClick={addStage}>+ Add stage</button>
        </fieldset>

        <Field label="Transitions (JSON)">
          <textarea className="w-full border rounded px-2 py-1 text-xs font-mono min-h-[120px]"
            value={transitionsJson} onChange={(e) => setTransitionsJson(e.target.value)} />
          <Hint>{`[{ "from":"lead", "to":"qualified", "when":{"intents":["informational"]} }]`}</Hint>
        </Field>

        <Field label="Strategy overrides (JSON)">
          <textarea className="w-full border rounded px-2 py-1 text-xs font-mono min-h-[120px]"
            value={strategyJson} onChange={(e) => setStrategyJson(e.target.value)} />
          <Hint>{`[{ "match":{"stageId":"demo","intent":"informational"}, "strategy":"CONVERT", "reason":"…" }]`}</Hint>
        </Field>

        <Field label="Playbook overrides (JSON)">
          <textarea className="w-full border rounded px-2 py-1 text-xs font-mono min-h-[100px]"
            value={playbookJson} onChange={(e) => setPlaybookJson(e.target.value)} />
          <Hint>{`[{ "match":{"stageId":"qualified","strategy":"QUALIFY"}, "playbookIds":["lead_qualification","demo_request"], "reason":"…" }]`}</Hint>
        </Field>

        <div className="flex justify-end gap-2 pt-2">
          <button className="px-3 py-1.5 rounded border text-sm" onClick={props.onClose}>Cancel</button>
          <button
            disabled={busy || (!props.initial && !funnelId) || stages.length === 0}
            className="px-3 py-1.5 rounded bg-gray-900 text-white text-sm disabled:opacity-50"
            onClick={save}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-gray-700 block mb-1">{label}</span>
      {children}
    </label>
  );
}
function Hint({ children }: { children: React.ReactNode }) {
  return <span className="block text-[10px] text-gray-400 font-mono mt-1">{children}</span>;
}
