"use client";

import React from "react";
import { useI18n } from "@/context/I18nContext";
import { NODE_REGISTRY } from "./node-registry";
import { getNodePorts } from "./connection-rules";
import { nodeLabel, nodeDesc } from "./node-i18n";

// §6 Node help. ONE info affordance driven by the SAME canonical metadata used
// for the catalog label, validation and docs (registry + node-i18n + derived
// ports) - no separate, contradictory description. Works on mouse hover AND
// keyboard focus, is announced via aria, and is small enough never to cover the
// node's connection handles.
//
// Shows: what it does (localized desc), what it receives / outputs (derived
// ports), and any limitation (e.g. voice add-participant can't feed a message
// input). Ports render as localized business-language types, never raw enums.

function portTypeLabel(type: string, t: (k: string) => string): string {
  const k = `aiStudio.portTypes.${type}`;
  const v = t(k);
  return v && v !== k ? v : type;
}

export function NodeInfoIcon({ type, className }: { type: string; className?: string }) {
  const { t } = useI18n();
  const entry = NODE_REGISTRY[type];
  if (!entry) return null;

  const label = nodeLabel(type, t);
  const desc = nodeDesc(type, t);
  const ports = getNodePorts(type);
  const inTypes = Array.from(new Set(ports.inputs.map((p) => portTypeLabel(p.type, t))));
  const outTypes = Array.from(new Set(ports.outputs.map((p) => portTypeLabel(p.type, t))));
  // A voice_add_participant-style limitation lives in the node desc already, but
  // surface the "no message input" rule explicitly when it applies.
  const limitationKey = `aiStudio.nodes.${type.split(".").join(".")}.limitation`;
  const limitation = (() => { const v = t(limitationKey); return v && v !== limitationKey ? v : null; })();

  return (
    <span className={`relative inline-flex group/info ${className ?? ""}`}>
      <button
        type="button"
        // Info-only: don't trigger the parent palette item's add-on-click.
        onClick={(e) => { e.stopPropagation(); e.preventDefault(); }}
        onMouseDown={(e) => e.stopPropagation()}
        aria-label={t("aiStudio.nodeInfo.about").replace("{node}", label)}
        className="w-4 h-4 rounded-full text-gray-300 hover:text-gray-500 focus:text-violet-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-300"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
        </svg>
      </button>
      {/* Tooltip - shown on hover OR keyboard focus; RTL-aware, width-capped so
          it never blankets the node or its handles. */}
      <span
        role="tooltip"
        className="pointer-events-none absolute z-30 top-5 start-0 w-56 rounded-lg bg-gray-900 text-white text-[11px] leading-snug p-2.5 shadow-xl opacity-0 group-hover/info:opacity-100 group-focus-within/info:opacity-100 transition-opacity"
      >
        <span className="block font-semibold mb-0.5">{label}</span>
        {desc && <span className="block text-gray-200">{desc}</span>}
        <span className="mt-1.5 block text-gray-400">
          {ports.inputs.length > 0
            ? t("aiStudio.nodeInfo.receives").replace("{types}", inTypes.join(", "))
            : t("aiStudio.nodeInfo.noInput")}
        </span>
        <span className="block text-gray-400">
          {ports.outputs.length > 0
            ? t("aiStudio.nodeInfo.produces").replace("{types}", outTypes.join(", "))
            : t("aiStudio.nodeInfo.noOutput")}
        </span>
        {limitation && <span className="mt-1 block text-amber-300">{limitation}</span>}
      </span>
    </span>
  );
}
