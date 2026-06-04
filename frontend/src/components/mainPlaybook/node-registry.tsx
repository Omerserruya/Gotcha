"use client";

import React from "react";
import { VariableMentionInput } from "./VariableMentionInput";
import { useAuth } from "@/context/AuthContext";
import {
  getChannelPosts,
  getTemplates,
  getAudienceSchema,
  getWebhookTrigger,
  createWebhookTrigger,
  regenerateWebhookSecret,
  setWebhookTriggerEnabled,
  type WebhookTriggerDto,
} from "@/lib/api";
import ChannelAccountPicker from "@/components/ChannelAccountPicker";

// Per-tenant lookups injected by the editor (agents/flows/departments lists for
// dropdowns). Optional; only some node types use it. The `channels` shape
// matches what GET /api/channels returns — the column is `channel` (an enum
// like MESSENGER / INSTAGRAM / WHATSAPP), NOT `type`.
export interface SharedData {
  agents?: { id: string; name: string }[];
  flows?: { id: string; name: string }[];
  departments?: { id: string; name: string }[];
  channels?: { id: string; channel: string; displayName?: string; externalId?: string }[];
}

export type NodeColor =
  | "orange" | "sky" | "indigo" | "teal" | "fuchsia" | "slate"
  | "blue" | "purple" | "zinc" | "violet" | "pink" | "rose"
  | "emerald" | "amber" | "gray";

export type NodeStatus = "ok" | "missing" | "error";

export interface HandleSpec {
  id?: string;
  position: "bottom" | "right";
  label?: string;
  color?: NodeColor;
}

export interface NodeRegistryEntry {
  type: string;
  label: string;
  color: NodeColor;
  icon: React.ReactNode;
  category: string;
  summary: (data: any, shared?: SharedData) => string;
  validate?: (data: any) => NodeStatus;
  defaultData: () => Record<string, any>;
  Body: React.ComponentType<{
    data: any;
    onChange: (patch: Record<string, any>) => void;
    shared?: SharedData;
  }>;
  handles: {
    target?: "top" | "left";
    sources: HandleSpec[];
  };
  // Optional override: when present, the canvas uses these sources instead
  // of the static `handles.sources`. Lets node types render one exit per
  // user-configured option (e.g. one exit per quick-reply button).
  getSources?: (data: any) => HandleSpec[];
}

// ─── Tailwind color tokens ───────────────────────────────────────
// Keep canvas + inspector visually consistent — every node in this color
// palette resolves through this map.
export const COLOR_TOKENS: Record<NodeColor, {
  ringSoft: string; border: string; gradient: string; handle: string;
  text: string; bgSoft: string; iconBg: string; ring: string;
}> = {
  orange:  { ringSoft: "shadow-orange-100/40",  border: "border-orange-200/60",  gradient: "from-orange-500 to-orange-600",   handle: "!bg-orange-500",   text: "text-orange-600",   bgSoft: "bg-orange-50",   iconBg: "bg-orange-100",   ring: "ring-orange-100/50" },
  sky:     { ringSoft: "shadow-sky-100/40",     border: "border-sky-200/60",     gradient: "from-sky-500 to-sky-600",         handle: "!bg-sky-500",      text: "text-sky-600",      bgSoft: "bg-sky-50",      iconBg: "bg-sky-100",      ring: "ring-sky-100/50" },
  indigo:  { ringSoft: "shadow-indigo-100/40",  border: "border-indigo-200/60",  gradient: "from-indigo-500 to-indigo-600",   handle: "!bg-indigo-500",   text: "text-indigo-600",   bgSoft: "bg-indigo-50",   iconBg: "bg-indigo-100",   ring: "ring-indigo-100/50" },
  teal:    { ringSoft: "shadow-teal-100/40",    border: "border-teal-200/60",    gradient: "from-teal-500 to-teal-600",       handle: "!bg-teal-500",     text: "text-teal-600",     bgSoft: "bg-teal-50",     iconBg: "bg-teal-100",     ring: "ring-teal-100/50" },
  fuchsia: { ringSoft: "shadow-fuchsia-100/40", border: "border-fuchsia-200/60", gradient: "from-fuchsia-500 to-fuchsia-600", handle: "!bg-fuchsia-500",  text: "text-fuchsia-600",  bgSoft: "bg-fuchsia-50",  iconBg: "bg-fuchsia-100",  ring: "ring-fuchsia-100/50" },
  slate:   { ringSoft: "shadow-slate-100/40",   border: "border-slate-200/60",   gradient: "from-slate-500 to-slate-600",     handle: "!bg-slate-500",    text: "text-slate-600",    bgSoft: "bg-slate-50",    iconBg: "bg-slate-100",    ring: "ring-slate-100/50" },
  blue:    { ringSoft: "shadow-blue-100/40",    border: "border-blue-200/60",    gradient: "from-blue-500 to-blue-600",       handle: "!bg-blue-500",     text: "text-blue-600",     bgSoft: "bg-blue-50",     iconBg: "bg-blue-100",     ring: "ring-blue-100/50" },
  purple:  { ringSoft: "shadow-purple-100/40",  border: "border-purple-200/60",  gradient: "from-purple-500 to-purple-600",   handle: "!bg-purple-500",   text: "text-purple-600",   bgSoft: "bg-purple-50",   iconBg: "bg-purple-100",   ring: "ring-purple-100/50" },
  zinc:    { ringSoft: "shadow-zinc-100/40",    border: "border-zinc-200/60",    gradient: "from-zinc-700 to-zinc-800",       handle: "!bg-zinc-500",     text: "text-zinc-600",     bgSoft: "bg-zinc-50",     iconBg: "bg-zinc-100",     ring: "ring-zinc-100/50" },
  violet:  { ringSoft: "shadow-violet-100/40",  border: "border-violet-200/60",  gradient: "from-violet-500 to-violet-600",   handle: "!bg-violet-500",   text: "text-violet-600",   bgSoft: "bg-violet-50",   iconBg: "bg-violet-100",   ring: "ring-violet-100/50" },
  pink:    { ringSoft: "shadow-pink-100/40",    border: "border-pink-200/60",    gradient: "from-pink-500 to-pink-600",       handle: "!bg-pink-500",     text: "text-pink-600",     bgSoft: "bg-pink-50",     iconBg: "bg-pink-100",     ring: "ring-pink-100/50" },
  rose:    { ringSoft: "shadow-rose-100/40",    border: "border-rose-200/60",    gradient: "from-rose-500 to-rose-600",       handle: "!bg-rose-500",     text: "text-rose-600",     bgSoft: "bg-rose-50",     iconBg: "bg-rose-100",     ring: "ring-rose-100/50" },
  emerald: { ringSoft: "shadow-emerald-100/40", border: "border-emerald-200/60", gradient: "from-emerald-500 to-emerald-600", handle: "!bg-emerald-500",  text: "text-emerald-600",  bgSoft: "bg-emerald-50",  iconBg: "bg-emerald-100",  ring: "ring-emerald-100/50" },
  amber:   { ringSoft: "shadow-amber-100/40",   border: "border-amber-200/60",   gradient: "from-amber-400 to-amber-500",     handle: "!bg-amber-500",    text: "text-amber-600",    bgSoft: "bg-amber-50",    iconBg: "bg-amber-100",    ring: "ring-amber-100/50" },
  gray:    { ringSoft: "shadow-gray-100/40",    border: "border-gray-200/60",    gradient: "from-gray-500 to-gray-600",       handle: "!bg-gray-500",     text: "text-gray-600",     bgSoft: "bg-gray-50",     iconBg: "bg-gray-100",     ring: "ring-gray-100/50" },
};

// ─── Reusable inspector primitives ───────────────────────────────
const inspectorInput =
  "w-full text-sm border border-gray-200 bg-white rounded-lg px-3 py-2 focus:ring-2 focus:ring-violet-300 focus:border-violet-300 outline-none transition";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-semibold text-gray-700 mb-1 block">{label}</span>
      {children}
      {hint ? <p className="mt-1 text-[11px] text-gray-400">{hint}</p> : null}
    </label>
  );
}

function joinKw(v: any): string {
  return Array.isArray(v) ? v.join(", ") : (typeof v === "string" ? v : "");
}

