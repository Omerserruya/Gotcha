"use client";

import { Handle, Position, NodeProps } from "reactflow";
import { useState } from "react";

type ConditionType = "intent" | "keyword" | "regex" | "sentiment" | "time" | "attribute";
type Operator = "equals" | "contains" | "matches" | "is_not" | "starts_with" | "ends_with";
type Logic = "AND" | "OR";

interface ConditionRow {
  id: string;
  type: ConditionType;
  operator: Operator;
  value: string;
}

const TYPE_OPTIONS: { value: ConditionType; label: string }[] = [
  { value: "intent", label: "AI Intent" },
  { value: "keyword", label: "Keyword" },
  { value: "regex", label: "Regex Pattern" },
  { value: "sentiment", label: "Sentiment" },
  { value: "time", label: "Time / Schedule" },
  { value: "attribute", label: "Customer Attribute" },
];

const OPERATOR_OPTIONS: Record<ConditionType, { value: Operator; label: string }[]> = {
  intent:    [{ value: "equals", label: "equals" }, { value: "contains", label: "contains" }, { value: "is_not", label: "is not" }],
  keyword:   [{ value: "contains", label: "contains" }, { value: "equals", label: "equals" }, { value: "starts_with", label: "starts with" }, { value: "ends_with", label: "ends with" }, { value: "is_not", label: "does not contain" }],
  regex:     [{ value: "matches", label: "matches" }, { value: "is_not", label: "does not match" }],
  sentiment: [{ value: "equals", label: "is" }, { value: "is_not", label: "is not" }],
  time:      [{ value: "equals", label: "is" }, { value: "is_not", label: "is not" }],
  attribute: [{ value: "equals", label: "equals" }, { value: "contains", label: "contains" }, { value: "is_not", label: "is not" }],
};

const inputClass = "w-full text-xs border border-gray-200 bg-gray-50/50 rounded-lg px-2.5 py-1.5 focus:ring-2 focus:ring-amber-400/30 focus:border-amber-300 outline-none transition";

