"use client";

import React from "react";
import { Handle, Position, NodeProps } from "reactflow";
import { NODE_REGISTRY, COLOR_TOKENS, SharedData, NodeStatus } from "./node-registry";

// Single canvas card used by EVERY node type. Reads from NODE_REGISTRY,
// shows: title (data.name || registry label), short summary, status pip,
// and the appropriate handles. Editing happens in the side-panel Inspector.
//
// Visual style: Manychat-inspired white card with a small category-tinted
// icon dot. The card body stays neutral; the icon carries the only color
// for the category.

const CATEGORY_ACCENTS: Record<
  string,
  { bg: string; text: string; ring: string }
> = {
  Triggers:       { bg: "bg-emerald-50", text: "text-emerald-600", ring: "ring-emerald-100" },
  "Flow Control": { bg: "bg-amber-50",   text: "text-amber-600",   ring: "ring-amber-100" },
  Logic:          { bg: "bg-blue-50",    text: "text-blue-600",    ring: "ring-blue-100" },
  Messages:       { bg: "bg-violet-50",  text: "text-violet-600",  ring: "ring-violet-100" },
  Actions:        { bg: "bg-pink-50",    text: "text-pink-600",    ring: "ring-pink-100" },
  Integrations:   { bg: "bg-indigo-50",  text: "text-indigo-600",  ring: "ring-indigo-100" },
};

const FALLBACK_ACCENT = { bg: "bg-gray-50", text: "text-gray-600", ring: "ring-gray-100" };

