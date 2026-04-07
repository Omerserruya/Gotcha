"use client";

import { Handle, Position, NodeProps } from "reactflow";

export function RuleNode({ data }: NodeProps) {
  const enabled = data.enabled !== false;
  const selected = data.selected === true;

  return (
    <div
      className={`bg-white rounded-xl shadow-sm border ${selected ? "border-violet-400 ring-2 ring-violet-200" : "border-gray-100"} border-l-4 border-l-blue-400 min-w-[200px] max-w-[240px] cursor-pointer hover:shadow-md transition-shadow`}
      onClick={data.onSelect}
    >
      <Handle type="target" position={Position.Left} className="!bg-blue-400 !w-2.5 !h-2.5 !border-2 !border-white" />
      <div className="p-3">
        <div className="flex items-center gap-2 mb-1">
          <div className="w-5 h-5 rounded-md bg-blue-50 flex items-center justify-center flex-shrink-0">
            <svg className="w-3 h-3 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 3M21 7.5H7.5" />
            </svg>
          </div>
          <span className="text-xs font-semibold text-blue-600 uppercase tracking-wide">Rule</span>
          <span className={`ml-auto text-xs px-1.5 py-0.5 rounded-full font-medium flex-shrink-0 ${enabled ? "bg-green-50 text-green-600" : "bg-gray-100 text-gray-400"}`}>
            {enabled ? "On" : "Off"}
          </span>
        </div>
        <p className="text-sm font-semibold text-gray-900 truncate">{data.label || "Unnamed Rule"}</p>
        {data.conditionSummary && (
          <p className="text-xs text-gray-400 mt-1 line-clamp-2 leading-relaxed">{data.conditionSummary}</p>
        )}
        {data.priority != null && !data.isDefault && (
          <div className="mt-2 flex items-center gap-1">
            <span className="text-xs text-gray-300">Priority</span>
            <span className="text-xs font-bold text-blue-500">#{data.priority}</span>
          </div>
        )}
        {data.isDefault && (
          <div className="mt-1.5 flex items-center gap-1">
            <span className="text-xs px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded-full">Default fallback</span>
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Right} className="!bg-blue-400 !w-2.5 !h-2.5 !border-2 !border-white" />
    </div>
  );
}
