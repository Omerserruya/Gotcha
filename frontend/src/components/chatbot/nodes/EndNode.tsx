"use client";

import { Handle, Position, NodeProps } from "reactflow";

export function EndNode(_props: NodeProps) {
  return (
    <div className="group relative">
      <Handle type="target" position={Position.Top} className="!bg-rose-600 !w-3 !h-3 !border-2 !border-white !shadow-sm" />
      <div className="bg-gradient-to-br from-rose-400 to-rose-600 text-white rounded-2xl px-5 py-3 shadow-lg shadow-rose-200/50 text-sm font-semibold flex items-center gap-2 ring-2 ring-rose-300/30 transition-shadow hover:shadow-xl hover:shadow-rose-200/60">
        <div className="w-6 h-6 rounded-full bg-white/20 flex items-center justify-center">
          <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M5.25 7.5A2.25 2.25 0 017.5 5.25h9a2.25 2.25 0 012.25 2.25v9a2.25 2.25 0 01-2.25 2.25h-9a2.25 2.25 0 01-2.25-2.25v-9z" />
          </svg>
        </div>
        End
      </div>
    </div>
  );
}