export function CollapsedNode(props: NodeProps) {
  const { type, data, selected } = props;
  const entry = type ? NODE_REGISTRY[type] : undefined;
  if (!entry) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-[var(--border-hairline)] px-3 py-2 text-xs text-gray-600">
        Unknown node: {type}
      </div>
    );
  }

  const accent = CATEGORY_ACCENTS[entry.category] || FALLBACK_ACCENT;
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
  const dynamicSources = entry.getSources?.(data || {});
  const sources = (dynamicSources && dynamicSources.length > 0) ? dynamicSources : entry.handles.sources;
  const sourceCount = sources.length;

  return (
    <div
      style={{
        backgroundColor: "var(--surface-card)",
        boxShadow: "var(--shadow-card)",
        borderRadius: "var(--radius-card)",
      }}
      className={[
        "min-w-[240px] max-w-[280px] border border-[var(--border-hairline)]",
        "transition-all duration-150 select-none",
        selected
          ? "outline outline-2 outline-violet-500 outline-offset-[3px]"
          : "",
        "hover:shadow-lg",
      ].join(" ")}
    >
      {/* Incoming-edge target — anchored to the LEFT edge near the top of the
          card, regardless of registry's "top"/"left" preference. */}
      {hasTarget ? (
        <Handle
          type="target"
          position={Position.Left}
          style={{ top: 22 }}
          className="!w-2 !h-2 !bg-[var(--edge-color)] !border-2 !border-white"
        />
      ) : null}

      {/* Header: small category-tinted icon + title + status pip */}
      <div className="px-4 pt-4 pb-2 flex items-center gap-3">
        <div
          className={[
            "w-8 h-8 rounded-lg shrink-0 flex items-center justify-center",
            accent.bg,
            accent.text,
          ].join(" ")}
        >
          <span className="[&_svg]:w-4 [&_svg]:h-4">{entry.icon}</span>
        </div>
        <div className="flex-1 min-w-0">
          <div
            className="text-[14px] font-medium truncate"
            style={{ color: "var(--canvas-text-primary)" }}
            title={title}
          >
            {title}
          </div>
          <div
            className="text-[10px] uppercase tracking-wider"
            style={{ color: "var(--canvas-text-secondary)" }}
          >
            {entry.category}
          </div>
        </div>
        <StatusPip status={status} />
      </div>

      {/* Body: quick-reply nodes show their replies as message-style buttons,
          each with its own connection dot tucked into the button's right side.
          All other nodes show the registry's summary line. */}
      {type === "send_message_quick_reply"
        && Array.isArray(data?.replies)
        && data.replies.some((r: any) => r?.label) ? (
        <div className="px-4 pb-3 space-y-2">
          {data.text ? (
            <p
              className="text-[12px] line-clamp-2"
              style={{ color: "var(--canvas-text-secondary)" }}
              title={String(data.text)}
            >
              {String(data.text)}
            </p>
          ) : null}
          <div className="space-y-1.5">
            {data.replies
              .filter((r: any) => r?.label)
              .map((r: any) => {
                const handleId = String(r.payload || r.label || r.id || "").toLowerCase();
                return (
                  <div
                    key={r.id || handleId}
                    className="relative flex items-center justify-between gap-2 rounded-md border border-[var(--border-hairline)] bg-gray-50 px-3 py-1.5"
                  >
                    <span className="text-[12px] text-gray-700 truncate">{r.label}</span>
                    <Handle
                      type="source"
                      position={Position.Right}
                      id={handleId}
                      className="!w-2 !h-2 !bg-[var(--edge-color)] !border-2 !border-white !static !transform-none"
                    />
                  </div>
                );
              })}
          </div>
        </div>
      ) : (
        <div className="px-4 pb-4">
          <p
            className="text-[12px] line-clamp-2"
            style={{ color: "var(--canvas-text-secondary)" }}
            title={summary}
          >
            {summary}
          </p>
        </div>
      )}

      {/* Source handles — quick-reply renders its handles inside each button
          row above; everything else gets a single right-edge "Next" dot or
          labeled bottom multi-exits. */}
      {type === "send_message_quick_reply"
        && Array.isArray(data?.replies)
        && data.replies.some((r: any) => r?.label) ? null : sourceCount === 0 ? null : sourceCount === 1 ? (
        <>
          <div className="px-4 pb-3 pt-0 flex items-center justify-end">
            <span
              className="text-[12px] font-medium tracking-wide"
              style={{ color: "var(--canvas-text-secondary)" }}
            >
              Next
            </span>
          </div>
          <Handle
            type="source"
            position={Position.Right}
            id={sources[0].id}
            style={{ top: "auto", bottom: 14 }}
            className="!w-2.5 !h-2.5 !bg-[var(--edge-color)] !border-2 !border-white"
          />
        </>
      ) : (
        <div className="relative flex justify-around px-3 pb-3 pt-2 border-t border-[var(--border-hairline)]">
          {sources.map((s) => (
            <div key={s.id || s.label} className="flex flex-col items-center gap-1">
              {s.label ? (
                <span
                  className="text-[10px] font-medium rounded-md px-1.5 py-0.5 bg-gray-50"
                  style={{ color: "var(--canvas-text-secondary)" }}
                >
                  {s.label}
                </span>
              ) : null}
              <Handle
                type="source"
                position={Position.Bottom}
                id={s.id}
                className="!w-2 !h-2 !bg-[var(--edge-color)] !border-2 !border-white !static !transform-none"
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
    ? "bg-rose-100 text-rose-600"
    : "bg-amber-100 text-amber-600";
  const label = status === "error" ? "!" : "?";
  return (
    <span
      className={`w-4 h-4 rounded-full ${cls} text-[10px] font-bold flex items-center justify-center shrink-0`}
      title={status === "error" ? "Configuration error" : "Missing required fields"}
    >
      {label}
    </span>
  );
}

function safeSummary(
  fn: (d: any, s?: SharedData) => string,
  data: any,
  shared: SharedData,
): string {
  try {
    const s = fn(data || {}, shared);
    return (typeof s === "string" && s.trim()) ? s : "(not configured)";
  } catch {
    return "(not configured)";
  }
}

// COLOR_TOKENS retained for inspector primitives elsewhere (Field tones,
// VariableMentionInput chips). Suppress unused-import lint via a typed re-
// reference.
void COLOR_TOKENS;
