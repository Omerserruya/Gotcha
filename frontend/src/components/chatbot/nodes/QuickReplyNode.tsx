"use client";

import { Handle, Position, NodeProps } from "reactflow";
import { useState } from "react";

export function QuickReplyNode({ data }: NodeProps) {
  const [text, setText] = useState(data.text || "");
  const [buttons, setButtons] = useState<Array<{ id: string; title: string }>>(
    data.buttons || []
  );

  function addButton() {
    const newBtn = { id: `btn-${Date.now()}`, title: "Button" };
    const updated = [...buttons, newBtn];
    setButtons(updated);
    data.buttons = updated;
  }

  function updateButton(index: number, title: string) {
    const updated = buttons.map((b, i) => (i === index ? { ...b, title } : b));
    setButtons(updated);
    data.buttons = updated;
  }

  function removeButton(index: number) {
    const updated = buttons.filter((_, i) => i !== index);
    setButtons(updated);
    data.buttons = updated;
  }

  return (
    <div className="bg-white rounded-xl shadow-md border border-gray-200 min-w-[220px] max-w-[300px]">
      <Handle type="target" position={Position.Top} className="!bg-gray-400" />
      <div className="bg-purple-500 text-white px-3 py-1.5 rounded-t-xl text-xs font-medium">
        Quick Reply
      </div>
      <div className="p-3 space-y-2">
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            data.text = e.target.value;
          }}
          className="w-full text-sm border border-gray-200 rounded-lg p-2 resize-none focus:ring-1 focus:ring-purple-500 outline-none"
          rows={2}
          placeholder="Question text..."
        />
        {buttons.map((btn, i) => (
          <div key={btn.id} className="relative flex items-center gap-1 pr-3">
            <input
              type="text"
              value={btn.title}
              onChange={(e) => updateButton(i, e.target.value)}
              className="flex-1 text-xs border border-gray-200 rounded px-2 py-1 focus:ring-1 focus:ring-purple-500 outline-none"
            />
            <button
              onClick={() => removeButton(i)}
              className="text-red-400 hover:text-red-600 text-xs"
            >
              x
            </button>
            <Handle
              type="source"
              position={Position.Right}
              id={btn.id}
              className="!bg-purple-500 !w-2.5 !h-2.5"
              style={{ top: "50%", right: "-5px" }}
            />
          </div>
        ))}
        <button
          onClick={addButton}
          className="text-xs text-purple-600 hover:text-purple-800"
        >
          + Add button
        </button>
      </div>
      {buttons.length === 0 && (
        <Handle type="source" position={Position.Bottom} className="!bg-purple-500" />
      )}
    </div>
  );
}
