"use client";

import { Handle, Position, NodeProps } from "reactflow";

export function FlowNode({ data }: NodeProps) {
  const active = data.active !== false;

  return (
    <div
      className="bg-white rounded-xl shadow-sm border border-gray-100 border-l-4 border-l-emerald-400 min-w-[180px] max-w-[220px] cursor-pointer hover:shadow-md transition-shadow"
      onClick={data.onSelect}
    >
      <Handle type="target" position={Position.Left} className="!bg-emerald-400 !w-2.5 !h-2.5 !border-2 !border-white" />
      <div className="p-3">
        <div className="flex items-center gap-2 mb-1">
          <div className="w-5 h-5 rounded-md bg-emerald-50 flex items-center justify-center flex-shrink-0">
            <svg className="w-3 h-3 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z" />
            </svg>
          </div>
          <span className="text-xs font-semibold text-emerald-600 uppercase tracking-wide">Flow</span>
          <span className={`ml-auto text-xs px-1.5 py-0.5 rounded-full font-medium flex-shrink-0 ${active ? "bg-emerald-50 text-emerald-600" : "bg-gray-100 text-gray-400"}`}>
            {active ? "Active" : "Draft"}
          </span>
        </div>
        <p className="text-sm font-semibold text-gray-900 truncate">{data.label || "Unnamed Flow"}</p>
        {data.description && (
          <p className="text-xs text-gray-400 mt-1 line-clamp-2">{data.description}</p>
        )}
      </div>
    </div>
  );
}
