"use client";

import React, { useEffect, useState } from "react";
import { Node } from "reactflow";
import { NODE_REGISTRY, COLOR_TOKENS, SharedData } from "./node-registry";

// Right-side panel that opens when a node is selected on the canvas.
// Per the Flow Builder spec: this is the ONLY place node configuration is
// edited. Canvas cards are read-only summaries (see CollapsedNode.tsx).
//
// Edits flow through `onChange(id, patch)` so React Flow state stays the
// source of truth — no direct data-object mutation.

interface Props {
  node: Node | null;
  shared?: SharedData;
  onChange: (id: string, patch: Record<string, any>) => void;
  onClose: () => void;
  onDelete?: (id: string) => void;
  onDuplicate?: (id: string) => void;
}

export function NodeInspector({ node, shared, onChange, onClose, onDelete, onDuplicate }: Props) {
  const [open, setOpen] = useState(false);

  // Slide-in animation: open after mount when a node is provided.
  useEffect(() => {
    if (node) {
      const t = setTimeout(() => setOpen(true), 10);
      return () => clearTimeout(t);
    }
    setOpen(false);
  }, [node?.id]);

  // ESC closes the inspector.
  useEffect(() => {
    if (!node) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [node, onClose]);

  if (!node) return null;
  const entry = node.type ? NODE_REGISTRY[node.type] : undefined;
  if (!entry) {
    return (
      <PanelShell open={open} onClose={onClose}>
        <div className="p-6 text-sm text-gray-600">No inspector available for node type "{node.type}".</div>
      </PanelShell>
    );
  }

  const tok = COLOR_TOKENS[entry.color];
  const Body = entry.Body;
  const data = node.data || {};

  function patch(p: Record<string, any>) { onChange(node!.id, p); }

  return (
    <PanelShell open={open} onClose={onClose}>
      {/* Header */}
      <div className={`bg-gradient-to-r ${tok.gradient} text-white px-5 py-4 flex items-start gap-3`}>
        <div className="w-10 h-10 rounded-xl bg-white/15 flex items-center justify-center shrink-0">
          <div className="scale-150">{entry.icon}</div>
        </div>
        <div className="flex-1 min-w-0">
          <input
            value={typeof data.name === "string" ? data.name : ""}
            onChange={(e) => patch({ name: e.target.value })}
            placeholder={entry.label}
            className="w-full bg-transparent text-white placeholder-white/60 text-base font-semibold outline-none border-b border-white/30 focus:border-white/80 transition pb-0.5"
          />
          <p className="text-[11px] text-white/70 mt-1 font-mono">{entry.type}</p>
        </div>
        <button
          onClick={onClose}
          className="text-white/80 hover:text-white p-1 rounded-md hover:bg-white/10 transition shrink-0"
          aria-label="Close inspector"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-5 py-4 bg-gray-50">
        <Body data={data} onChange={patch} shared={shared} nodeId={node.id} />
      </div>

      {/* Footer actions */}
      <div className="px-5 py-3 border-t border-gray-200 bg-white flex items-center justify-between gap-2">
        <div className="flex gap-2">
          {onDuplicate ? (
            <button
              onClick={() => onDuplicate(node!.id)}
              className="text-xs font-medium px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 transition"
            >
              Duplicate
            </button>
          ) : null}
          {onDelete ? (
            <button
              onClick={() => { onDelete(node!.id); onClose(); }}
              className="text-xs font-medium px-3 py-1.5 rounded-lg border border-rose-200 text-rose-600 hover:bg-rose-50 transition"
            >
              Delete
            </button>
          ) : null}
        </div>
        <button
          onClick={onClose}
          className="text-xs font-medium px-3 py-1.5 rounded-lg bg-gray-900 text-white hover:bg-gray-800 transition"
        >
          Done
        </button>
      </div>
    </PanelShell>
  );
}

function PanelShell({ open, onClose, children }: { open: boolean; onClose: () => void; children: React.ReactNode }) {
  return (
    <>
      {/* Click-outside catcher (transparent — we don't dim the canvas) */}
      <div className="fixed inset-0 z-30" onClick={onClose} />
      <aside
        onClick={(e) => e.stopPropagation()}
        className={`fixed right-0 top-0 h-screen w-[400px] max-w-[92vw] bg-white shadow-2xl border-l border-gray-200 z-40 flex flex-col transition-transform duration-200 ease-out ${open ? "translate-x-0" : "translate-x-full"}`}
      >
        {children}
      </aside>
    </>
  );
}
