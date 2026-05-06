"use client";

/**
 * Action Contracts editor — embedded inside the AI agent detail page.
 *
 * Tenant-scoped: contracts apply to all bots in the tenant. The bot
 * loads them every turn and the BEL strips the tool surface to only
 * the pending tools when blocking=true. Tenants edit the trigger label,
 * the required tools (multi-select), the execution mode, and (for
 * SEQUENCE) the strict order.
 */

import { useEffect, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import {
  listActionContracts,
  createActionContract,
  updateActionContract,
  deleteActionContract,
  STANDARD_TRIGGERS,
  type ActionContractRow,
  type ExecutionMode,
} from "@/lib/api-action-contracts";

const KNOWN_TOOLS: Array<{ name: string; label: string }> = [
  { name: "schedule_meeting", label: "Schedule meeting (calendar)" },
  { name: "schedule_followup", label: "Schedule follow-up message" },
  { name: "close_conversation", label: "Close conversation" },
  { name: "link_customer_identifier", label: "Link customer identifier" },
  { name: "escalate_to_human", label: "Escalate to human" },
  { name: "integration_create_lead", label: "CRM — create lead" },
  { name: "integration_update_lead", label: "CRM — update lead" },
  { name: "integration_add_lead_note", label: "CRM — add note" },
  { name: "refund_payment", label: "Payments — refund (if connected)" },
  { name: "create_ticket", label: "Helpdesk — create ticket (if connected)" },
];

export default function ActionContractsSection() {
  const { token } = useAuth();
  const [rows, setRows] = useState<ActionContractRow[]>([]);
  const [editing, setEditing] = useState<ActionContractRow | "new" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    if (!token) return;
    try {
      const r = await listActionContracts(token);
      setRows(r.data);
    } catch (e: any) { setErr(e.message); }
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [token]);

  return (
    <div className="space-y-4">
      <header className="flex items-start justify-between">
        <div>
          <p className="text-xs text-gray-500">
            Deterministic tool chains. When a trigger fires, the bot is forced to call the listed tools — no skipping, no reordering.
            <br />Pending blocking contracts strip the bot's tool surface to ONLY the next required tool.
          </p>
        </div>
        <button
          className="px-3 py-1.5 rounded-md bg-gray-900 text-white text-sm shrink-0"
          onClick={() => setEditing("new")}
        >+ New contract</button>
      </header>

      {err && <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">{err}</div>}

      <div className="border rounded-xl divide-y bg-white">
        {rows.length === 0 && (
          <div className="px-4 py-6 text-sm text-gray-500 text-center">
            No contracts yet. Click <strong>New contract</strong> to define one.
          </div>
        )}
        {rows.map((r) => (
          <div key={r.id} className="px-4 py-3 flex items-center justify-between">
            <div className="min-w-0 pr-3">
              <div className="font-medium text-gray-900 truncate">
                {r.trigger}
                <span className="ml-2 text-xs font-mono text-gray-500">{r.executionMode}</span>
                {r.blocking && (
                  <span className="ml-2 inline-block text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-800">blocking</span>
                )}
                {!r.isActive && <span className="ml-2 text-xs text-red-600">(inactive)</span>}
              </div>
              <div className="text-xs text-gray-600 truncate">
                Tools: {r.requiredTools.map((t) => `${t.name}`).join(" → ")}
              </div>
            </div>
            <div className="flex gap-2 shrink-0">
              <button className="text-sm text-blue-600" onClick={() => setEditing(r)}>Edit</button>
              <button
                className="text-sm text-red-600"
                onClick={async () => {
                  if (!token) return;
                  if (confirm(`Delete contract for ${r.trigger}?`)) {
                    await deleteActionContract(token, r.id);
                    await refresh();
                  }
                }}
              >Delete</button>
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <Editor
          initial={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSave={async (body) => {
            if (!token) return;
            if (editing === "new") await createActionContract(token, body);
            else await updateActionContract(token, editing.id, body);
            await refresh();
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function Editor(props: {
  initial: ActionContractRow | null;
  onClose: () => void;
  onSave: (body: Partial<ActionContractRow>) => Promise<void>;
}) {
  const [trigger, setTrigger] = useState(props.initial?.trigger || STANDARD_TRIGGERS[0].value);
  const [customTrigger, setCustomTrigger] = useState(
    !props.initial ? "" : (STANDARD_TRIGGERS.some((t) => t.value === props.initial?.trigger) ? "" : props.initial.trigger),
  );
  const [requiredTools, setRequiredTools] = useState<string[]>(
    props.initial?.requiredTools.map((t) => t.name) || [],
  );
  const [executionMode, setExecutionMode] = useState<ExecutionMode>(props.initial?.executionMode || "ALL_REQUIRED");
  const [blocking, setBlocking] = useState(props.initial?.blocking ?? true);
  const [isActive, setIsActive] = useState(props.initial?.isActive ?? true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const isCustom = trigger === "__custom__";
  const finalTrigger = isCustom ? customTrigger.trim() : trigger;

  function toggleTool(name: string) {
    setRequiredTools((prev) => prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]);
  }
  function moveTool(idx: number, dir: -1 | 1) {
    setRequiredTools((prev) => {
      const next = [...prev];
      const j = idx + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  }

  async function save() {
    setErr(null);
    if (!finalTrigger) { setErr("Trigger is required"); return; }
    if (requiredTools.length === 0) { setErr("Pick at least one required tool"); return; }
    setBusy(true);
    try {
      const body: Partial<ActionContractRow> = {
        trigger: finalTrigger,
        requiredTools: requiredTools.map((name) => ({ name })),
        executionMode,
        order: executionMode === "SEQUENCE" ? requiredTools : null,
        blocking,
        isActive,
      };
      await props.onSave(body);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/30 flex items-end md:items-center justify-center p-2">
      <div className="bg-white w-full md:max-w-lg rounded-2xl p-5 space-y-4 max-h-[90vh] overflow-y-auto">
        <h3 className="text-lg font-medium">{props.initial ? `Edit contract: ${props.initial.trigger}` : "New action contract"}</h3>

        {err && <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">{err}</div>}

        <Field label="Trigger">
          <select
            disabled={!!props.initial}
            className="w-full border rounded px-2 py-1 text-sm"
            value={trigger}
            onChange={(e) => setTrigger(e.target.value)}
          >
            {STANDARD_TRIGGERS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            <option value="__custom__">Custom…</option>
          </select>
          {isCustom && (
            <input
              disabled={!!props.initial}
              className="mt-1 w-full border rounded px-2 py-1 text-sm font-mono"
              placeholder="custom_trigger_name"
              value={customTrigger}
              onChange={(e) => setCustomTrigger(e.target.value)}
            />
          )}
        </Field>

        <Field label="Required tools">
          <p className="text-xs text-gray-500 mb-1">
            Tick the tools that MUST execute when this trigger fires.
            {executionMode === "SEQUENCE" && " Use ↑↓ to set strict order."}
          </p>
          <div className="border rounded divide-y max-h-56 overflow-y-auto">
            {KNOWN_TOOLS.map((t) => {
              const checked = requiredTools.includes(t.name);
              return (
                <label key={t.name} className="flex items-center gap-2 px-2 py-1 text-sm cursor-pointer hover:bg-gray-50">
                  <input type="checkbox" checked={checked} onChange={() => toggleTool(t.name)} />
                  <span className="font-mono text-xs text-gray-700">{t.name}</span>
                  <span className="text-xs text-gray-500 truncate">— {t.label}</span>
                </label>
              );
            })}
          </div>
          {executionMode === "SEQUENCE" && requiredTools.length > 0 && (
            <div className="mt-2 border rounded p-2 bg-gray-50">
              <div className="text-xs text-gray-600 mb-1">Order:</div>
              {requiredTools.map((name, idx) => (
                <div key={name} className="flex items-center gap-2 text-xs py-0.5">
                  <span className="w-5 text-gray-500">{idx + 1}.</span>
                  <span className="flex-1 font-mono">{name}</span>
                  <button className="text-gray-500" onClick={() => moveTool(idx, -1)}>↑</button>
                  <button className="text-gray-500" onClick={() => moveTool(idx, 1)}>↓</button>
                </div>
              ))}
            </div>
          )}
        </Field>

        <Field label="Execution mode">
          <select
            className="w-full border rounded px-2 py-1 text-sm"
            value={executionMode}
            onChange={(e) => setExecutionMode(e.target.value as ExecutionMode)}
          >
            <option value="ALL_REQUIRED">All required (any order)</option>
            <option value="SEQUENCE">Sequence (strict order)</option>
            <option value="AT_LEAST_ONE">At least one</option>
          </select>
        </Field>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={blocking} onChange={(e) => setBlocking(e.target.checked)} />
          Block conversation until completed
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
          Active (bot enforces this contract)
        </label>

        <div className="flex justify-end gap-2 pt-2">
          <button className="px-3 py-1.5 rounded border text-sm" onClick={props.onClose}>Cancel</button>
          <button
            disabled={busy}
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
