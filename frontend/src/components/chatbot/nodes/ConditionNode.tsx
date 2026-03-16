"use client";

import { Handle, Position, NodeProps } from "reactflow";

export function ConditionNode(_props: NodeProps) {
  return (
    <div className="bg-white rounded-2xl shadow-lg shadow-amber-100/40 border border-amber-200/60 min-w-[200px] ring-1 ring-amber-100/50 transition-shadow hover:shadow-xl hover:shadow-amber-100/50">
      <Handle type="target" position={Position.Top} className="!bg-amber-500 !w-3 !h-3 !border-2 !border-white !shadow-sm" />
      <div className="bg-gradient-to-r from-amber-400 to-amber-500 text-white px-3.5 py-2 rounded-t-2xl text-xs font-semibold flex items-center gap-2">
        <div className="w-5 h-5 rounded-md bg-white/20 flex items-center justify-center">
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
          </svg>
        </div>
        Condition
      </div>
      <div className="p-3">
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <svg className="w-3.5 h-3.5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
          </svg>
          Routes based on user input
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-amber-500 !w-3 !h-3 !border-2 !border-white !shadow-sm" />
    </div>
  );
}
