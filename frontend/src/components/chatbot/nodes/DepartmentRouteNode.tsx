"use client";

import { Handle, Position, NodeProps } from "reactflow";

export function DepartmentRouteNode(_props: NodeProps) {
  return (
    <div className="bg-white rounded-xl shadow-md border border-teal-300 min-w-[180px]">
      <Handle type="target" position={Position.Top} className="!bg-gray-400" />
      <div className="bg-teal-600 text-white px-3 py-1.5 rounded-t-xl text-xs font-medium">
        Dept. Route
      </div>
      <div className="p-3">
        <p className="text-xs text-gray-500">Routes to department queue</p>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-teal-500" />
    </div>
  );
}
