"use client";

import { Handle, Position, NodeProps } from "reactflow";
import { useState } from "react";

export function QuickReplyNode({ data }: NodeProps) {
  const [text, setText] = useState(data.text || "");
  const [buttons, setButtons] = useState<Array<{ id: string; title: string }>>(
    data.buttons || []
  );

  function addButton() {
    if (buttons.length >= 9) return;
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
    <div className="bg-white rounded-2xl shadow-lg shadow-violet-100/40 border border-violet-200/60 min-w-[230px] max-w-[300px] ring-1 ring-violet-100/50 transition-shadow hover:shadow-xl hover:shadow-violet-100/50">
      <Handle type="target" position={Position.Top} className="!bg-violet-500 !w-3 !h-3 !border-2 !border-white !shadow-sm" />
      <div className="bg-gradient-to-r from-violet-500 to-violet-600 text-white px-3.5 py-2 rounded-t-2xl text-xs font-semibold flex items-center gap-2">
        <div className="w-5 h-5 rounded-md bg-white/20 flex items-center justify-center">
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6z" />
          </svg>
        </div>
        Quick Reply
      </div>
      <div className="p-3 space-y-2">
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            data.text = e.target.value;
          }}
          className="w-full text-sm border border-gray-200 rounded-xl p-2.5 resize-none focus:ring-2 focus:ring-violet-400/40 focus:border-violet-300 outline-none bg-violet-50/30 placeholder:text-gray-300 transition"
          rows={2}
          placeholder="Question text..."
        />
        <div className="space-y-1.5">
          {buttons.map((btn, i) => (
            <div key={btn.id} className="relative flex items-center gap-1.5 pe-4">
              <div className="w-1.5 h-1.5 rounded-full bg-violet-400 shrink-0" />
              <input
                type="text"
                value={btn.title}
                onChange={(e) => updateButton(i, e.target.value)}
                className="flex-1 text-xs border border-violet-200/60 bg-violet-50/40 rounded-lg px-2.5 py-1.5 focus:ring-2 focus:ring-violet-400/30 focus:border-violet-300 outline-none transition"
              />
              <button
                onClick={() => removeButton(i)}
                className="text-gray-300 hover:text-rose-500 transition text-xs"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
              <Handle
                type="source"
                position={Position.Right}
                id={btn.id}
                className="!bg-violet-500 !w-2.5 !h-2.5 !border-2 !border-white !shadow-sm"
                style={{ top: "50%", right: "-5px" }}
              />
            </div>
          ))}
        </div>
        {buttons.length < 9 ? (
          <button
            onClick={addButton}
            className="flex items-center gap-1.5 text-xs text-violet-500 hover:text-violet-700 font-medium transition py-1"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            Add button
          </button>
        ) : (
          <p className="text-[10px] text-gray-400 py-1">Max 9 buttons</p>
        )}
      </div>
      {buttons.length === 0 && (
        <Handle type="source" position={Position.Bottom} className="!bg-violet-500 !w-3 !h-3 !border-2 !border-white !shadow-sm" />
      )}
    </div>
  );
}
