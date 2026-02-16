"use client";

import { Handle, Position, NodeProps } from "reactflow";

export function EndNode(_props: NodeProps) {
  return (
    <div className="bg-red-500 text-white rounded-full px-6 py-3 shadow-md text-sm font-medium">
      <Handle type="target" position={Position.Top} className="!bg-red-700" />
      End
    </div>
  );
}