// ─── Icons (re-used from old palette) ─────────────────────────────
const ICONS: Record<string, React.ReactNode> = {
  start: (<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z" /></svg>),
  end: (<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5.25 7.5A2.25 2.25 0 017.5 5.25h9a2.25 2.25 0 012.25 2.25v9a2.25 2.25 0 01-2.25 2.25h-9a2.25 2.25 0 01-2.25-2.25v-9z" /></svg>),
  wait: (<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>),
  condition: (<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" /></svg>),
  text: (<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" /></svg>),
  link: (<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" /></svg>),
  reply: (<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" /></svg>),
  image: (<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5z" /></svg>),
  file: (<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25" /></svg>),
  collect: (<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" /></svg>),
  variable: (<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" /></svg>),
  http: (<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3" /></svg>),
  ai: (<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" /></svg>),
  customer: (<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" /></svg>),
  data: (<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375" /></svg>),
  comment: (<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M12 20.25c4.97 0 9-3.694 9-8.25s-4.03-8.25-9-8.25S3 7.444 3 12c0 2.104.859 4.023 2.273 5.48.432.447.74 1.04.586 1.641a4.483 4.483 0 01-.923 1.785A5.969 5.969 0 006 21c1.282 0 2.47-.402 3.445-1.087.81.22 1.668.337 2.555.337z" /></svg>),
  search: (<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" /></svg>),
  schedule: (<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25" /></svg>),
  agent: (<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" /></svg>),
  phone: (<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 002.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 01-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 00-1.091-.852H4.5A2.25 2.25 0 002.25 4.5v2.25z" /></svg>),
  template: (<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" /></svg>),
  phoneEnd: (<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85" /></svg>),
};

// ─── REGISTRY ─────────────────────────────────────────────────────
// One entry per node type. Each entry knows how to: render its summary,
// validate itself, supply default data, and render its inspector body.
// Canvas cards are uniformly rendered by CollapsedNode.tsx using this data.
export const NODE_REGISTRY: Record<string, NodeRegistryEntry> = {

  // ── Triggers ──────────────────────────────────────────────────────
  // Channel-specific entry. Renders on canvas via the dedicated
  // ChannelEntryNode (gradient header) — this registry entry only drives
  // the side-panel Inspector + palette. Useful for sub-flows that should
  // only fire on a specific channel (e.g. Instagram-only).
  channel_entry: {
    type: "channel_entry", label: "Channel Entry", color: "violet", icon: ICONS.start, category: "Triggers",
    handles: { sources: [{ position: "bottom" }] },
    defaultData: () => ({ channelId: "", channelType: "", label: "", connected: false }),
    summary: (d) => {
      const names: Record<string, string> = {
        whatsapp: "WhatsApp", instagram: "Instagram", facebook: "Facebook",
        messenger: "Messenger", email: "Email", gmail: "Gmail",
        sms: "SMS", webchat: "Webchat",
      };
      if (!d.channelId && !d.channelType) return "(pick a channel)";
      const platform = names[d.channelType] || d.channelType || "Channel";
      return d.label ? `${platform}: ${d.label}` : `On: ${platform}`;
    },
    Body: ({ data, onChange, shared }) => {
      const list = shared?.channels || [];
      const accounts = list.map((c) => ({
        id: c.id,
        channel: c.channel,
        displayName: c.displayName || c.externalId || c.id,
        externalId: c.externalId,
      }));
      return (
        <div className="space-y-3">
          <Field label="Channel" hint={list.length === 0 ? "Connect a channel in Settings → Channels first." : "Pick a specific connected channel — this entry fires only on that account."}>
            <ChannelAccountPicker
              accounts={accounts}
              value={data.channelId || ""}
              onChange={(id, channel) => {
                const ch = list.find((c) => c.id === id);
                onChange({
                  channelId: id,
                  channelType: (channel || "").toLowerCase(),
                  label: ch?.displayName || "",
                  connected: true,
                });
              }}
              placeholder={list.length === 0 ? "No connected channels" : "Select a channel"}
            />
          </Field>
          <Field label="Label" hint="Display name on the canvas card.">
            <input
              className={inspectorInput}
              value={data.label || ""}
              onChange={(e) => onChange({ label: e.target.value })}
              placeholder={data.channelType || "Channel"}
            />
          </Field>
        </div>
      );
    },
  },

  start: {
    type: "start", label: "Start", color: "emerald", icon: ICONS.start, category: "Flow Control",
    handles: { sources: [{ position: "bottom" }] },
    defaultData: () => ({ trigger: "message_received" }),
    summary: (d) => {
      switch (d.trigger) {
        case "comment_received": return "On: comment received";
        case "manual": return "Called from another flow";
        default: return "On: message received";
      }
    },
    Body: ({ data, onChange }) => (
      <Field label="Entry trigger" hint="When this flow starts.">
        <select className={inspectorInput} value={data.trigger || "message_received"} onChange={(e) => onChange({ trigger: e.target.value })}>
          <option value="message_received">Message received</option>
          <option value="comment_received">Comment received (coming soon)</option>
          <option value="manual">Called from another flow</option>
        </select>
      </Field>
    ),
  },

  end: {
    type: "end", label: "End", color: "rose", icon: ICONS.end, category: "Flow Control",
    handles: { target: "top", sources: [] },
    defaultData: () => ({ kind: "wait_for_reply" }),
    summary: (d) => {
      switch (d.kind) {
        case "close": return "Close conversation";
        case "handoff_human": return "Hand off to human";
        default: return "Wait for reply";
      }
    },
    Body: ({ data, onChange }) => (
      <Field label="Termination kind" hint="What this branch does when reached.">
        <select className={inspectorInput} value={data.kind || "wait_for_reply"} onChange={(e) => onChange({ kind: e.target.value })}>
          <option value="close">Close conversation</option>
          <option value="handoff_human">Hand off to human (status WAITING)</option>
          <option value="wait_for_reply">Wait for next inbound</option>
        </select>
      </Field>
    ),
  },

  wait: {
    type: "wait", label: "Wait", color: "orange", icon: ICONS.wait, category: "Flow Control",
    handles: { target: "top", sources: [{ position: "bottom" }] },
    defaultData: () => ({ amount: 5, unit: "seconds" }),
    summary: (d) => `Wait ${d.amount ?? 5} ${d.unit || "seconds"}`,
    Body: ({ data, onChange }) => (
      <div className="space-y-3">
        <Field label="Duration">
          <div className="flex gap-2">
            <input type="number" min={1} className={inspectorInput + " flex-1"} value={data.amount ?? 5} onChange={(e) => onChange({ amount: Math.max(1, Number(e.target.value) || 1) })} />
            <select className={inspectorInput + " flex-1"} value={data.unit || "seconds"} onChange={(e) => onChange({ unit: e.target.value })}>
              <option value="seconds">seconds</option>
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
            </select>
          </div>
        </Field>
      </div>
    ),
  },

  condition_group: {
    type: "condition_group", label: "Condition", color: "amber", icon: ICONS.condition, category: "Logic",
    handles: { target: "left", sources: [
      { id: "true",  position: "bottom", label: "Match",    color: "emerald" },
      { id: "false", position: "bottom", label: "No Match", color: "rose" },
    ] },
    defaultData: () => ({ name: "Condition", logic: "AND", conditions: [{ id: `c_${Date.now()}`, type: "intent", operator: "equals", value: "" }] }),
    validate: (d) => (Array.isArray(d.conditions) && d.conditions.some((c: any) => !!c.value)) ? "ok" : "missing",
    summary: (d) => {
      const cs = Array.isArray(d.conditions) ? d.conditions : [];
      if (cs.length === 0) return "No conditions";
      const first = cs[0];
      const op = first.operator?.replace(/_/g, " ") || "equals";
      const tail = cs.length > 1 ? ` ${d.logic || "AND"} +${cs.length - 1}` : "";
      return `If ${first.type || "intent"} ${op} "${first.value || "…"}"${tail}`;
    },
    Body: ConditionGroupBody,
  },

  // ── Messages ──────────────────────────────────────────────────────
  send_message_text: {
    type: "send_message_text", label: "Send Text", color: "sky", icon: ICONS.text, category: "Messages",
    handles: { target: "top", sources: [{ position: "bottom" }] },
    defaultData: () => ({ text: "", waitForReply: false }),
    validate: (d) => d.text ? "ok" : "missing",
    summary: (d) => {
      const base = d.text ? `"${truncate(d.text, 40)}"` : "(empty)";
      return d.waitForReply ? `${base} · waits for reply` : base;
    },
    Body: ({ data, onChange }) => (
      <div className="space-y-3">
        <Field label="Message text" hint="Click {x} to insert a variable from another node.">
          <VariableMentionInput value={data.text || ""} onChange={(v) => onChange({ text: v })} multiline rows={6} placeholder="Type the message to send..." tone="sky" />
        </Field>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={!!data.waitForReply} onChange={(e) => onChange({ waitForReply: e.target.checked })} className="accent-sky-500" />
          Wait for user reply before continuing
        </label>
      </div>
    ),
  },

  send_message_interactive: {
    type: "send_message_interactive", label: "Send Interactive (Link)", color: "indigo", icon: ICONS.link, category: "Messages",
    handles: { target: "top", sources: [{ position: "bottom" }] },
    defaultData: () => ({ text: "", buttonLabel: "", buttonUrl: "" }),
    validate: (d) => (d.text && d.buttonLabel && d.buttonUrl) ? "ok" : "missing",
    summary: (d) => d.buttonLabel ? `Link "${truncate(d.buttonLabel, 24)}"` : "(no button)",
    Body: ({ data, onChange }) => (
      <div className="space-y-3">
        <Field label="Body text">
          <VariableMentionInput value={data.text || ""} onChange={(v) => onChange({ text: v })} multiline rows={4} placeholder="Body text..." tone="indigo" />
        </Field>
        <Field label="Button label">
          <VariableMentionInput value={data.buttonLabel || ""} onChange={(v) => onChange({ buttonLabel: v })} placeholder="e.g. Open, Buy now" tone="indigo" />
        </Field>
        <Field label="Button URL">
          <VariableMentionInput value={data.buttonUrl || ""} onChange={(v) => onChange({ buttonUrl: v })} placeholder="https://..." tone="indigo" />
        </Field>
      </div>
    ),
  },

  send_message_quick_reply: {
    type: "send_message_quick_reply", label: "Send Quick Reply", color: "teal", icon: ICONS.reply, category: "Messages",
    handles: { target: "top", sources: [{ position: "bottom" }] },
    // One exit per reply — handle id matches the lowercased payload so the
    // runtime (flow-executor) can route by `sourceHandle === payload`.
    getSources: (d) => {
      const replies = Array.isArray(d.replies) ? d.replies : [];
      if (replies.length === 0) return [{ position: "bottom" }];
      return replies.map((r: any) => {
        const handleId = String(r.payload || r.label || r.id || "").toLowerCase();
        return { id: handleId, position: "bottom" as const, label: r.label || r.payload || handleId };
      });
    },
    defaultData: () => ({ text: "", replies: [{ id: `r_${Date.now()}`, label: "Yes", payload: "yes" }] }),
    validate: (d) => (d.text && Array.isArray(d.replies) && d.replies.some((r: any) => r.label)) ? "ok" : "missing",
    summary: (d) => `${(d.replies || []).length} option${(d.replies || []).length === 1 ? "" : "s"}`,
    Body: QuickReplyBody,
  },

  send_message_image: {
    type: "send_message_image", label: "Send Image", color: "fuchsia", icon: ICONS.image, category: "Messages",
    handles: { target: "top", sources: [{ position: "bottom" }] },
    defaultData: () => ({ url: "", caption: "" }),
    validate: (d) => d.url ? "ok" : "missing",
    summary: (d) => d.url ? `Image: ${truncate(d.url, 32)}` : "(no URL)",
    Body: ({ data, onChange }) => (
      <div className="space-y-3">
        <Field label="Image URL" hint="Direct URL to the image. Variables supported.">
          <VariableMentionInput value={data.url || ""} onChange={(v) => onChange({ url: v })} placeholder="https://.../image.jpg" tone="fuchsia" />
        </Field>
        {data.url && !String(data.url).includes("{{") ? (
          <div className="w-full aspect-video rounded-lg overflow-hidden bg-gray-100 flex items-center justify-center">
            <img src={data.url} alt="" className="w-full h-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
          </div>
        ) : null}
        <Field label="Caption (optional)">
          <VariableMentionInput value={data.caption || ""} onChange={(v) => onChange({ caption: v })} placeholder="Caption..." tone="fuchsia" />
        </Field>
      </div>
    ),
  },

  send_message_file: {
    type: "send_message_file", label: "Send File", color: "slate", icon: ICONS.file, category: "Messages",
    handles: { target: "top", sources: [{ position: "bottom" }] },
    defaultData: () => ({ url: "", filename: "", caption: "" }),
    validate: (d) => d.url ? "ok" : "missing",
    summary: (d) => d.filename ? `File: ${truncate(d.filename, 28)}` : (d.url ? `File: ${truncate(d.url, 28)}` : "(no file)"),
    Body: ({ data, onChange }) => (
      <div className="space-y-3">
        <Field label="File URL">
          <VariableMentionInput value={data.url || ""} onChange={(v) => onChange({ url: v })} placeholder="https://.../document.pdf" tone="slate" />
        </Field>
        <Field label="Display filename (optional)">
          <VariableMentionInput value={data.filename || ""} onChange={(v) => onChange({ filename: v })} placeholder="Display filename..." tone="slate" />
        </Field>
        <Field label="Caption (optional)">
          <VariableMentionInput value={data.caption || ""} onChange={(v) => onChange({ caption: v })} placeholder="Caption..." tone="slate" />
        </Field>
      </div>
    ),
  },

  // WhatsApp template send — only WABA channels accept templates. Used to
  // (re-)open a 24h customer-service window from inside a flow. Variables
  // are stored as { key → value } where each value is plain text with
  // optional `{{var}}` mentions (resolved against the flow's runtime vars).
  send_message_template: {
    type: "send_message_template", label: "Send WhatsApp Template", color: "emerald", icon: ICONS.template, category: "Messages",
    handles: { target: "top", sources: [{ position: "bottom" }] },
    defaultData: () => ({
      templateId: "",
      templateName: "",
      language: "",
      variables: {},
      headerMediaUrl: "",
    }),
    validate: (d) => d.templateId ? "ok" : "missing",
    summary: (d) => {
      if (!d.templateId) return "(pick a template)";
      return d.templateName ? `Template: ${truncate(String(d.templateName), 30)}` : "Template selected";
    },
    Body: SendMessageTemplateBody,
  },

  // Public reply on the original comment (NOT a DM). Distinct from
  // send_message_*: it goes through the IG/Messenger comments API and is
  // visible to everyone on the post. Pairs naturally with comment_trigger.
  // Two modes: static text (with {{vars}}), or AI Agent (drafts a reply
  // from the inbound comment text, with optional fallback if the LLM
  // returns nothing). Doesn't change PSID — flow can still drop into a DM
  // afterwards via send_message_*.
  send_comment_reply: {
    type: "send_comment_reply", label: "Reply to Comment", color: "emerald", icon: ICONS.reply, category: "Messages",
    handles: { target: "top", sources: [{ position: "bottom" }] },
    defaultData: () => ({ mode: "text", text: "", agentId: "", fallbackText: "" }),
    validate: (d) => {
      if (d.mode === "ai") return d.agentId ? "ok" : "missing";
      return d.text ? "ok" : "missing";
    },
    summary: (d, shared) => {
      if (d.mode === "ai") {
        const name = shared?.agents?.find((a) => a.id === d.agentId)?.name;
        return `Public reply (AI: ${name || "unselected"})`;
      }
      return d.text ? `Public: ${truncate(String(d.text), 28)}` : "(no text)";
    },
    Body: SendCommentReplyBody,
  },

  // ── Actions / data ────────────────────────────────────────────────
  collect_input: {
    type: "collect_input", label: "Collect Input", color: "blue", icon: ICONS.collect, category: "Actions",
    handles: { target: "top", sources: [{ position: "bottom" }] },
    defaultData: () => ({ prompt: "", variable: "", validation: "any" }),
    validate: (d) => (d.prompt && d.variable) ? "ok" : "missing",
    summary: (d) => d.variable ? `Ask → {{${d.variable}}}` : "(no variable)",
    Body: ({ data, onChange }) => (
      <div className="space-y-3">
        <Field label="Prompt" hint="What to ask the user.">
          <textarea rows={3} className={inspectorInput + " resize-none"} value={data.prompt || ""} onChange={(e) => onChange({ prompt: e.target.value })} placeholder="What's your email?" />
        </Field>
        <Field label="Variable name" hint="Reply is stored under this name.">
          <input className={inspectorInput + " font-mono"} value={data.variable || ""} onChange={(e) => onChange({ variable: e.target.value.replace(/[^a-z0-9_]/gi, "") })} placeholder="customer_email" />
        </Field>
        <Field label="Validation">
          <select className={inspectorInput} value={data.validation || "any"} onChange={(e) => onChange({ validation: e.target.value })}>
            <option value="any">Any text</option>
            <option value="email">Email</option>
            <option value="phone">Phone</option>
            <option value="number">Number</option>
            <option value="url">URL</option>
          </select>
        </Field>
      </div>
    ),
  },

  set_variable: {
    type: "set_variable", label: "Set Variable", color: "purple", icon: ICONS.variable, category: "Actions",
    handles: { target: "top", sources: [{ position: "bottom" }] },
    defaultData: () => ({ variable: "", value: "" }),
    validate: (d) => d.variable ? "ok" : "missing",
    summary: (d) => d.variable ? `{{${d.variable}}} = "${truncate(String(d.value ?? ""), 24)}"` : "(no variable)",
    Body: ({ data, onChange }) => (
      <div className="space-y-3">
        <Field label="Variable name">
          <input className={inspectorInput + " font-mono"} value={data.variable || ""} onChange={(e) => onChange({ variable: e.target.value.replace(/[^a-z0-9_]/gi, "") })} placeholder="my_var" />
        </Field>
        <Field label="Value" hint="Click {x} to insert another variable.">
          <VariableMentionInput value={data.value || ""} onChange={(v) => onChange({ value: v })} placeholder="Hello {{customer_name}}" tone="purple" />
        </Field>
      </div>
    ),
  },

  http_request: {
    type: "http_request", label: "HTTP Request", color: "zinc", icon: ICONS.http, category: "Integrations",
    handles: { target: "top", sources: [{ position: "bottom" }] },
    defaultData: () => ({ method: "GET", url: "", body: "", headers: [{ id: `h_${Date.now()}`, key: "", value: "" }], responseVariable: "response", jsonPath: "" }),
    validate: (d) => d.url ? "ok" : "missing",
    summary: (d) => `${d.method || "GET"} ${truncate(d.url || "", 36) || "(no URL)"}`,
    Body: HttpRequestBody,
  },

  ai_generate: {
    type: "ai_generate", label: "AI Generate", color: "violet", icon: ICONS.ai, category: "Integrations",
    handles: { target: "top", sources: [{ position: "bottom" }] },
    defaultData: () => ({ prompt: "", responseVariable: "ai_output", model: "fast" }),
    validate: (d) => (d.prompt && d.responseVariable) ? "ok" : "missing",
    summary: (d) => d.prompt ? `AI → {{${d.responseVariable || "ai_output"}}}` : "(no prompt)",
    Body: ({ data, onChange }) => (
      <div className="space-y-3">
        <Field label="Prompt" hint="Use {{variables}} like {{customer_email}}.">
          <textarea rows={6} className={inspectorInput + " resize-none"} value={data.prompt || ""} onChange={(e) => onChange({ prompt: e.target.value })} placeholder="Summarize the customer message..." />
        </Field>
        <Field label="Model">
          <select className={inspectorInput} value={data.model || "fast"} onChange={(e) => onChange({ model: e.target.value })}>
            <option value="fast">Fast (cheap)</option>
            <option value="smart">Smart (slower, higher quality)</option>
          </select>
        </Field>
        <Field label="Save response as">
          <input className={inspectorInput + " font-mono"} value={data.responseVariable || "ai_output"} onChange={(e) => onChange({ responseVariable: e.target.value.replace(/[^a-z0-9_]/gi, "") })} />
        </Field>
      </div>
    ),
  },

  update_customer: {
    type: "update_customer", label: "Update Customer", color: "pink", icon: ICONS.customer, category: "Customer Data",
    handles: { target: "top", sources: [{ position: "bottom" }] },
    defaultData: () => ({ action: "add_tag", key: "", value: "" }),
    validate: (d) => d.key ? "ok" : "missing",
    summary: (d) => {
      const verb = d.action === "add_tag" ? "Tag +" : d.action === "remove_tag" ? "Tag -" : d.action === "set_attribute" ? "Set" : "Unset";
      return `${verb} ${d.key || "(no key)"}${d.action === "set_attribute" && d.value ? ` = ${truncate(String(d.value), 16)}` : ""}`;
    },
    Body: ({ data, onChange }) => (
      <div className="space-y-3">
        <Field label="Action">
          <select className={inspectorInput} value={data.action || "add_tag"} onChange={(e) => onChange({ action: e.target.value })}>
            <option value="add_tag">Add tag</option>
            <option value="remove_tag">Remove tag</option>
            <option value="set_attribute">Set attribute</option>
            <option value="remove_attribute">Remove attribute</option>
          </select>
        </Field>
        <Field label={data.action === "add_tag" || data.action === "remove_tag" ? "Tag name" : "Attribute key"}>
          <input className={inspectorInput} value={data.key || ""} onChange={(e) => onChange({ key: e.target.value })} />
        </Field>
        {data.action === "set_attribute" ? (
          <Field label="Value">
            <input className={inspectorInput} value={data.value || ""} onChange={(e) => onChange({ value: e.target.value })} placeholder="supports {{var}}" />
          </Field>
        ) : null}
      </div>
    ),
  },

  bring_user_data: {
    type: "bring_user_data", label: "Bring User Data", color: "rose", icon: ICONS.data, category: "Customer Data",
    handles: { target: "top", sources: [{ position: "bottom" }] },
    defaultData: () => ({ fields: ["displayName", "email"], prefix: "customer" }),
    summary: (d) => `Load ${(d.fields || []).length} field${(d.fields || []).length === 1 ? "" : "s"} → {{${d.prefix || "customer"}_*}}`,
    Body: BringUserDataBody,
  },

  // ── Triggers ──────────────────────────────────────────────────────
  comment_trigger: {
    type: "comment_trigger", label: "Trigger: Comment", color: "emerald", icon: ICONS.comment, category: "Triggers",
    handles: { sources: [{ position: "bottom" }] },
    defaultData: () => ({ postSource: "page", postId: "", postPermalink: "", postCaption: "", channelId: "", keywords: [], replyPublicly: true }),
    summary: (d, shared) => {
      const ch = shared?.channels?.find((c) => c.id === d.channelId);
      const platformLabel = ch?.channel === "INSTAGRAM" ? "IG" : ch?.channel === "MESSENGER" ? "FB" : "FB/IG";
      const where = d.postSource === "group"
        ? "group post"
        : (d.postCaption ? `"${truncate(d.postCaption, 28)}"` : (d.postId ? `post ${String(d.postId).slice(0, 8)}` : "any post"));
      return `${platformLabel} comment on ${where}`;
    },
    Body: CommentTriggerBody,
  },

  keyword_trigger: {
    type: "keyword_trigger", label: "Trigger: Keyword", color: "emerald", icon: ICONS.search, category: "Triggers",
    handles: { sources: [{ position: "bottom" }] },
    defaultData: () => ({ keywords: [], matchType: "any", caseSensitive: false }),
    validate: (d) => (Array.isArray(d.keywords) && d.keywords.length > 0) ? "ok" : "missing",
    summary: (d) => {
      const kw = Array.isArray(d.keywords) ? d.keywords : [];
      if (kw.length === 0) return "(no keywords)";
      return `${d.matchType === "all" ? "All of" : d.matchType === "exact" ? "Equals" : "Any of"}: ${kw.slice(0, 3).join(", ")}${kw.length > 3 ? "…" : ""}`;
    },
    Body: ({ data, onChange }) => (
      <div className="space-y-3">
        <Field label="Keywords (comma-sep)">
          <textarea rows={3} className={inspectorInput + " resize-none"} value={joinKw(data.keywords)} onChange={(e) => onChange({ keywords: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} placeholder="start, help, menu" />
        </Field>
        <Field label="Match type">
          <select className={inspectorInput} value={data.matchType || "any"} onChange={(e) => onChange({ matchType: e.target.value })}>
            <option value="any">Match ANY (contains)</option>
            <option value="all">Match ALL (contains)</option>
            <option value="exact">Exact (equals)</option>
          </select>
        </Field>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={!!data.caseSensitive} onChange={(e) => onChange({ caseSensitive: e.target.checked })} className="accent-emerald-500" />
          Case-sensitive
        </label>
      </div>
    ),
  },

  schedule_trigger: {
    type: "schedule_trigger", label: "Trigger: Schedule", color: "emerald", icon: ICONS.schedule, category: "Triggers",
    handles: { sources: [{ position: "bottom" }] },
    defaultData: () => ({ cron: "0 9 * * *", timezone: "UTC" }),
    validate: (d) => d.cron ? "ok" : "missing",
    summary: (d) => `Cron: ${d.cron || "(none)"} ${d.timezone || "UTC"}`,
    Body: ScheduleTriggerBody,
  },

  webhook_trigger: {
    type: "webhook_trigger", label: "Trigger: Webhook", color: "emerald", icon: ICONS.link, category: "Triggers",
    handles: { sources: [{ position: "bottom" }] },
    defaultData: () => ({ name: "Webhook", workflowId: "" }),
    // The node is only "ok" once a workflow is linked — that's what the
    // WebhookTrigger record (URL + secret) is provisioned against.
    validate: (d) => (String(d.workflowId || "").trim() ? "ok" : "missing"),
    summary: (d, shared) => {
      const id = String(d.workflowId || "").trim();
      if (!id) return "No flow linked yet";
      const flow = shared?.flows?.find((f) => f.id === id);
      return `Runs: ${flow?.name || id}`;
    },
    Body: WebhookTriggerBody,
  },

  // ── Voice triggers ────────────────────────────────────────────
  // Each entry's `type` is the literal `voice_trigger:<kind>` string the
  // voice-flow-runner matches against. See
  // services/ai/src/services/voice-flow/voice-flow-runner.ts.
  "voice_trigger:call.incoming": {
    type: "voice_trigger:call.incoming", label: "Voice: Incoming call", color: "emerald", icon: ICONS.phone, category: "Voice Triggers",
    handles: { sources: [{ position: "bottom" }] },
    defaultData: () => ({}),
    validate: () => "ok",
    summary: () => "When an inbound call rings",
    Body: () => <p className="text-xs text-gray-500">Fires for every inbound call on this channel.</p>,
  },
  "voice_trigger:call.answered": {
    type: "voice_trigger:call.answered", label: "Voice: Call answered", color: "emerald", icon: ICONS.phone, category: "Voice Triggers",
    handles: { sources: [{ position: "bottom" }] },
    defaultData: () => ({}),
    validate: () => "ok",
    summary: () => "When an agent picks up",
    Body: () => <p className="text-xs text-gray-500">Fires when the call transitions to ACTIVE.</p>,
  },
  "voice_trigger:call.missed": {
    type: "voice_trigger:call.missed", label: "Voice: Missed call", color: "emerald", icon: ICONS.phoneEnd, category: "Voice Triggers",
    handles: { sources: [{ position: "bottom" }] },
    defaultData: () => ({}),
    validate: () => "ok",
    summary: () => "Customer hung up before answer",
    Body: () => <p className="text-xs text-gray-500">Fires when state transitions to MISSED.</p>,
  },
  "voice_trigger:call.hangup_customer": {
    type: "voice_trigger:call.hangup_customer", label: "Voice: Customer hung up", color: "emerald", icon: ICONS.phoneEnd, category: "Voice Triggers",
    handles: { sources: [{ position: "bottom" }] },
    defaultData: () => ({}),
    validate: () => "ok",
    summary: () => "Customer ended the call",
    Body: () => <p className="text-xs text-gray-500">Fires when the call ends and the customer disconnected first.</p>,
  },
  "voice_trigger:call.hangup_agent": {
    type: "voice_trigger:call.hangup_agent", label: "Voice: Agent hung up", color: "emerald", icon: ICONS.phoneEnd, category: "Voice Triggers",
    handles: { sources: [{ position: "bottom" }] },
    defaultData: () => ({}),
    validate: () => "ok",
    summary: () => "Agent ended the call",
    Body: () => <p className="text-xs text-gray-500">Fires when the call ends and the agent disconnected first.</p>,
  },
  "voice_trigger:call.intent_detected": {
    type: "voice_trigger:call.intent_detected", label: "Voice: Intent detected", color: "emerald", icon: ICONS.ai, category: "Voice Triggers",
    handles: { sources: [{ position: "bottom" }] },
    defaultData: () => ({ intent: "", minConfidence: 0.6 }),
    validate: (d) => (d.intent && String(d.intent).trim()) ? "ok" : "missing",
    summary: (d) => d.intent ? `Intent: ${d.intent} (≥${d.minConfidence ?? 0.6})` : "(no intent set)",
    Body: ({ data, onChange }) => (
      <div className="space-y-3">
        <Field
          label="Intent name"
          hint='Token-level match. "refund" matches request_refund / process_refund. Use "request_refund" for exact, or "process refund" to require both tokens.'
        >
          <input className={inspectorInput + " font-mono"} value={data.intent || ""} onChange={(e) => onChange({ intent: e.target.value })} placeholder="refund" />
        </Field>
        <Field label="Min confidence (0–1)" hint="0.6 is strict; try 0.4 if matches are missed.">
          <input type="number" min={0} max={1} step={0.05} className={inspectorInput} value={data.minConfidence ?? 0.6} onChange={(e) => onChange({ minConfidence: Math.max(0, Math.min(1, Number(e.target.value) || 0)) })} />
        </Field>
      </div>
    ),
  },
  "voice_trigger:call.keyword_spoken": {
    type: "voice_trigger:call.keyword_spoken", label: "Voice: Keyword spoken", color: "emerald", icon: ICONS.search, category: "Voice Triggers",
    handles: { sources: [{ position: "bottom" }] },
    defaultData: () => ({ keywords: [] }),
    validate: (d) => (Array.isArray(d.keywords) && d.keywords.length > 0) ? "ok" : "missing",
    summary: (d) => {
      const kw = Array.isArray(d.keywords) ? d.keywords : [];
      return kw.length === 0 ? "(no keywords)" : `Any of: ${kw.slice(0, 3).join(", ")}${kw.length > 3 ? "…" : ""}`;
    },
    Body: ({ data, onChange }) => (
      <div className="space-y-3">
        <Field label="Keywords (comma-sep)">
          <textarea rows={3} className={inspectorInput + " resize-none"} value={joinKw(data.keywords)} onChange={(e) => onChange({ keywords: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} placeholder="cancel, refund, escalate" />
        </Field>
        <p className="text-xs text-gray-500">Matches against the rolling call summary. Case-insensitive.</p>
      </div>
    ),
  },

  // ── Voice actions ─────────────────────────────────────────────
  voice_add_participant: {
    type: "voice_add_participant", label: "Voice: Add participant", color: "indigo", icon: ICONS.phone, category: "Voice Actions",
    handles: { target: "top", sources: [{ position: "bottom" }] },
    defaultData: () => ({ to: "", label: "" }),
    validate: (d) => (d.to && String(d.to).trim()) ? "ok" : "missing",
    summary: (d) => d.to ? `Dial ${d.to}` : "(no number)",
    Body: ({ data, onChange }) => (
      <div className="space-y-3">
        <Field label="Phone (E.164)">
          <input className={inspectorInput + " font-mono"} value={data.to || ""} onChange={(e) => onChange({ to: e.target.value })} placeholder="+972..." />
        </Field>
        <Field label="Label (optional)">
          <input className={inspectorInput} value={data.label || ""} onChange={(e) => onChange({ label: e.target.value })} placeholder="manager" />
        </Field>
      </div>
    ),
  },
  // ── Routing target (legacy router-style; kept for back-compat) ────
  route_target: {
    type: "route_target", label: "Route Target", color: "violet", icon: ICONS.agent, category: "Routing",
    handles: { target: "top", sources: [] },
    defaultData: () => ({ routeType: "agent", targetId: "" }),
    validate: (d) => d.targetId ? "ok" : "missing",
    summary: (d, shared) => {
      const list = d.routeType === "agent" ? shared?.agents : d.routeType === "flow" ? shared?.flows : shared?.departments;
      const name = list?.find((o) => o.id === d.targetId)?.name;
      const what = d.routeType === "agent" ? "Agent" : d.routeType === "flow" ? "Sub-flow" : "Human";
      return `${what}: ${name || "(unselected)"}`;
    },
    Body: RouteTargetBody,
  },
};

// ─── Sub-component bodies ─────────────────────────────────────────
function truncate(s: string, n: number) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function ConditionGroupBody({ data, onChange }: { data: any; onChange: (p: any) => void }) {
  const TYPE_OPTIONS: { value: string; label: string }[] = [
    { value: "intent", label: "AI Intent" },
    { value: "keyword", label: "Keyword" },
    { value: "regex", label: "Regex Pattern" },
    { value: "sentiment", label: "Sentiment" },
    { value: "time", label: "Time / Schedule" },
    { value: "attribute", label: "Customer Attribute" },
  ];
  const OPERATOR_OPTIONS: Record<string, { value: string; label: string }[]> = {
    intent:    [{ value: "equals", label: "equals" }, { value: "contains", label: "contains" }, { value: "is_not", label: "is not" }],
    keyword:   [{ value: "contains", label: "contains" }, { value: "equals", label: "equals" }, { value: "starts_with", label: "starts with" }, { value: "ends_with", label: "ends with" }, { value: "is_not", label: "does not contain" }],
    regex:     [{ value: "matches", label: "matches" }, { value: "is_not", label: "does not match" }],
    sentiment: [{ value: "equals", label: "is" }, { value: "is_not", label: "is not" }],
    time:      [{ value: "equals", label: "is" }, { value: "is_not", label: "is not" }],
    attribute: [{ value: "equals", label: "equals" }, { value: "contains", label: "contains" }, { value: "is_not", label: "is not" }],
  };
  const conditions = Array.isArray(data.conditions) ? data.conditions : [];
  function update(id: string, patch: any) {
    onChange({ conditions: conditions.map((c: any) => c.id === id ? { ...c, ...patch } : c) });
  }
  function add() {
    onChange({ conditions: [...conditions, { id: `c_${Date.now()}`, type: "keyword", operator: "contains", value: "" }] });
  }
  function remove(id: string) {
    if (conditions.length <= 1) return;
    onChange({ conditions: conditions.filter((c: any) => c.id !== id) });
  }
  return (
    <div className="space-y-3">
      <Field label="Logic between conditions">
        <select className={inspectorInput} value={data.logic || "AND"} onChange={(e) => onChange({ logic: e.target.value })}>
          <option value="AND">All match (AND)</option>
          <option value="OR">Any match (OR)</option>
        </select>
      </Field>
      <div className="space-y-2">
        <span className="text-xs font-semibold text-gray-700">Conditions</span>
        {conditions.map((cond: any, idx: number) => (
          <div key={cond.id} className="space-y-2 p-3 rounded-lg border border-amber-100 bg-amber-50/30 relative">
            {conditions.length > 1 ? (
              <button onClick={() => remove(cond.id)} className="absolute top-2 right-2 text-xs text-rose-600 hover:underline">remove</button>
            ) : null}
            <select className={inspectorInput} value={cond.type} onChange={(e) => {
              const newType = e.target.value;
              const ops = OPERATOR_OPTIONS[newType] || OPERATOR_OPTIONS.keyword;
              update(cond.id, { type: newType, operator: ops[0].value });
            }}>
              {TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <select className={inspectorInput} value={cond.operator} onChange={(e) => update(cond.id, { operator: e.target.value })}>
              {(OPERATOR_OPTIONS[cond.type] || OPERATOR_OPTIONS.keyword).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            {cond.type === "sentiment" ? (
              <select className={inspectorInput} value={cond.value} onChange={(e) => update(cond.id, { value: e.target.value })}>
                <option value="">Select...</option>
                <option value="positive">Positive</option>
                <option value="neutral">Neutral</option>
                <option value="negative">Negative</option>
              </select>
            ) : cond.type === "time" ? (
              <select className={inspectorInput} value={cond.value} onChange={(e) => update(cond.id, { value: e.target.value })}>
                <option value="">Select...</option>
                <option value="business_hours">Business Hours</option>
                <option value="after_hours">After Hours</option>
                <option value="weekend">Weekend</option>
              </select>
            ) : (
              <input className={inspectorInput} value={cond.value || ""} onChange={(e) => update(cond.id, { value: e.target.value })} placeholder={cond.type === "regex" ? "^order\\s+\\d+" : cond.type === "intent" ? "sales, support..." : "Value..."} />
            )}
            {idx < conditions.length - 1 ? (
              <p className="text-[10px] font-bold text-amber-700 text-center pt-1">{data.logic || "AND"}</p>
            ) : null}
          </div>
        ))}
        <button onClick={add} className="w-full py-2 rounded-lg border border-dashed border-amber-300 text-amber-600 text-xs font-semibold hover:bg-amber-50 transition">+ Add condition</button>
      </div>
    </div>
  );
}

function QuickReplyBody({ data, onChange }: { data: any; onChange: (p: any) => void }) {
  const replies: any[] = Array.isArray(data.replies) ? data.replies : [];
  function update(id: string, patch: any) {
    onChange({ replies: replies.map((r) => r.id === id ? { ...r, ...patch } : r) });
  }
  function add() {
    if (replies.length >= 10) return;
    onChange({ replies: [...replies, { id: `r_${Date.now()}`, label: "", payload: "" }] });
  }
  function remove(id: string) {
    if (replies.length <= 1) return;
    onChange({ replies: replies.filter((r) => r.id !== id) });
  }
  return (
    <div className="space-y-3">
      <Field label="Prompt text">
        <textarea rows={3} className={inspectorInput + " resize-none"} value={data.text || ""} onChange={(e) => onChange({ text: e.target.value })} placeholder="What would you like to do?" />
      </Field>
      <div className="space-y-2">
        <span className="text-xs font-semibold text-gray-700">Options ({replies.length}/10)</span>
        {replies.map((r, i) => (
          <div key={r.id} className="flex gap-2 items-center">
            <input className={inspectorInput + " flex-1"} value={r.label || ""} onChange={(e) => update(r.id, { label: e.target.value, payload: e.target.value.toLowerCase().replace(/\s+/g, "_") })} placeholder={`Option ${i + 1}`} />
            {replies.length > 1 ? (
              <button onClick={() => remove(r.id)} className="text-xs text-rose-600 hover:underline">remove</button>
            ) : null}
          </div>
        ))}
        <button onClick={add} disabled={replies.length >= 10} className="w-full py-2 rounded-lg border border-dashed border-teal-300 text-teal-600 text-xs font-semibold hover:bg-teal-50 transition disabled:opacity-40">+ Add option</button>
      </div>
    </div>
  );
}

function HttpRequestBody({ data, onChange }: { data: any; onChange: (p: any) => void }) {
  const headers: any[] = Array.isArray(data.headers) && data.headers.length > 0 ? data.headers : [{ id: `h_${Date.now()}`, key: "", value: "" }];
  function updateH(id: string, patch: any) {
    onChange({ headers: headers.map((h) => h.id === id ? { ...h, ...patch } : h) });
  }
  function addH() { onChange({ headers: [...headers, { id: `h_${Date.now()}`, key: "", value: "" }] }); }
  function removeH(id: string) { if (headers.length <= 1) return; onChange({ headers: headers.filter((h) => h.id !== id) }); }
  const method = data.method || "GET";
  return (
    <div className="space-y-3">
      <Field label="Method + URL">
        <div className="flex gap-2">
          <select className={inspectorInput + " w-28"} value={method} onChange={(e) => onChange({ method: e.target.value })}>
            <option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option>
          </select>
          <input className={inspectorInput + " flex-1"} value={data.url || ""} onChange={(e) => onChange({ url: e.target.value })} placeholder="https://api.example.com/..." />
        </div>
      </Field>
      <div>
        <span className="text-xs font-semibold text-gray-700 mb-1 block">Headers</span>
        <div className="space-y-1.5">
          {headers.map((h) => (
            <div key={h.id} className="flex gap-2 items-center">
              <input className={inspectorInput + " flex-1"} value={h.key || ""} onChange={(e) => updateH(h.id, { key: e.target.value })} placeholder="Header" />
              <input className={inspectorInput + " flex-1"} value={h.value || ""} onChange={(e) => updateH(h.id, { value: e.target.value })} placeholder="value" />
              {headers.length > 1 ? <button onClick={() => removeH(h.id)} className="text-xs text-rose-600 hover:underline">remove</button> : null}
            </div>
          ))}
          <button onClick={addH} className="w-full py-1.5 rounded-md border border-dashed border-zinc-300 text-zinc-500 text-xs hover:bg-zinc-50">+ Header</button>
        </div>
      </div>
      {(method === "POST" || method === "PUT" || method === "PATCH") ? (
        <Field label="Body (JSON)">
          <textarea rows={4} className={inspectorInput + " font-mono resize-none"} value={data.body || ""} onChange={(e) => onChange({ body: e.target.value })} placeholder='{"key": "{{var}}"}' />
        </Field>
      ) : null}
      <Field label="Save response to">
        <input className={inspectorInput + " font-mono"} value={data.responseVariable || "response"} onChange={(e) => onChange({ responseVariable: e.target.value.replace(/[^a-z0-9_]/gi, "") })} />
      </Field>
      <Field label="JSON path (optional)" hint="e.g. data.items[0].name">
        <input className={inspectorInput + " font-mono"} value={data.jsonPath || ""} onChange={(e) => onChange({ jsonPath: e.target.value })} />
      </Field>
    </div>
  );
}

function BringUserDataBody({ data, onChange }: { data: any; onChange: (p: any) => void }) {
  const AVAILABLE_FIELDS = [
    { key: "displayName", label: "Name" },
    { key: "email", label: "Email" },
    { key: "phone", label: "Phone" },
    { key: "tags", label: "Tags" },
    { key: "metadata", label: "Custom attributes" },
    { key: "source", label: "Source" },
    { key: "lastInteractionAt", label: "Last interaction" },
  ];
  const fields: string[] = Array.isArray(data.fields) ? data.fields : [];
  const prefix: string = data.prefix || "customer";
  function toggle(key: string) {
    onChange({ fields: fields.includes(key) ? fields.filter((f) => f !== key) : [...fields, key] });
  }
  return (
    <div className="space-y-3">
      <Field label="Variable prefix" hint="Stored as {{prefix_field}}.">
        <input className={inspectorInput + " font-mono"} value={prefix} onChange={(e) => onChange({ prefix: e.target.value.replace(/[^a-z0-9_]/gi, "") })} />
      </Field>
      <div>
        <span className="text-xs font-semibold text-gray-700 mb-1 block">Fields to load</span>
        <div className="space-y-1">
          {AVAILABLE_FIELDS.map((f) => (
            <label key={f.key} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-rose-50/40 border border-rose-100/60 cursor-pointer hover:bg-rose-100/40">
              <input type="checkbox" checked={fields.includes(f.key)} onChange={() => toggle(f.key)} className="accent-rose-500" />
              <span className="text-sm text-gray-700 flex-1">{f.label}</span>
              <span className="text-[10px] font-mono text-rose-600">{`{{${prefix}_${f.key}}}`}</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

function ScheduleTriggerBody({ data, onChange }: { data: any; onChange: (p: any) => void }) {
  const PRESETS = [
    { value: "0 9 * * *",   label: "Daily at 09:00" },
    { value: "0 9 * * 1",   label: "Every Monday at 09:00" },
    { value: "0 * * * *",   label: "Every hour" },
    { value: "*/15 * * * *", label: "Every 15 minutes" },
    { value: "0 0 1 * *",   label: "Monthly (1st at 00:00)" },
  ];
  const cron: string = data.cron || "0 9 * * *";
  return (
    <div className="space-y-3">
      <Field label="Preset">
        <select className={inspectorInput} value={PRESETS.find((p) => p.value === cron)?.value || ""} onChange={(e) => { if (e.target.value) onChange({ cron: e.target.value }); }}>
          {PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          <option value="">Custom…</option>
        </select>
      </Field>
      <Field label="Cron expression">
        <input className={inspectorInput + " font-mono"} value={cron} onChange={(e) => onChange({ cron: e.target.value })} />
      </Field>
      <Field label="Timezone">
        <input className={inspectorInput} value={data.timezone || "UTC"} onChange={(e) => onChange({ timezone: e.target.value })} placeholder="America/New_York" />
      </Field>
    </div>
  );
}

// Webhook trigger inspector. Lets the author link the node to a flow, then
// provisions + shows the inbound URL and shared secret for that flow's
// WebhookTrigger record (copy / regenerate / enable-disable). The URL/secret
// state lives on the backend record — never persisted into the canvas JSON —
// so a rotated secret can't go stale here.
function WebhookTriggerBody({ data, onChange, shared }: { data: any; onChange: (p: any) => void; shared?: SharedData }) {
  const { token } = useAuth();
  const workflowId: string = String(data.workflowId || "").trim();
  const flows = shared?.flows || [];

  const [trigger, setTrigger] = React.useState<WebhookTriggerDto | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState<string | null>(null);

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const fullUrl = trigger ? `${origin}${trigger.path}` : "";

  // "How to use" examples — built from the trigger the backend already exposes
  // (no new data is fetched). The secret header name mirrors the inbound route
  // in services/webhook (POST /webhooks/:token, header `x-webhook-secret`).
  const SECRET_HEADER = "x-webhook-secret";
  const samplePayload = `{
  "email": "jane@example.com",
  "name": "Jane Doe",
  "plan": "pro"
}`;
  const samplePayloadInline = '{"email":"jane@example.com","name":"Jane Doe","plan":"pro"}';
  const curlExample = trigger
    ? `curl -X POST '${fullUrl}' \\\n  -H 'Content-Type: application/json' \\\n  -H '${SECRET_HEADER}: ${trigger.secret}' \\\n  -d '${samplePayloadInline}'`
    : "";

  // Load the existing trigger whenever the linked flow changes.
  React.useEffect(() => {
    if (!token || !workflowId) {
      setTrigger(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getWebhookTrigger(token, workflowId)
      .then((r) => { if (!cancelled) setTrigger(r.data); })
      .catch(() => { if (!cancelled) setError("Couldn't load webhook details"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token, workflowId]);

  async function copy(text: string, which: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied((c) => (c === which ? null : c)), 1500);
    } catch {
      setError("Copy failed — select and copy manually");
    }
  }

  async function provision() {
    if (!token || !workflowId) return;
    setBusy(true);
    setError(null);
    try {
      const r = await createWebhookTrigger(token, workflowId);
      setTrigger(r.data);
    } catch {
      setError("Couldn't generate the webhook URL");
    } finally {
      setBusy(false);
    }
  }

  async function regenerate() {
    if (!token || !trigger) return;
    setBusy(true);
    setError(null);
    try {
      const r = await regenerateWebhookSecret(token, trigger.id);
      setTrigger(r.data);
    } catch {
      setError("Couldn't regenerate the secret");
    } finally {
      setBusy(false);
    }
  }

  async function toggleEnabled(next: boolean) {
    if (!token || !trigger) return;
    setBusy(true);
    setError(null);
    try {
      const r = await setWebhookTriggerEnabled(token, trigger.id, next);
      setTrigger(r.data);
    } catch {
      setError("Couldn't update the toggle");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <Field label="Run this flow" hint="The webhook runs this flow when it fires. The flow reads the request body via {{body.*}}.">
        <select className={inspectorInput} value={workflowId} onChange={(e) => onChange({ workflowId: e.target.value })}>
          <option value="">Select a flow…</option>
          {flows.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
      </Field>

      {!workflowId ? (
        <p className="text-[11px] text-gray-400">Pick a flow to generate its webhook URL.</p>
      ) : loading ? (
        <p className="text-xs text-gray-400">Loading webhook…</p>
      ) : !trigger ? (
        <button
          type="button"
          onClick={provision}
          disabled={busy}
          className="w-full text-sm font-medium rounded-lg px-3 py-2 bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 transition"
        >
          {busy ? "Generating…" : "Generate webhook URL"}
        </button>
      ) : (
        <>
          <Field label="Webhook URL" hint="POST your JSON payload here.">
            <div className="flex items-center gap-1.5">
              <input readOnly value={fullUrl} className={inspectorInput + " font-mono text-[11px]"} onFocus={(e) => e.currentTarget.select()} />
              <button type="button" onClick={() => copy(fullUrl, "url")} className="shrink-0 text-xs font-medium rounded-lg px-2.5 py-2 border border-gray-200 hover:bg-gray-50 transition">
                {copied === "url" ? "Copied" : "Copy"}
              </button>
            </div>
          </Field>

          <Field label="Secret" hint="Send as the x-webhook-secret header. Requests without it are rejected (401).">
            <div className="flex items-center gap-1.5">
              <input readOnly value={trigger.secret} className={inspectorInput + " font-mono text-[11px]"} onFocus={(e) => e.currentTarget.select()} />
              <button type="button" onClick={() => copy(trigger.secret, "secret")} className="shrink-0 text-xs font-medium rounded-lg px-2.5 py-2 border border-gray-200 hover:bg-gray-50 transition">
                {copied === "secret" ? "Copied" : "Copy"}
              </button>
            </div>
          </Field>

          <button type="button" onClick={regenerate} disabled={busy} className="text-xs font-medium text-violet-600 hover:text-violet-700 disabled:opacity-50">
            Regenerate secret
          </button>

          <label className="flex items-center gap-2 text-sm text-gray-700 pt-1">
            <input type="checkbox" checked={trigger.enabled} disabled={busy} onChange={(e) => toggleEnabled(e.target.checked)} className="accent-emerald-500" />
            Enabled {trigger.enabled ? "" : "(disabled — inbound calls return 403)"}
          </label>

          {/* How to use — self-serve guide for wiring an external caller without
              leaving the canvas. Reads only the trigger above; adds no backend. */}
          <div className="pt-3 mt-1 border-t border-gray-100 space-y-2.5">
            <p className="text-xs font-semibold text-gray-700">How to use</p>
            <p className="text-[11px] text-gray-400">
              From your external service, send an HTTP <code className="font-mono">POST</code> to the
              Webhook URL above with the secret header
              {" "}<code className="font-mono">{SECRET_HEADER}</code> set to your Secret. Requests
              without a matching secret are rejected (401).
            </p>

            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] font-semibold text-gray-600">curl example</span>
                <button type="button" onClick={() => copy(curlExample, "curl")} className="shrink-0 text-[11px] font-medium rounded-md px-2 py-1 border border-gray-200 hover:bg-gray-50 transition">
                  {copied === "curl" ? "Copied" : "Copy"}
                </button>
              </div>
              <pre className="text-[10.5px] font-mono leading-relaxed bg-gray-900 text-gray-100 rounded-lg p-2.5 overflow-x-auto whitespace-pre">{curlExample}</pre>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] font-semibold text-gray-600">Sample payload</span>
                <button type="button" onClick={() => copy(samplePayload, "payload")} className="shrink-0 text-[11px] font-medium rounded-md px-2 py-1 border border-gray-200 hover:bg-gray-50 transition">
                  {copied === "payload" ? "Copied" : "Copy"}
                </button>
              </div>
              <pre className="text-[10.5px] font-mono leading-relaxed bg-gray-50 border border-gray-200 text-gray-700 rounded-lg p-2.5 overflow-x-auto whitespace-pre">{samplePayload}</pre>
            </div>

            <p className="text-[11px] text-gray-400">
              Reference any payload field downstream with <code className="font-mono">{"{{body.field}}"}</code> — e.g. <code className="font-mono">{"{{body.email}}"}</code> or <code className="font-mono">{"{{body.plan}}"}</code>.
            </p>
          </div>
        </>
      )}

      {error ? <p className="text-[11px] text-rose-500">{error}</p> : null}
    </div>
  );
}

function RouteTargetBody({ data, onChange, shared }: { data: any; onChange: (p: any) => void; shared?: SharedData }) {
  const routeType: string = data.routeType || "agent";
  const list = routeType === "agent" ? shared?.agents : routeType === "flow" ? shared?.flows : shared?.departments;
  return (
    <div className="space-y-3">
      <Field label="Route to">
        <div className="flex rounded-lg border border-gray-200 overflow-hidden">
          {(["agent", "flow", "human"] as const).map((t) => (
            <button key={t} onClick={() => onChange({ routeType: t, targetId: "" })} className={`flex-1 py-2 text-xs font-semibold transition ${routeType === t ? "bg-gray-900 text-white" : "bg-gray-50 text-gray-500 hover:bg-gray-100"}`}>
              {t === "agent" ? "AI Agent" : t === "flow" ? "Sub-flow" : "Human"}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Target">
        <select className={inspectorInput} value={data.targetId || ""} onChange={(e) => onChange({ targetId: e.target.value })}>
          <option value="">Select {routeType === "agent" ? "agent" : routeType === "flow" ? "flow" : "department"}...</option>
          {(list || []).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </Field>
    </div>
  );
}

// ─── Reply to Comment body ───────────────────────────────────────
// Two modes share one card via a tab toggle:
//   text — author writes a literal reply (with {{vars}} interpolation)
//   ai   — author picks an AI Agent; runtime calls generateOneShotReply
//          on the inbound comment text. Fallback text is sent when the
//          LLM returns nothing so the run never goes silent.
function SendCommentReplyBody({ data, onChange, shared }: { data: any; onChange: (p: any) => void; shared?: SharedData }) {
  const mode = data.mode === "ai" ? "ai" : "text";
  return (
    <div className="space-y-3">
      <Field label="Reply with" hint="Posts a public reply on the original comment.">
        <div className="flex rounded-lg border border-gray-200 overflow-hidden">
          {(["text", "ai"] as const).map((t) => (
            <button
              key={t}
              onClick={() => onChange({ mode: t })}
              className={`flex-1 py-2 text-xs font-semibold transition ${mode === t ? "bg-gray-900 text-white" : "bg-gray-50 text-gray-500 hover:bg-gray-100"}`}
            >
              {t === "text" ? "Static text" : "AI Agent"}
            </button>
          ))}
        </div>
      </Field>
      {mode === "ai" ? (
        <>
          <Field label="AI Agent" hint="Drafts the reply using this agent's tone and policy.">
            <select className={inspectorInput} value={data.agentId || ""} onChange={(e) => onChange({ agentId: e.target.value })}>
              <option value="">Select agent...</option>
              {(shared?.agents || []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
          <Field label="Fallback text (optional)" hint="Sent when the AI returns nothing — keeps the flow from going silent.">
            <VariableMentionInput
              value={data.fallbackText || ""}
              onChange={(v) => onChange({ fallbackText: v })}
              placeholder="Thanks for the comment! 🙏"
              tone="emerald"
            />
          </Field>
        </>
      ) : (
        <Field label="Reply text" hint="Use {{comment.text}}, {{comment.from.username}}, etc.">
          <VariableMentionInput
            value={data.text || ""}
            onChange={(v) => onChange({ text: v })}
            placeholder="Thanks for asking, {{comment.from.username}}!"
            tone="emerald"
          />
        </Field>
      )}
    </div>
  );
}

// ─── Comment Trigger body ────────────────────────────────────────
// Two ways to point the trigger at a post:
//   1. "My Page" tab — select a connected FB/IG channel, click "Load posts",
//      pick from the recent-posts list returned by GET /api/channels/:id/posts.
//   2. "Group post" tab — paste the public URL; we extract the post ID
//      from common Meta URL shapes. Group browsing is intentionally NOT
//      supported because Meta deprecated the Groups API in April 2024.
function CommentTriggerBody({ data, onChange, shared }: { data: any; onChange: (p: any) => void; shared?: SharedData }) {
  // Channels list returned by GET /api/channels uses `channel` (the enum)
  // not `type`. Filter to the two platforms that have post comments.
  const allChannels = shared?.channels || [];
  const fbIgChannels = allChannels.filter((c) => c.channel === "MESSENGER" || c.channel === "INSTAGRAM");
  const source: "page" | "group" = data.postSource === "group" ? "group" : "page";
  const [posts, setPosts] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [groupUrl, setGroupUrl] = React.useState<string>(data.postPermalink || "");
  const { token } = useAuth();

  // Auto-fetch when a channel is selected — saves a click and matches the
  // user's expectation that the dropdown drives everything.
  React.useEffect(() => {
    if (data.channelId && token && source === "page") void loadPosts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.channelId, token, source]);

  async function loadPosts() {
    if (!data.channelId) { setError("Pick a channel first"); return; }
    if (!token) { setError("Not authenticated"); return; }
    setLoading(true); setError(null);
    try {
      const res = await getChannelPosts(token, data.channelId, 20);
      setPosts(res.data || []);
    } catch (e: any) {
      setError(e?.message || "Failed to load posts");
    } finally {
      setLoading(false);
    }
  }

  function pickPost(p: any) {
    onChange({ postSource: "page", postId: p.id, postPermalink: p.permalink || "", postCaption: p.caption || "" });
  }

  function applyGroupUrl(url: string) {
    setGroupUrl(url);
    // Common Meta post URL shapes:
    //   https://www.facebook.com/groups/{group}/posts/{postId}/
    //   https://www.facebook.com/groups/{group}/permalink/{postId}/
    //   https://www.facebook.com/{anything}/posts/{postId}
    //   https://m.facebook.com/story.php?story_fbid={postId}&id={pageId}
    const m1 = url.match(/\/posts\/(\d+)/) || url.match(/\/permalink\/(\d+)/);
    const m2 = url.match(/[?&]story_fbid=(\d+)/);
    const m3 = url.match(/[?&]fbid=(\d+)/);
    const id = m1?.[1] || m2?.[1] || m3?.[1] || "";
    onChange({ postSource: "group", postId: id, postPermalink: url, postCaption: "" });
  }

  return (
    <div className="space-y-3">
      {/* Post source tabs — platform is derived from the selected channel,
          so the only choice the author makes is page vs. group. */}
      <div className="flex rounded-lg border border-gray-200 overflow-hidden">
        <button onClick={() => onChange({ postSource: "page" })} className={`flex-1 py-2 text-xs font-semibold transition ${source === "page" ? "bg-gray-900 text-white" : "bg-gray-50 text-gray-500 hover:bg-gray-100"}`}>My Page</button>
        <button onClick={() => onChange({ postSource: "group" })} className={`flex-1 py-2 text-xs font-semibold transition ${source === "group" ? "bg-gray-900 text-white" : "bg-gray-50 text-gray-500 hover:bg-gray-100"}`}>Group post</button>
      </div>

      {source === "page" ? (
        <>
          <Field label="Channel" hint={fbIgChannels.length === 0 ? "Connect a Facebook page or Instagram account in Settings → Channels first." : undefined}>
            <ChannelAccountPicker
              accounts={fbIgChannels.map((c: any) => ({ id: c.id, channel: c.channel, displayName: c.displayName || c.externalId || c.id, externalId: c.externalId }))}
              value={data.channelId || ""}
              onChange={(id) => onChange({ channelId: id, postId: "", postCaption: "", postPermalink: "" })}
              placeholder={fbIgChannels.length === 0 ? "No Facebook / Instagram channels connected" : "Select a channel"}
            />
          </Field>
          {data.channelId ? (
            <button
              onClick={loadPosts}
              disabled={loading}
              className="w-full py-2 rounded-lg bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700 disabled:opacity-40 transition"
            >
              {loading ? "Loading…" : posts.length > 0 ? "Reload posts" : "Load recent posts"}
            </button>
          ) : null}
          {error ? <p className="text-xs text-rose-600 break-words">{error}</p> : null}

          {posts.length > 0 ? (
            <div className="space-y-1.5 max-h-[260px] overflow-y-auto pr-1">
              {posts.map((p) => (
                <button
                  key={p.id}
                  onClick={() => pickPost(p)}
                  className={`w-full flex gap-2 items-start p-2 rounded-lg border text-left transition ${data.postId === p.id ? "border-emerald-400 bg-emerald-50 ring-2 ring-emerald-200" : "border-gray-200 bg-white hover:bg-gray-50"}`}
                >
                  {p.thumbnailUrl ? (
                    <img src={p.thumbnailUrl} alt="" className="w-12 h-12 rounded object-cover shrink-0 bg-gray-100" />
                  ) : (
                    <div className="w-12 h-12 rounded bg-gray-100 flex items-center justify-center text-gray-300 shrink-0">—</div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-gray-700 line-clamp-2">{p.caption || <span className="text-gray-400 italic">(no caption)</span>}</p>
                    <p className="text-[10px] text-gray-400 mt-0.5 font-mono truncate">{p.id}</p>
                  </div>
                </button>
              ))}
            </div>
          ) : null}

          {data.postId && data.postSource === "page" && posts.length === 0 ? (
            <p className="text-[11px] text-gray-500">Currently selected: <span className="font-mono">{data.postId}</span></p>
          ) : null}
        </>
      ) : (
        <>
          <Field label="Post URL" hint="Paste the FB group post URL — we'll extract the ID. Group posts use the page webhook for matching.">
            <input
              className={inspectorInput}
              value={groupUrl}
              onChange={(e) => applyGroupUrl(e.target.value)}
              placeholder="https://www.facebook.com/groups/.../posts/..."
            />
          </Field>
          {data.postId ? (
            <p className="text-[11px] text-gray-500">Extracted ID: <span className="font-mono">{data.postId}</span></p>
          ) : groupUrl ? (
            <p className="text-[11px] text-amber-600">Couldn't extract a post ID from that URL — make sure it's a direct post link.</p>
          ) : null}
        </>
      )}

      <Field label="Keyword filters (comma-sep)" hint="Optional — only fire when the comment contains one of these.">
        <input className={inspectorInput} value={joinKw(data.keywords)} onChange={(e) => onChange({ keywords: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
      </Field>

      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input type="checkbox" checked={data.replyPublicly ?? true} onChange={(e) => onChange({ replyPublicly: e.target.checked })} className="accent-emerald-500" />
        Reply publicly before DM
      </label>
    </div>
  );
}

// ─── send_message_template body ───────────────────────────────────
// Picker over APPROVED WhatsApp templates for this tenant. Once selected,
// extracts `{{placeholder}}` keys from the template body + header text and
// renders one VariableMentionInput per placeholder; values are stored under
// `data.variables[key]`. Header media URL is exposed separately when the
// template uses an IMAGE/VIDEO/DOCUMENT header — it overrides the template's
// example URL at send time.
//
// Mirrors broadcasts: the runtime executor calls the same WhatsApp adapter
// path and substitutes variables identically.
interface TemplateRow {
  id: string;
  name: string;
  language: string;
  status: string;
  body: string;
  headerType: string | null;
  headerContent: string | null;
  variables?: Array<{ key: string; sample?: string }>;
}

function extractPlaceholderKeys(text: string | null | undefined): string[] {
  if (!text) return [];
  const re = /\{\{\s*([\w-]+)\s*\}\}/g;
  const seen = new Set<string>();
  const order: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (!seen.has(m[1])) { seen.add(m[1]); order.push(m[1]); }
  }
  return order;
}

// Common CRM aliases the resolver guarantees on every contact, regardless
// of which CRM module (leads/contacts/accounts/deals) the tenant uses.
// Same alias surface as `resolveCrmFieldFromContact` in outbound/scheduled.
const COMMON_CRM_FIELDS: { name: string; label: string }[] = [
  { name: "displayName", label: "Full name" },
  { name: "firstName", label: "First name" },
  { name: "lastName", label: "Last name" },
  { name: "phone", label: "Phone" },
  { name: "email", label: "Email" },
  { name: "source", label: "Source" },
];

interface CrmSchemaField { name: string; label: string; type?: string }

// Each variable value is one of:
//   - plain text        → "Hello {{customer_name}}"  (with mention support)
//   - "crm:<fieldName>" → look up the field on the conversation's contact
// Encoded as a single string per outbound-campaign convention so the runtime
// resolvers in incoming-worker + voice-flow-runner can share a parser.
function isCrmValue(v: unknown): v is string {
  return typeof v === "string" && v.startsWith("crm:");
}
function readCrmField(v: string): string {
  return v.startsWith("crm:") ? v.slice(4) : "";
}

function SendMessageTemplateBody({ data, onChange }: { data: any; onChange: (p: any) => void }) {
  const { token } = useAuth();
  const [templates, setTemplates] = React.useState<TemplateRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [crmFields, setCrmFields] = React.useState<CrmSchemaField[]>([]);

  React.useEffect(() => {
    let cancelled = false;
    if (!token) return;
    setLoading(true);
    getTemplates(token, { channel: "WHATSAPP", status: "APPROVED", limit: "200" })
      .then((res) => { if (!cancelled) setTemplates((res.data || []) as TemplateRow[]); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "load_failed"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token]);

  // Pull tenant CRM schema (both leads + contacts) once, merge unique fields.
  // Failures are silent — the picker still ships the common alias list above.
  React.useEffect(() => {
    if (!token) return;
    let cancelled = false;
    Promise.all([
      getAudienceSchema(token, "leads").catch(() => null),
      getAudienceSchema(token, "contacts").catch(() => null),
    ]).then((results) => {
      if (cancelled) return;
      const seen = new Set<string>();
      const merged: CrmSchemaField[] = [];
      for (const res of results) {
        const fields = ((res?.data as any)?.crm?.schema?.fields ?? []) as CrmSchemaField[];
        for (const f of fields) {
          if (!f?.name || seen.has(f.name)) continue;
          seen.add(f.name);
          merged.push(f);
        }
      }
      setCrmFields(merged);
    });
    return () => { cancelled = true; };
  }, [token]);

  const selected = templates.find((t) => t.id === data.templateId) || null;
  // Union of body + header placeholders, in declared order.
  const placeholderKeys = React.useMemo(() => {
    if (!selected) return [];
    const fromBody = extractPlaceholderKeys(selected.body);
    const fromHeader = selected.headerType === "TEXT" ? extractPlaceholderKeys(selected.headerContent) : [];
    const merged: string[] = [];
    const seen = new Set<string>();
    for (const k of [...fromHeader, ...fromBody]) {
      if (!seen.has(k)) { seen.add(k); merged.push(k); }
    }
    return merged;
  }, [selected]);

  function pickTemplate(id: string) {
    const t = templates.find((row) => row.id === id);
    onChange({
      templateId: id,
      templateName: t?.name || "",
      language: t?.language || "",
      variables: {},
      headerMediaUrl: "",
    });
  }

  function updateVar(key: string, value: string) {
    const next = { ...(data.variables || {}), [key]: value };
    onChange({ variables: next });
  }

  const hasMediaHeader = selected?.headerType === "IMAGE" || selected?.headerType === "VIDEO" || selected?.headerType === "DOCUMENT";
  const headerVal = String(data.headerMediaUrl || "");
  const headerIsCrm = isCrmValue(headerVal);
  const headerCrmField = headerIsCrm ? readCrmField(headerVal) : "";

  return (
    <div className="space-y-3">
      <Field label="Template" hint="Only APPROVED WhatsApp templates for this tenant are listed.">
        {loading ? (
          <div className="text-xs text-gray-400 py-2">Loading templates…</div>
        ) : error ? (
          <div className="text-xs text-rose-600 py-2">Couldn't load templates.</div>
        ) : templates.length === 0 ? (
          <div className="text-xs text-gray-500 py-2">
            No approved WhatsApp templates yet. Create one in Settings → Templates and submit it to Meta.
          </div>
        ) : (
          <select
            className={inspectorInput}
            value={data.templateId || ""}
            onChange={(e) => pickTemplate(e.target.value)}
          >
            <option value="">(pick a template)</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} · {t.language}
              </option>
            ))}
          </select>
        )}
      </Field>

      {!loading && data.templateId && !selected ? (
        <div className="text-[11px] text-rose-600 bg-rose-50 rounded-lg px-3 py-2 ring-1 ring-rose-200">
          The previously selected template is no longer available. Pick another.
        </div>
      ) : null}

      {/* Header media URL — same Static/CRM picker pattern as the variables
          below, so authors can pull the live image/PDF/video URL from a
          contact field (e.g. invoice_pdf_url) instead of hard-coding one. */}
      {selected && hasMediaHeader ? (
        <div className="rounded-xl border border-emerald-100 bg-emerald-50/40 p-3 space-y-2">
          <div className="text-xs font-semibold text-emerald-900">
            Header {selected.headerType?.toLowerCase()}
          </div>
          <div className="flex items-center gap-2">
            <select
              value={headerIsCrm ? "crm" : "static"}
              onChange={(e) => onChange({ headerMediaUrl: e.target.value === "crm" ? "crm:" : "" })}
              className="text-xs px-2 py-1 rounded border border-gray-200 bg-white shrink-0"
            >
              <option value="static">Static URL</option>
              <option value="crm">From CRM field</option>
            </select>
            {headerIsCrm ? (
              <CrmFieldPicker
                value={headerCrmField}
                fields={crmFields}
                onChange={(field) => onChange({ headerMediaUrl: `crm:${field}` })}
              />
            ) : (
              <div className="flex-1 min-w-[140px]">
                <VariableMentionInput
                  value={headerVal}
                  onChange={(v) => onChange({ headerMediaUrl: v })}
                  placeholder={`https://.../${selected.headerType?.toLowerCase()}`}
                  tone="emerald"
                />
              </div>
            )}
          </div>
          <p className="text-[11px] text-emerald-700/80">
            Overrides the template's example media at send time. Variables and CRM fields supported.
          </p>
        </div>
      ) : null}

      {selected && placeholderKeys.length > 0 ? (
        <div className="rounded-xl border border-violet-100 bg-violet-50/40 p-3 space-y-2">
          <div className="text-xs font-semibold text-violet-900">Template variables</div>
          <div className="text-[11px] text-violet-700/80">
            Static = literal text with flow {`{{var}}`} mentions. CRM = pulled from the conversation's contact (displayName, phone, email, or any tenant CRM field).
          </div>
          <div className="space-y-2">
            {placeholderKeys.map((key) => {
              const declaredSample = (selected.variables || []).find((v) => v.key === key)?.sample;
              const raw = String((data.variables || {})[key] || "");
              const isCrm = isCrmValue(raw);
              const crmField = isCrm ? readCrmField(raw) : "";
              return (
                <div key={key} className="flex flex-wrap items-center gap-2 bg-white rounded-lg border border-gray-200 p-2 min-w-0">
                  <code className="px-2 py-1 text-xs font-mono bg-gray-100 rounded shrink-0">{`{{${key}}}`}</code>
                  <select
                    value={isCrm ? "crm" : "static"}
                    onChange={(e) => updateVar(key, e.target.value === "crm" ? "crm:" : "")}
                    className="text-xs px-2 py-1 rounded border border-gray-200 bg-gray-50 shrink-0"
                  >
                    <option value="static">Static</option>
                    <option value="crm">From CRM</option>
                  </select>
                  {isCrm ? (
                    <CrmFieldPicker
                      value={crmField}
                      fields={crmFields}
                      onChange={(field) => updateVar(key, `crm:${field}`)}
                    />
                  ) : (
                    <div className="flex-1 min-w-[140px]">
                      <VariableMentionInput
                        value={raw}
                        onChange={(v) => updateVar(key, v)}
                        placeholder={declaredSample || `value for ${key}`}
                        tone="emerald"
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {selected && placeholderKeys.length === 0 ? (
        <div className="text-[11px] text-gray-400">This template has no body variables.</div>
      ) : null}

      {selected ? (
        <div className="text-[11px] text-gray-400 bg-gray-50 rounded-lg px-3 py-2 line-clamp-4 whitespace-pre-wrap">
          {selected.body || "(empty body)"}
        </div>
      ) : null}
    </div>
  );
}

// Shared CRM-field <select> — common aliases on top, full tenant schema below.
// Used for both header media and per-variable mapping so the picker UX stays
// identical across the inspector.
function CrmFieldPicker({
  value,
  fields,
  onChange,
}: {
  value: string;
  fields: CrmSchemaField[];
  onChange: (field: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="flex-1 min-w-[140px] max-w-full text-xs px-2 py-1 rounded border border-gray-200 bg-white truncate"
    >
      <option value="">Pick CRM field…</option>
      <optgroup label="Common">
        {COMMON_CRM_FIELDS.map((f) => (
          <option key={f.name} value={f.name}>{f.label}</option>
        ))}
      </optgroup>
      {fields.length > 0 && (
        <optgroup label="All CRM fields">
          {fields.map((f) => (
            <option key={f.name} value={f.name}>
              {f.label} ({f.name})
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}

// ─── Helper for editor: default data lookup ───────────────────────
export function defaultDataFor(type: string): Record<string, any> {
  const entry = NODE_REGISTRY[type];
  return entry ? entry.defaultData() : {};
}
