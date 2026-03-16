"use client";

import { Handle, Position, NodeProps } from "reactflow";

export function StartNode(_props: NodeProps) {
  return (
    <div className="group relative">
      <div className="bg-gradient-to-br from-emerald-400 to-emerald-600 text-white rounded-2xl px-5 py-3 shadow-lg shadow-emerald-200/50 text-sm font-semibold flex items-center gap-2 ring-2 ring-emerald-300/30 transition-shadow hover:shadow-xl hover:shadow-emerald-200/60">
        <div className="w-6 h-6 rounded-full bg-white/20 flex items-center justify-center">
          <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z" />
          </svg>
        </div>
        Start
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-emerald-600 !w-3 !h-3 !border-2 !border-white !shadow-sm" />
    </div>
  );
}