export function ConditionGroupNode({ data }: NodeProps) {
  const [name, setName] = useState<string>(data.name || "Condition");
  const [logic, setLogic] = useState<Logic>(data.logic || "AND");
  const [conditions, setConditions] = useState<ConditionRow[]>(
    data.conditions?.length > 0
      ? data.conditions
      : [{ id: `c_${Date.now()}`, type: "intent" as ConditionType, operator: "equals" as Operator, value: "" }]
  );

  function sync(name: string, logic: Logic, conds: ConditionRow[]) {
    data.name = name;
    data.logic = logic;
    data.conditions = conds;
  }

  function updateCondition(id: string, patch: Partial<ConditionRow>) {
    const updated = conditions.map((c) => (c.id === id ? { ...c, ...patch } : c));
    setConditions(updated);
    sync(name, logic, updated);
  }

  function addCondition() {
    const newCond: ConditionRow = { id: `c_${Date.now()}`, type: "keyword", operator: "contains", value: "" };
    const updated = [...conditions, newCond];
    setConditions(updated);
    sync(name, logic, updated);
  }

  function removeCondition(id: string) {
    if (conditions.length <= 1) return;
    const updated = conditions.filter((c) => c.id !== id);
    setConditions(updated);
    sync(name, logic, updated);
  }

  function toggleLogic() {
    const next = logic === "AND" ? "OR" : "AND";
    setLogic(next);
    sync(name, next, conditions);
  }

  return (
    <div className="bg-white rounded-2xl shadow-lg shadow-amber-100/40 border border-amber-200/60 min-w-[280px] max-w-[320px] ring-1 ring-amber-100/50 transition-shadow hover:shadow-xl">
      <Handle type="target" position={Position.Left} className="!bg-amber-500 !w-3 !h-3 !border-2 !border-white !shadow-sm" />

      {/* Header */}
      <div className="bg-gradient-to-r from-amber-400 to-amber-500 text-white px-3.5 py-2 rounded-t-2xl text-xs font-semibold flex items-center gap-2">
        <div className="w-5 h-5 rounded-md bg-white/20 flex items-center justify-center">
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
          </svg>
        </div>
        <input
          value={name}
          onChange={(e) => { setName(e.target.value); sync(e.target.value, logic, conditions); }}
          className="bg-transparent text-white placeholder-white/50 text-xs font-semibold outline-none flex-1 min-w-0"
          placeholder="Condition name..."
        />
      </div>

      {/* Conditions */}
      <div className="p-3 space-y-2">
        {conditions.map((cond, idx) => (
          <div key={cond.id}>
            {idx > 0 && (
              <button
                onClick={toggleLogic}
                className="mx-auto mb-1.5 block px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-700 hover:bg-amber-200 transition"
              >
                {logic}
              </button>
            )}
            <div className="space-y-1.5 bg-amber-50/40 rounded-lg p-2 border border-amber-100/60 relative group">
              {conditions.length > 1 && (
                <button
                  onClick={() => removeCondition(cond.id)}
                  className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-red-100 text-red-500 items-center justify-center text-[10px] hidden group-hover:flex hover:bg-red-200 transition"
                >
                  x
                </button>
              )}
              <select
                value={cond.type}
                onChange={(e) => {
                  const newType = e.target.value as ConditionType;
                  const newOps = OPERATOR_OPTIONS[newType];
                  updateCondition(cond.id, { type: newType, operator: newOps[0].value });
                }}
                className={inputClass}
              >
                {TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <select
                value={cond.operator}
                onChange={(e) => updateCondition(cond.id, { operator: e.target.value as Operator })}
                className={inputClass}
              >
                {(OPERATOR_OPTIONS[cond.type] || OPERATOR_OPTIONS.keyword).map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              {cond.type === "sentiment" ? (
                <select
                  value={cond.value}
                  onChange={(e) => updateCondition(cond.id, { value: e.target.value })}
                  className={inputClass}
                >
                  <option value="">Select...</option>
                  <option value="positive">Positive</option>
                  <option value="neutral">Neutral</option>
                  <option value="negative">Negative</option>
                </select>
              ) : cond.type === "time" ? (
                <select
                  value={cond.value}
                  onChange={(e) => updateCondition(cond.id, { value: e.target.value })}
                  className={inputClass}
                >
                  <option value="">Select...</option>
                  <option value="business_hours">Business Hours</option>
                  <option value="after_hours">After Hours</option>
                  <option value="weekend">Weekend</option>
                </select>
              ) : (
                <input
                  type="text"
                  value={cond.value}
                  onChange={(e) => updateCondition(cond.id, { value: e.target.value })}
                  placeholder={cond.type === "regex" ? "e.g. ^order\\s+\\d+" : cond.type === "intent" ? "e.g. sales, support..." : "Value..."}
                  className={inputClass}
                />
              )}
            </div>
          </div>
        ))}

        <button
          onClick={addCondition}
          className="w-full py-1.5 rounded-lg border border-dashed border-amber-300 text-amber-600 text-[10px] font-semibold hover:bg-amber-50 transition flex items-center justify-center gap-1"
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Add condition
        </button>
      </div>

      {/* Output handles */}
      <div className="relative flex justify-between px-4 pb-3">
        <div className="flex flex-col items-center gap-1">
          <span className="text-[10px] font-semibold text-emerald-600 bg-emerald-50 border border-emerald-200 rounded-md px-1.5 py-0.5">Match</span>
          <Handle
            type="source"
            position={Position.Bottom}
            id="true"
            className="!bg-emerald-500 !w-3 !h-3 !border-2 !border-white !shadow-sm !static !transform-none"
          />
        </div>
        <div className="flex flex-col items-center gap-1">
          <span className="text-[10px] font-semibold text-rose-600 bg-rose-50 border border-rose-200 rounded-md px-1.5 py-0.5">No Match</span>
          <Handle
            type="source"
            position={Position.Bottom}
            id="false"
            className="!bg-rose-500 !w-3 !h-3 !border-2 !border-white !shadow-sm !static !transform-none"
          />
        </div>
      </div>
    </div>
  );
}
