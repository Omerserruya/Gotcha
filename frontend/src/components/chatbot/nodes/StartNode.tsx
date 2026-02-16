"use client";

import { Handle, Position, NodeProps } from "reactflow";

export function StartNode(_props: NodeProps) {
  return (
    <div className="bg-green-500 text-white rounded-full px-6 py-3 shadow-md text-sm font-medium">
      Start
      <Handle type="source" position={Position.Bottom} className="!bg-green-700" />
    </div>
  );
}
