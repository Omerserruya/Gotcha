"use client";

import { Handle, Position, NodeProps } from "reactflow";
import { useState } from "react";

export function MessageNode({ data, id }: NodeProps) {
  const [text, setText] = useState(data.text || "");

  return (
    <div className="bg-white rounded-2xl shadow-lg shadow-blue-100/40 border border-blue-200/60 min-w-[220px] max-w-[280px] ring-1 ring-blue-100/50 transition-shadow hover:shadow-xl hover:shadow-blue-100/50">
      <Handle type="target" position={Position.Top} className="!bg-blue-500 !w-3 !h-3 !border-2 !border-white !shadow-sm" />
      <div className="bg-gradient-to-r from-blue-500 to-blue-600 text-white px-3.5 py-2 rounded-t-2xl text-xs font-semibold flex items-center gap-2">
        <div className="w-5 h-5 rounded-md bg-white/20 flex items-center justify-center">
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
          </svg>
        </div>
        Send Message
      </div>
      <div className="p-3">
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            data.text = e.target.value;
          }}
          className="w-full text-sm border border-gray-200 rounded-xl p-2.5 resize-none focus:ring-2 focus:ring-blue-400/40 focus:border-blue-300 outline-none bg-blue-50/30 placeholder:text-gray-300 transition"
          rows={3}
          placeholder="Enter message text..."
        />
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-blue-500 !w-3 !h-3 !border-2 !border-white !shadow-sm" />
    </div>
  );
}
