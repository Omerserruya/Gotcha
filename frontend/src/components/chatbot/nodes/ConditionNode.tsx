"use client";

import { Handle, Position, NodeProps } from "reactflow";
import { useState } from "react";

export function ConditionNode({ data }: NodeProps) {
  const [field, setField] = useState<string>(data.field || "intent");
  const [operator, setOperator] = useState<string>(data.operator || "equals");
  const [value, setValue] = useState<string>(data.value || "");

  function update(key: "field" | "operator" | "value", val: string) {
    if (key === "field") { setField(val); data.field = val; }
    if (key === "operator") { setOperator(val); data.operator = val; }
    if (key === "value") { setValue(val); data.value = val; }
  }

  return (
    <div className="bg-white rounded-2xl shadow-lg shadow-amber-100/40 border border-amber-200/60 min-w-[220px] ring-1 ring-amber-100/50 transition-shadow hover:shadow-xl hover:shadow-amber-100/50">
      <Handle type="target" position={Position.Top} className="!bg-amber-500 !w-3 !h-3 !border-2 !border-white !shadow-sm" />
      <div className="bg-gradient-to-r from-amber-400 to-amber-500 text-white px-3.5 py-2 rounded-t-2xl text-xs font-semibold flex items-center gap-2">
        <div className="w-5 h-5 rounded-md bg-white/20 flex items-center justify-center">
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
          </svg>
        </div>
        Condition
      </div>
      <div className="p-3 space-y-2">
        <select
          value={field}
          onChange={(e) => update("field", e.target.value)}
          className="w-full text-xs border border-amber-200/60 bg-amber-50/30 rounded-lg px-2.5 py-1.5 focus:ring-2 focus:ring-amber-400/30 focus:border-amber-300 outline-none transition"
        >
          <option value="intent">Intent</option>
          <option value="keyword">Keyword</option>
          <option value="channel">Channel</option>
        </select>
        <select
          value={operator}
          onChange={(e) => update("operator", e.target.value)}
          className="w-full text-xs border border-amber-200/60 bg-amber-50/30 rounded-lg px-2.5 py-1.5 focus:ring-2 focus:ring-amber-400/30 focus:border-amber-300 outline-none transition"
        >
          <option value="equals">Equals</option>
          <option value="contains">Contains</option>
          <option value="is_not">Is not</option>
        </select>
        <input
          type="text"
          value={value}
          onChange={(e) => update("value", e.target.value)}
          placeholder="Value..."
          className="w-full text-xs border border-amber-200/60 bg-amber-50/30 rounded-lg px-2.5 py-1.5 focus:ring-2 focus:ring-amber-400/30 focus:border-amber-300 outline-none transition"
        />
      </div>
      <div className="relative flex justify-between px-4 pb-3">
        <div className="flex flex-col items-center gap-1">
          <span className="text-[10px] font-semibold text-emerald-600 bg-emerald-50 border border-emerald-200 rounded-md px-1.5 py-0.5">True</span>
          <Handle
            type="source"
            position={Position.Bottom}
            id="true"
            className="!bg-emerald-500 !w-3 !h-3 !border-2 !border-white !shadow-sm !static !transform-none"
          />
        </div>
        <div className="flex flex-col items-center gap-1">
          <span className="text-[10px] font-semibold text-rose-600 bg-rose-50 border border-rose-200 rounded-md px-1.5 py-0.5">False</span>
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
