"use client";

import { Handle, Position, NodeProps } from "reactflow";

export function HandoverNode(_props: NodeProps) {
  return (
    <div className="bg-white rounded-xl shadow-md border border-blue-300 min-w-[180px]">
      <Handle type="target" position={Position.Top} className="!bg-gray-400" />
      <div className="bg-blue-600 text-white px-3 py-1.5 rounded-t-xl text-xs font-medium">
        Handover to Agent
      </div>
      <div className="p-3">
        <p className="text-xs text-gray-500">Transfers to human agent</p>
      </div>
    </div>
  );
}
