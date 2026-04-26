"use client";

import React from "react";
import { Handle, Position, NodeProps } from "reactflow";
import { NODE_REGISTRY, COLOR_TOKENS, SharedData, NodeStatus } from "./node-registry";

// Single canvas card used by EVERY node type. Reads from NODE_REGISTRY,
// shows: title (data.name || registry label), short summary, status pip,
// and the appropriate handles. Editing happens in the side-panel Inspector.
//
// Selection ring is driven by React Flow's `selected` prop — click a node
// to select it, the editor opens the Inspector for that node.

export function CollapsedNode(props: NodeProps) {
  const { type, data, selected } = props;
  const entry = type ? NODE_REGISTRY[type] : undefined;
  if (!entry) {
    return (
      <div className="bg-white rounded-2xl shadow border border-gray-300 px-3 py-2 text-xs text-gray-600">
        Unknown node: {type}
      </div>
    );
  }

  const tok = COLOR_TOKENS[entry.color];
  const shared: SharedData = {
    agents: data?.agents,
    flows: data?.flows,
    departments: data?.departments,
    channels: data?.channels,
  };
  const summary = safeSummary(entry.summary, data, shared);
  const status: NodeStatus = entry.validate ? entry.validate(data || {}) : "ok";
  const title = (typeof data?.name === "string" && data.name.trim()) ? data.name : entry.label;

  const hasTarget = entry.handles.target;
  const sources = entry.handles.sources;
  const sourceCount = sources.length;

  return (
    <div className={[
      "bg-white rounded-2xl border min-w-[220px] max-w-[260px] transition-all duration-150 select-none",
      tok.border,
      `shadow-md ${tok.ringSoft}`,
      selected ? "ring-2 ring-violet-400 ring-offset-2 ring-offset-gray-50" : `ring-1 ${tok.ring}`,
      "hover:shadow-lg",
    ].join(" ")}>

      {/* Top target handle */}
      {hasTarget === "top" ? (
        <Handle type="target" position={Position.Top} className={`${tok.handle} !w-3 !h-3 !border-2 !border-white !shadow-sm`} />
      ) : null}
      {hasTarget === "left" ? (
        <Handle type="target" position={Position.Left} className={`${tok.handle} !w-3 !h-3 !border-2 !border-white !shadow-sm`} />
      ) : null}

      {/* Header */}
      <div className={`bg-gradient-to-r ${tok.gradient} text-white px-3.5 py-2 rounded-t-2xl text-xs font-semibold flex items-center gap-2`}>
        <div className="w-5 h-5 rounded-md bg-white/20 flex items-center justify-center shrink-0">
          {entry.icon}
        </div>
        <span className="flex-1 truncate">{title}</span>
        <StatusPip status={status} />
      </div>

      {/* Summary body */}
      <div className="px-3.5 py-2.5">
        <p className="text-[11px] text-gray-500 truncate" title={summary}>{summary}</p>
      </div>

      {/* Source handles */}
      {sourceCount === 0 ? null : sourceCount === 1 ? (
        <Handle
          type="source"
          position={Position.Bottom}
          id={sources[0].id}
          className={`${COLOR_TOKENS[sources[0].color || entry.color].handle} !w-3 !h-3 !border-2 !border-white !shadow-sm`}
        />
      ) : (
        // Multiple labeled sources (e.g. Condition: Match / No Match)
        <div className="relative flex justify-around px-3 pb-3 pt-1 border-t border-gray-100">
          {sources.map((s) => (
            <div key={s.id || s.label} className="flex flex-col items-center gap-1">
              {s.label ? (
                <span className={`text-[10px] font-semibold ${COLOR_TOKENS[s.color || entry.color].text} ${COLOR_TOKENS[s.color || entry.color].bgSoft} ${COLOR_TOKENS[s.color || entry.color].border} rounded-md px-1.5 py-0.5 border`}>
                  {s.label}
                </span>
              ) : null}
              <Handle
                type="source"
                position={Position.Bottom}
                id={s.id}
                className={`${COLOR_TOKENS[s.color || entry.color].handle} !w-3 !h-3 !border-2 !border-white !shadow-sm !static !transform-none`}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusPip({ status }: { status: NodeStatus }) {
  if (status === "ok") return null;
  const cls = status === "error"
    ? "bg-rose-200 text-rose-800"
    : "bg-amber-200 text-amber-800";
  const label = status === "error" ? "!" : "?";
  return (
    <span className={`w-4 h-4 rounded-full ${cls} text-[10px] font-bold flex items-center justify-center shrink-0`} title={status === "error" ? "Configuration error" : "Missing required fields"}>
      {label}
    </span>
  );
}

function safeSummary(fn: (d: any, s?: SharedData) => string, data: any, shared: SharedData): string {
  try {
    const s = fn(data || {}, shared);
    return (typeof s === "string" && s.trim()) ? s : "(not configured)";
  } catch {
    return "(not configured)";
  }
}
