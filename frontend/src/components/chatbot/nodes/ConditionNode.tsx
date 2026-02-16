"use client";

import { Handle, Position, NodeProps } from "reactflow";

export function ConditionNode(_props: NodeProps) {
  return (
    <div className="bg-white rounded-xl shadow-md border border-gray-200 min-w-[180px]">
      <Handle type="target" position={Position.Top} className="!bg-gray-400" />
      <div className="bg-orange-500 text-white px-3 py-1.5 rounded-t-xl text-xs font-medium">
        Condition
      </div>
      <div className="p-3">
        <p className="text-xs text-gray-500">Routes based on user input</p>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-orange-500" />
    </div>
  );
}
