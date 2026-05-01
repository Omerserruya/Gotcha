"use client";

import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { useAuth } from "@/context/AuthContext";
import {
  listToolPermissions,
  updateToolPermission,
  type ToolPermissionRow,
} from "@/lib/gotcha-api";

type KindFilter = "action" | "integration" | "system" | "all";

const KIND_LABEL: Record<ToolPermissionRow["kind"], string> = {
  action: "Action",
  integration: "Integration",
  system: "Read-only",
};

const CATEGORY_LABEL: Record<string, string> = {
  messaging: "Messaging",
  crm: "CRM",
  broadcast: "Broadcast",
  workflow: "Workflow",
  identity: "Identity",
  memory: "Memory",
  knowledge: "Knowledge",
  meta: "Integration",
};

export default function ToolPermissionsPage() {
  const { token } = useAuth();
  const [rows, setRows] = useState<ToolPermissionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<KindFilter>("action");
  const [savingTool, setSavingTool] = useState<string | null>(null);

  async function load() {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await listToolPermissions(token);
      setRows(res.data ?? []);
    } catch (e: any) {
      setError(e?.message ?? "failed to load");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const filtered = useMemo(() => {
    if (kindFilter === "all") return rows;
    return rows.filter((r) => r.kind === kindFilter);
  }, [rows, kindFilter]);

  const grouped = useMemo(() => {
    const map = new Map<string, ToolPermissionRow[]>();
    for (const r of filtered) {
      const key = r.category;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  async function patchTool(
    row: ToolPermissionRow,
    patch: Partial<Pick<ToolPermissionRow, "enabled" | "requiresApproval">>,
  ) {
    if (!token) return;
    setSavingTool(row.toolName);
    const previous = rows;
    setRows((rs) =>
      rs.map((r) =>
        r.toolName === row.toolName ? { ...r, ...patch, isDefault: false } : r,
      ),
    );
    try {
      await updateToolPermission(token, row.toolName, patch);
    } catch (e: any) {
      setRows(previous);
      setError(e?.message ?? "save failed");
    } finally {
      setSavingTool(null);
    }
  }

  if (!token) return null;

  const counts = {
    action: rows.filter((r) => r.kind === "action").length,
    integration: rows.filter((r) => r.kind === "integration").length,
    system: rows.filter((r) => r.kind === "system").length,
    all: rows.length,
  };

  return (
      <div className="p-6 max-w-5xl">
        <header className="mb-5">
          <h1 className="text-xl font-semibold text-gray-900">Tool Permissions</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Per-tenant control over which tools the AI can use, and which ones pause for human
            approval. Applies to bot-initiated actions, planner executions, and copilot
            suggestions.
          </p>
        </header>

        <div className="flex items-center gap-1 border-b border-gray-200 mb-4">
          {(["action", "integration", "system", "all"] as KindFilter[]).map((k) => (
            <button
              key={k}
              onClick={() => setKindFilter(k)}
              className={clsx(
                "px-4 py-2 text-sm font-medium -mb-px border-b-2 transition capitalize",
                kindFilter === k
                  ? "text-violet-700 border-violet-600"
                  : "text-gray-500 border-transparent hover:text-gray-700",
              )}
            >
              {k === "system" ? "Read-only" : k} ({counts[k]})
            </button>
          ))}
        </div>

        {error && (
          <div className="mb-3 px-4 py-2 text-sm bg-red-50 border border-red-200 text-red-700 rounded-lg">
            {error}
          </div>
        )}

        {loading && rows.length === 0 && (
          <div className="text-sm text-gray-500 py-8 text-center">Loading tools…</div>
        )}

        <div className="space-y-5">
          {grouped.map(([category, list]) => (
            <section key={category}>
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-2">
                {CATEGORY_LABEL[category] ?? category}
              </h2>
              <div className="bg-white rounded-xl shadow-subtle border border-gray-100 overflow-hidden">
                {list.map((row, i) => (
                  <div
                    key={row.toolName}
                    className={clsx(
                      "px-4 py-3 flex items-start gap-4",
                      i > 0 && "border-t border-gray-100",
                    )}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <code className="text-sm font-mono text-gray-900">{row.toolName}</code>
                        <KindChip kind={row.kind} />
                        {row.isDefault && (
                          <span className="text-[10px] text-gray-400 italic">(default)</span>
                        )}
                      </div>
                      <p className="text-xs text-gray-500">{row.description}</p>
                    </div>
                    <div className="flex items-center gap-6 shrink-0 pt-0.5">
                      <ToggleLabel
                        label="Enabled"
                        checked={row.enabled}
                        disabled={savingTool === row.toolName}
                        onChange={(v) => patchTool(row, { enabled: v })}
                      />
                      <ToggleLabel
                        label="HITL"
                        hint="Pause for human approval"
                        checked={row.requiresApproval}
                        disabled={!row.enabled || savingTool === row.toolName}
                        onChange={(v) => patchTool(row, { requiresApproval: v })}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
          {!loading && filtered.length === 0 && (
            <div className="bg-white rounded-xl shadow-subtle p-10 text-center text-sm text-gray-500">
              No tools in this category.
            </div>
          )}
        </div>
      </div>
  );
}

function KindChip({ kind }: { kind: ToolPermissionRow["kind"] }) {
  const style =
    kind === "action"
      ? "bg-violet-50 text-violet-700 border-violet-100"
      : kind === "integration"
      ? "bg-blue-50 text-blue-700 border-blue-100"
      : "bg-gray-50 text-gray-600 border-gray-200";
  return (
    <span className={`text-[10px] font-medium px-1.5 py-0.5 border rounded ${style}`}>
      {KIND_LABEL[kind]}
    </span>
  );
}

function ToggleLabel({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex flex-col items-center">
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(!checked)}
        title={hint}
        className={clsx(
          "relative h-5 w-9 shrink-0 rounded-full transition-colors",
          checked ? "bg-violet-600" : "bg-gray-200",
          disabled && "opacity-40 cursor-not-allowed",
        )}
      >
        <span
          className={clsx(
            "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all",
            checked ? "left-[18px]" : "left-0.5",
          )}
        />
      </button>
      <span className="text-[10px] text-gray-500 mt-1">{label}</span>
    </div>
  );
}
