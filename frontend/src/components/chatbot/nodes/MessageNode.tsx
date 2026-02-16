"use client";

import { Handle, Position, NodeProps } from "reactflow";
import { useState } from "react";

export function MessageNode({ data, id }: NodeProps) {
  const [text, setText] = useState(data.text || "");

  return (
    <div className="bg-white rounded-xl shadow-md border border-gray-200 min-w-[200px] max-w-[280px]">
      <Handle type="target" position={Position.Top} className="!bg-gray-400" />
      <div className="bg-blue-500 text-white px-3 py-1.5 rounded-t-xl text-xs font-medium">
        Message
      </div>
      <div className="p-3">
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            data.text = e.target.value;
          }}
          className="w-full text-sm border border-gray-200 rounded-lg p-2 resize-none focus:ring-1 focus:ring-blue-500 outline-none"
          rows={3}
          placeholder="Enter message text..."
        />
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-blue-500" />
    </div>
  );
}
