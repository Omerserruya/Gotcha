"use client";

import { useState, useEffect, useCallback, useMemo, useRef, DragEvent } from "react";
import ReactFlow, {
  Node,
  Edge,
  addEdge,
  Connection,
  useNodesState,
  useEdgesState,
  Controls,
  Background,
  BackgroundVariant,
  NodeTypes,
  Panel,
  MarkerType,
  ReactFlowInstance,
  ReactFlowProvider,
  MiniMap,
} from "reactflow";
import "reactflow/dist/style.css";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import {
  getRouterRules,
  getAIAgents,
  getChatbotFlows,
  getChannels,
  getDepartments,
  getFlowCanvas,
  saveFlowCanvas,
} from "@/lib/api";
import { ChannelEntryNode } from "./ChannelEntryNode";
import { ConditionGroupNode } from "./ConditionGroupNode";
import { RouteTargetNode } from "./RouteTargetNode";
import { DefaultFallbackNode } from "./DefaultFallbackNode";
import { StartNode } from "./StartNode";
import { EndNode } from "./EndNode";
import { SendMessageTextNode } from "./SendMessageTextNode";
import { SendMessageInteractiveNode } from "./SendMessageInteractiveNode";
import { SendMessageQuickReplyNode } from "./SendMessageQuickReplyNode";
import { SendMessageImageNode } from "./SendMessageImageNode";
import { SendMessageFileNode } from "./SendMessageFileNode";
import { WaitNode } from "./WaitNode";
import { CollectInputNode } from "./CollectInputNode";
import { SetVariableNode } from "./SetVariableNode";
import { HttpRequestNode } from "./HttpRequestNode";
import { AIGenerateNode } from "./AIGenerateNode";
import { UpdateCustomerNode } from "./UpdateCustomerNode";
import { BringUserDataNode } from "./BringUserDataNode";
import { CommentTriggerNode } from "./CommentTriggerNode";
import { KeywordTriggerNode } from "./KeywordTriggerNode";
import { ScheduleTriggerNode } from "./ScheduleTriggerNode";
import { TemplateGalleryModal } from "./TemplateGalleryModal";
import { validateFlow } from "./flow-validator";
import { FlowIssuesPill } from "./FlowIssuesPill";
import { NodeInspector } from "./NodeInspector";

// ─── Node types ────────────────────────────────────────────────
const nodeTypes: NodeTypes = {
  channel_entry: ChannelEntryNode,
  condition_group: ConditionGroupNode,
  route_target: RouteTargetNode,
  default_fallback: DefaultFallbackNode,
  start: StartNode,
  end: EndNode,
  send_message_text: SendMessageTextNode,
  send_message_interactive: SendMessageInteractiveNode,
  send_message_quick_reply: SendMessageQuickReplyNode,
  send_message_image: SendMessageImageNode,
  send_message_file: SendMessageFileNode,
  // Control / actions
  wait: WaitNode,
  collect_input: CollectInputNode,
  set_variable: SetVariableNode,
  // Integrations / AI
  http_request: HttpRequestNode,
  ai_generate: AIGenerateNode,
  // Customer data
  update_customer: UpdateCustomerNode,
  bring_user_data: BringUserDataNode,
  // Triggers (entry variants)
  comment_trigger: CommentTriggerNode,
  keyword_trigger: KeywordTriggerNode,
  schedule_trigger: ScheduleTriggerNode,
};

// ─── Node palette ──────────────────────────────────────────────
// Shared palette for Main Playbook AND sub-flow editors.
// Export so the sub-flow editor can reuse the same items.
export const NODE_PALETTE = [
  {
    category: "Triggers",
    items: [
      {
        type: "comment_trigger",
        label: "Comment Received",
        desc: "IG/FB post comments (author-only)",
        color: "emerald", bg: "bg-emerald-50", border: "border-emerald-200", text: "text-emerald-600",
        iconBg: "bg-emerald-100", hoverBg: "hover:bg-emerald-100", ring: "ring-emerald-300",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 20.25c4.97 0 9-3.694 9-8.25s-4.03-8.25-9-8.25S3 7.444 3 12c0 2.104.859 4.023 2.273 5.48.432.447.74 1.04.586 1.641a4.483 4.483 0 01-.923 1.785A5.969 5.969 0 006 21c1.282 0 2.47-.402 3.445-1.087.81.22 1.668.337 2.555.337z" />
          </svg>
        ),
      },
      {
        type: "keyword_trigger",
        label: "Keyword Trigger",
        desc: "Fires on matching inbound",
        color: "emerald", bg: "bg-emerald-50", border: "border-emerald-200", text: "text-emerald-600",
        iconBg: "bg-emerald-100", hoverBg: "hover:bg-emerald-100", ring: "ring-emerald-300",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
          </svg>
        ),
      },
      {
        type: "schedule_trigger",
        label: "Schedule Trigger",
        desc: "Cron schedule (author-only)",
        color: "emerald", bg: "bg-emerald-50", border: "border-emerald-200", text: "text-emerald-600",
        iconBg: "bg-emerald-100", hoverBg: "hover:bg-emerald-100", ring: "ring-emerald-300",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75" />
          </svg>
        ),
      },
    ],
  },
  {
    category: "Flow Control",
    items: [
      {
        type: "start",
        label: "Start",
        desc: "Entry point (required for sub-flows)",
        color: "emerald",
        bg: "bg-emerald-50",
        border: "border-emerald-200",
        text: "text-emerald-600",
        iconBg: "bg-emerald-100",
        hoverBg: "hover:bg-emerald-100",
        ring: "ring-emerald-300",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z" />
          </svg>
        ),
      },
      {
        type: "end",
        label: "End",
        desc: "Close / handoff / wait",
        color: "rose",
        bg: "bg-rose-50",
        border: "border-rose-200",
        text: "text-rose-600",
        iconBg: "bg-rose-100",
        hoverBg: "hover:bg-rose-100",
        ring: "ring-rose-300",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 7.5A2.25 2.25 0 017.5 5.25h9a2.25 2.25 0 012.25 2.25v9a2.25 2.25 0 01-2.25 2.25h-9a2.25 2.25 0 01-2.25-2.25v-9z" />
          </svg>
        ),
      },
      {
        type: "wait",
        label: "Wait / Delay",
        desc: "Pause N seconds/minutes",
        color: "orange", bg: "bg-orange-50", border: "border-orange-200", text: "text-orange-600",
        iconBg: "bg-orange-100", hoverBg: "hover:bg-orange-100", ring: "ring-orange-300",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        ),
      },
    ],
  },
  {
    category: "Logic",
    items: [
      {
        type: "condition_group",
        label: "Condition",
        desc: "Branch on conditions (match/no match)",
        color: "amber",
        bg: "bg-amber-50",
        border: "border-amber-200",
        text: "text-amber-600",
        iconBg: "bg-amber-100",
        hoverBg: "hover:bg-amber-100",
        ring: "ring-amber-300",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
          </svg>
        ),
      },
    ],
  },
  {
    category: "Messages",
    items: [
      {
        type: "send_message_text",
        label: "Send Text",
        desc: "Plain text message",
        color: "sky",
        bg: "bg-sky-50",
        border: "border-sky-200",
        text: "text-sky-600",
        iconBg: "bg-sky-100",
        hoverBg: "hover:bg-sky-100",
        ring: "ring-sky-300",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
          </svg>
        ),
      },
      {
        type: "send_message_interactive",
        label: "Send Interactive (Link)",
        desc: "Text + CTA button with URL",
        color: "indigo",
        bg: "bg-indigo-50",
        border: "border-indigo-200",
        text: "text-indigo-600",
        iconBg: "bg-indigo-100",
        hoverBg: "hover:bg-indigo-100",
        ring: "ring-indigo-300",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" />
          </svg>
        ),
      },
      {
        type: "send_message_quick_reply",
        label: "Send Quick Reply",
        desc: "Prompt with tappable options",
        color: "teal",
        bg: "bg-teal-50",
        border: "border-teal-200",
        text: "text-teal-600",
        iconBg: "bg-teal-100",
        hoverBg: "hover:bg-teal-100",
        ring: "ring-teal-300",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
          </svg>
        ),
      },
      {
        type: "send_message_image",
        label: "Send Image",
        desc: "Image from URL + caption",
        color: "fuchsia",
        bg: "bg-fuchsia-50",
        border: "border-fuchsia-200",
        text: "text-fuchsia-600",
        iconBg: "bg-fuchsia-100",
        hoverBg: "hover:bg-fuchsia-100",
        ring: "ring-fuchsia-300",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
          </svg>
        ),
      },
      {
        type: "send_message_file",
        label: "Send File",
        desc: "File from URL (PDF, doc, ...)",
        color: "slate",
        bg: "bg-slate-50",
        border: "border-slate-200",
        text: "text-slate-600",
        iconBg: "bg-slate-100",
        hoverBg: "hover:bg-slate-100",
        ring: "ring-slate-300",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
          </svg>
        ),
      },
    ],
  },
  {
    category: "Data",
    items: [
      {
        type: "collect_input",
        label: "Collect Input",
        desc: "Ask + capture user reply",
        color: "blue", bg: "bg-blue-50", border: "border-blue-200", text: "text-blue-600",
        iconBg: "bg-blue-100", hoverBg: "hover:bg-blue-100", ring: "ring-blue-300",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zM19.5 17.25v2.25a2.25 2.25 0 01-2.25 2.25H5.25a2.25 2.25 0 01-2.25-2.25V7.5a2.25 2.25 0 012.25-2.25h2.25" />
          </svg>
        ),
      },
      {
        type: "set_variable",
        label: "Set Variable",
        desc: "Assign a flow variable",
        color: "purple", bg: "bg-purple-50", border: "border-purple-200", text: "text-purple-600",
        iconBg: "bg-purple-100", hoverBg: "hover:bg-purple-100", ring: "ring-purple-300",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
          </svg>
        ),
      },
      {
        type: "bring_user_data",
        label: "Bring User Data",
        desc: "Load contact fields into vars",
        color: "rose", bg: "bg-rose-50", border: "border-rose-200", text: "text-rose-600",
        iconBg: "bg-rose-100", hoverBg: "hover:bg-rose-100", ring: "ring-rose-300",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375" />
          </svg>
        ),
      },
      {
        type: "update_customer",
        label: "Update Customer",
        desc: "Tag / attribute / segment",
        color: "pink", bg: "bg-pink-50", border: "border-pink-200", text: "text-pink-600",
        iconBg: "bg-pink-100", hoverBg: "hover:bg-pink-100", ring: "ring-pink-300",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0" />
          </svg>
        ),
      },
    ],
  },
  {
    category: "Integrations",
    items: [
      {
        type: "http_request",
        label: "HTTP Request",
        desc: "GET/POST external API",
        color: "zinc", bg: "bg-zinc-50", border: "border-zinc-200", text: "text-zinc-700",
        iconBg: "bg-zinc-100", hoverBg: "hover:bg-zinc-100", ring: "ring-zinc-300",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3" />
          </svg>
        ),
      },
      {
        type: "ai_generate",
        label: "AI Generate",
        desc: "Single-shot LLM call",
        color: "violet", bg: "bg-violet-50", border: "border-violet-200", text: "text-violet-600",
        iconBg: "bg-violet-100", hoverBg: "hover:bg-violet-100", ring: "ring-violet-300",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
          </svg>
        ),
      },
    ],
  },
  {
    category: "Destinations",
    items: [
      {
        type: "route_target",
        label: "Route To",
        desc: "AI agent, sub-flow, or human",
        color: "violet",
        bg: "bg-violet-50",
        border: "border-violet-200",
        text: "text-violet-600",
        iconBg: "bg-violet-100",
        hoverBg: "hover:bg-violet-100",
        ring: "ring-violet-300",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
          </svg>
        ),
      },
      {
        type: "default_fallback",
        label: "Default Fallback",
        desc: "Catch-all for unmatched",
        color: "gray",
        bg: "bg-gray-50",
        border: "border-gray-200",
        text: "text-gray-500",
        iconBg: "bg-gray-100",
        hoverBg: "hover:bg-gray-100",
        ring: "ring-gray-300",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 12.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 18.75a.75.75 0 110-1.5.75.75 0 010 1.5z" />
          </svg>
        ),
      },
    ],
  },
];

// ─── Layout helpers ────────────────────────────────────────────
const LAYER_GAP_X = 350;
const SIBLING_GAP_Y = 200;

function getDefaultData(type: string, shared: { agents: any[]; flows: any[]; departments: any[] }) {
  switch (type) {
    case "channel_entry":
      return { channelType: "webchat", label: "New Channel", connected: true };
    case "condition_group":
      return { name: "New Condition", logic: "AND", conditions: [{ id: `c_${Date.now()}`, type: "intent", operator: "equals", value: "" }] };
    case "route_target":
      return { routeType: "agent", targetId: "", ...shared };
    case "default_fallback":
      return { routeType: "human", targetId: "", ...shared };
    case "start":
      return { trigger: "message_received" };
    case "end":
      return { kind: "wait_for_reply" };
    case "send_message_text":
      return { text: "" };
    case "send_message_interactive":
      return { text: "", buttonLabel: "", buttonUrl: "" };
    case "send_message_quick_reply":
      return { text: "", replies: [{ id: `r_${Date.now()}`, label: "Yes", payload: "yes" }] };
    case "send_message_image":
      return { url: "", caption: "" };
    case "send_message_file":
      return { url: "", filename: "", caption: "" };
    case "wait":
      return { amount: 5, unit: "seconds" };
    case "collect_input":
      return { prompt: "", variable: "", validation: "any" };
    case "set_variable":
      return { variable: "", value: "" };
    case "http_request":
      return { method: "GET", url: "", headers: [{ id: `h_${Date.now()}`, key: "", value: "" }], body: "", responseVariable: "response", jsonPath: "" };
    case "ai_generate":
      return { prompt: "", responseVariable: "ai_output", model: "fast" };
    case "update_customer":
      return { action: "add_tag", key: "", value: "" };
    case "bring_user_data":
      return { fields: ["displayName", "email"], prefix: "customer" };
    case "comment_trigger":
      return { platform: "instagram", postId: "", keywords: [], replyPublicly: true };
    case "keyword_trigger":
      return { keywords: [], matchType: "any", caseSensitive: false };
    case "schedule_trigger":
      return { cron: "0 9 * * *", timezone: "UTC" };
    default:
      return {};
  }
}

function findClearPosition(existingNodes: Node[]): { x: number; y: number } {
  if (existingNodes.length === 0) return { x: 400, y: 100 };
  let maxX = -Infinity;
  let sumY = 0;
  for (const n of existingNodes) {
    if (n.position.x > maxX) maxX = n.position.x;
    sumY += n.position.y;
  }
  return { x: maxX + LAYER_GAP_X, y: sumY / existingNodes.length };
}

// ─── Build initial nodes from channels + rules ─────────────────
function buildNodesFromData(
  channels: any[],
  rules: any[],
  agents: any[],
  flows: any[],
  departments: any[],
  savedLayout?: { nodes: any[]; edges: any[] } | null,
): { nodes: Node[]; edges: Edge[] } {
  // If there's a saved layout, use it
  if (savedLayout?.nodes?.length) {
    const shared = { agents, flows, departments };
    const restoredNodes: Node[] = savedLayout.nodes.map((n: any) => ({
      id: n.id,
      type: n.type,
      position: n.position,
      data: {
        ...n.data,
        ...(n.type === "route_target" || n.type === "default_fallback" ? shared : {}),
      },
    }));
    const restoredEdges: Edge[] = (savedLayout.edges || []).map((e: any) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle,
      type: "smoothstep",
      animated: true,
      style: { stroke: "#7c5cfc", strokeWidth: 2 },
      markerEnd: { type: MarkerType.ArrowClosed, color: "#7c5cfc", width: 16, height: 16 },
    }));
    return { nodes: restoredNodes, edges: restoredEdges };
  }

  // Otherwise build from channel connections + router rules
  const nodesOut: Node[] = [];
  const edgesOut: Edge[] = [];
  const shared = { agents, flows, departments };

  // 1. Channel entry nodes (left column) — one per connected channel
  let channelY = 50;
  const channelNodeIds: string[] = [];
  for (const ch of channels) {
    const type = (ch.channel || ch.type || ch.channelType || "WEBCHAT").toLowerCase();
    const nodeId = `ch_${ch.id || type}_${channelNodeIds.length}`;
    const platformNames: Record<string, string> = {
      whatsapp: "WhatsApp",
      instagram: "Instagram",
      facebook: "Facebook Messenger",
      messenger: "Facebook Messenger",
      email: "Email",
      sms: "SMS",
      webchat: "Webchat Widget",
      gmail: "Gmail",
    };
    nodesOut.push({
      id: nodeId,
      type: "channel_entry",
      position: { x: 50, y: channelY },
      data: {
        channelType: type,
        label: ch.displayName || ch.name || platformNames[type] || type.charAt(0).toUpperCase() + type.slice(1),
        platformName: platformNames[type] || type.charAt(0).toUpperCase() + type.slice(1),
        accountName: ch.displayName || ch.accountName || "",
        connected: ch.connectionStatus === "CONNECTED" || ch.status === "CONNECTED" || ch.connected,
      },
    });
    channelNodeIds.push(nodeId);
    channelY += SIBLING_GAP_Y;
  }

  // If no channels, add a placeholder webchat
  if (channelNodeIds.length === 0) {
    nodesOut.push({
      id: "ch_webchat_0",
      type: "channel_entry",
      position: { x: 50, y: 50 },
      data: { channelType: "webchat", label: "Webchat", connected: true },
    });
    channelNodeIds.push("ch_webchat_0");
  }

  // 2. Condition + Route target nodes from rules (middle + right columns)
  // Sort by `position` (new). Fall back to the legacy `priority` field only
  // until the in-flight migration drops it from the API response.
  const nonDefaultRules = rules
    .filter((r: any) => !r.isDefault)
    .sort((a: any, b: any) => (a.position ?? a.priority ?? 0) - (b.position ?? b.priority ?? 0));
  const defaultRule = rules.find((r: any) => r.isDefault);

  let ruleY = 50;
  for (const rule of nonDefaultRules) {
    const condId = `cond_${rule.id}`;
    const routeId = `route_${rule.id}`;

    // Map API condition types
    const conditions = (rule.conditions || []).map((c: any, i: number) => ({
      id: c.id || `c_${i}`,
      type: c.type || "intent",
      operator: c.operator || "equals",
      value: c.value || "",
    }));

    nodesOut.push({
      id: condId,
      type: "condition_group",
      position: { x: 400, y: ruleY },
      data: {
        name: rule.name,
        logic: rule.logic || "AND",
        conditions: conditions.length > 0 ? conditions : [{ id: `c_${Date.now()}`, type: "intent", operator: "equals", value: "" }],
      },
    });

    // Determine route type
    const routeTypeMap: Record<string, string> = { AI_AGENT: "agent", FLOW: "flow", HUMAN: "human", DEPARTMENT: "human" };
    const routeType = routeTypeMap[rule.routeType] || "agent";
    const targetId = rule.routeType === "AI_AGENT" ? (rule.aiAgentId || "") : (rule.routeTarget || "");

    nodesOut.push({
      id: routeId,
      type: "route_target",
      position: { x: 800, y: ruleY },
      data: { routeType, targetId, ...shared },
    });

    // Edges: all channels -> condition
    for (const chId of channelNodeIds) {
      edgesOut.push({
        id: `e_${chId}_${condId}`,
        source: chId,
        target: condId,
        type: "smoothstep",
        animated: true,
        style: { stroke: "#7c5cfc", strokeWidth: 2 },
        markerEnd: { type: MarkerType.ArrowClosed, color: "#7c5cfc", width: 16, height: 16 },
      });
    }

    // Edge: condition (match) -> route target
    edgesOut.push({
      id: `e_${condId}_${routeId}`,
      source: condId,
      sourceHandle: "true",
      target: routeId,
      type: "smoothstep",
      animated: true,
      style: { stroke: "#16a34a", strokeWidth: 2 },
      markerEnd: { type: MarkerType.ArrowClosed, color: "#16a34a", width: 16, height: 16 },
    });

    ruleY += SIBLING_GAP_Y + 80;
  }

  // 3. Default fallback
  if (defaultRule) {
    const fallbackId = "default_fallback";
    const routeTypeMap: Record<string, string> = { AI_AGENT: "agent", FLOW: "flow", HUMAN: "human", DEPARTMENT: "human" };
    const routeType = routeTypeMap[defaultRule.routeType] || "human";
    const targetId = defaultRule.routeType === "AI_AGENT" ? (defaultRule.aiAgentId || "") : (defaultRule.routeTarget || "");

    nodesOut.push({
      id: fallbackId,
      type: "default_fallback",
      position: { x: 600, y: ruleY + 50 },
      data: { routeType, targetId, ...shared },
    });

    // Connect last condition's "no match" to fallback
    if (nonDefaultRules.length > 0) {
      const lastCondId = `cond_${nonDefaultRules[nonDefaultRules.length - 1].id}`;
      edgesOut.push({
        id: `e_${lastCondId}_fallback`,
        source: lastCondId,
        sourceHandle: "false",
        target: fallbackId,
        type: "smoothstep",
        animated: true,
        style: { stroke: "#ef4444", strokeWidth: 2 },
        markerEnd: { type: MarkerType.ArrowClosed, color: "#ef4444", width: 16, height: 16 },
      });
    } else {
      // Connect channels directly to fallback
      for (const chId of channelNodeIds) {
        edgesOut.push({
          id: `e_${chId}_fallback`,
          source: chId,
          target: fallbackId,
          type: "smoothstep",
          animated: true,
          style: { stroke: "#7c5cfc", strokeWidth: 2 },
          markerEnd: { type: MarkerType.ArrowClosed, color: "#7c5cfc", width: 16, height: 16 },
        });
      }
    }
  }

  // Deduplicate edges (same source-target pairs from multiple channels)
  const seen = new Set<string>();
  const dedupedEdges: Edge[] = [];
  for (const e of edgesOut) {
    const key = `${e.source}_${e.sourceHandle || ""}_${e.target}`;
    if (!seen.has(key)) {
      seen.add(key);
      dedupedEdges.push(e);
    }
  }

  return { nodes: nodesOut, edges: dedupedEdges };
}

// ─── Persist layout to localStorage ────────────────────────────
const LAYOUT_KEY = "mainPlaybookLayout";

function saveLayout(nodes: Node[], edges: Edge[]) {
  const data = {
    nodes: nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, data: { ...n.data, agents: undefined, flows: undefined, departments: undefined } })),
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle })),
  };
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(data)); } catch {}
}

function loadLayout(): { nodes: any[]; edges: any[] } | null {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
}

// ─── Main Component ────────────────────────────────────────────
interface Props {
  onBack?: () => void;
}

export function MainPlaybookEditor(props: Props) {
  // Wrap so that the side-panel Inspector — which renders OUTSIDE <ReactFlow>
  // but inside the editor — can call hooks like useReactFlow (used by
  // VariableMentionInput's variable scanner) and share state with the canvas.
  return (
    <ReactFlowProvider>
      <MainPlaybookEditorInner {...props} />
    </ReactFlowProvider>
  );
}

function MainPlaybookEditorInner({ onBack }: Props) {
  const { token } = useAuth();
  const { t } = useI18n();
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(true);
  // Template gallery — auto-opens once on an empty canvas to give new users a
  // starting point. We track whether we've already auto-opened so a user who
  // dismisses it doesn't get re-prompted every render.
  const [templateGalleryOpen, setTemplateGalleryOpen] = useState(false);
  const [savedToast, setSavedToast] = useState<string | null>(null);
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null);
  // Per the Flow Builder UX spec: nodes are read-only on canvas and ALL
  // configuration happens in the side-panel Inspector. Track the selected
  // node id to drive the panel.
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Validator — recomputed whenever the graph changes. Cheap, O(nodes+edges).
  const issues = useMemo(
    () => validateFlow(nodes as any, edges as any),
    [nodes, edges],
  );

  // Pan the canvas to a specific node (used when clicking an issue row).
  const focusNode = useCallback(
    (nodeId: string) => {
      const n = nodes.find((x) => x.id === nodeId);
      if (!n || !reactFlowInstance) return;
      reactFlowInstance.setCenter(n.position.x + 130, n.position.y + 90, { zoom: 1.2, duration: 400 });
    },
    [nodes, reactFlowInstance],
  );

  // Shared data for dropdowns inside nodes
  const [agents, setAgents] = useState<any[]>([]);
  const [flows, setFlows] = useState<any[]>([]);
  const [departments, setDepartments] = useState<any[]>([]);
  const [channels, setChannels] = useState<any[]>([]);
  const [rules, setRules] = useState<any[]>([]);

  // Load all data.
  // Source of truth for the graph is the server-persisted FlowCanvas.
  // Only fall back to the legacy RouterRule-derived layout when no canvas
  // exists yet (first open on a tenant that still has only old rules).
  useEffect(() => {
    if (!token) return;
    Promise.all([
      getChannels(token).then((r) => r.data || r || []),
      getRouterRules(token).then((r) => r.data || []),
      getAIAgents(token).then((r) => r.data || []),
      getChatbotFlows(token).then((r) => (Array.isArray(r) ? r : (r as any).data || [])),
      getDepartments(token).then((r) => r.data || []),
      getFlowCanvas(token).then((r) => r.data || null).catch(() => null),
    ])
      .then(([channelsData, rulesData, agentsData, flowsData, deptsData, canvasData]) => {
        setChannels(channelsData);
        setRules(rulesData);
        setAgents(agentsData);
        setFlows(flowsData);
        setDepartments(deptsData);

        const shared = { agents: agentsData, flows: flowsData, departments: deptsData };
        const serverCanvas = canvasData && Array.isArray(canvasData.nodes) && canvasData.nodes.length > 0
          ? { nodes: canvasData.nodes, edges: canvasData.edges || [] }
          : null;

        if (serverCanvas) {
          // Restore directly from the persisted graph — this is THE flow.
          const restoredNodes: Node[] = serverCanvas.nodes.map((n: any) => ({
            id: n.id,
            type: n.type,
            position: n.position,
            data: {
              ...n.data,
              ...(n.type === "route_target" || n.type === "default_fallback" ? shared : {}),
            },
          }));
          const restoredEdges: Edge[] = (serverCanvas.edges || []).map((e: any) => ({
            id: e.id,
            source: e.source,
            target: e.target,
            sourceHandle: e.sourceHandle,
            type: "smoothstep",
            animated: true,
            style: { stroke: "#7c5cfc", strokeWidth: 2 },
            markerEnd: { type: MarkerType.ArrowClosed, color: "#7c5cfc", width: 16, height: 16 },
          }));
          setNodes(restoredNodes);
          setEdges(restoredEdges);
        } else {
          // One-time bootstrap from legacy RouterRule data.
          const savedLayout = loadLayout();
          const { nodes: initNodes, edges: initEdges } = buildNodesFromData(
            channelsData, rulesData, agentsData, flowsData, deptsData, savedLayout
          );
          setNodes(initNodes);
          setEdges(initEdges);
          // Auto-open the template gallery when the canvas is essentially
          // empty — the user has never saved a flow, and the bootstrap only
          // produced placeholder channel nodes. Gives new users a concrete
          // starting point instead of a blank sheet.
          const hasRealContent = initNodes.some(
            (n) => n.type !== "channel_entry" && n.type !== "default_fallback",
          );
          if (!hasRealContent) setTemplateGalleryOpen(true);
        }
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [token]);

  // Drag & drop
  const onDragStart = useCallback((event: DragEvent, nodeType: string) => {
    event.dataTransfer.setData("application/reactflow", nodeType);
    event.dataTransfer.effectAllowed = "move";
  }, []);

  const onDragOver = useCallback((event: DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      const type = event.dataTransfer.getData("application/reactflow");
      if (!type || !reactFlowInstance || !reactFlowWrapper.current) return;
      const bounds = reactFlowWrapper.current.getBoundingClientRect();
      const position = reactFlowInstance.project({
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      });
      const id = `${type}-${Date.now()}`;
      const shared = { agents, flows, departments };
      const newNode: Node = { id, type, position, data: getDefaultData(type, shared) };
      setNodes((nds) => [...nds, newNode]);
    },
    [reactFlowInstance, setNodes, agents, flows, departments]
  );

  const onConnect = useCallback(
    (params: Connection) => {
      setEdges((eds) =>
        addEdge({
          ...params,
          type: "smoothstep",
          animated: true,
          style: { stroke: "#7c5cfc", strokeWidth: 2 },
          markerEnd: { type: MarkerType.ArrowClosed, color: "#7c5cfc", width: 16, height: 16 },
        }, eds)
      );
    },
    [setEdges]
  );

  function addNode(type: string) {
    const id = `${type}-${Date.now()}`;
    const position = findClearPosition(nodes);
    const shared = { agents, flows, departments };
    const newNode: Node = { id, type, position, data: getDefaultData(type, shared) };
    setNodes((nds) => [...nds, newNode]);
  }

  // ─── Save ────────────────────────────────────────────────────
  // The graph IS the flow. We persist it as-is to FlowCanvas.
  // The runtime (services/incoming-worker/src/services/flow-executor.service.ts)
  // walks exactly these nodes and edges at message time — NO conversion to
  // RouterRule entities. What you see here is exactly what executes.
  async function handleSave() {
    if (!token) return;
    setSaving(true);
    try {
      // Keep a local backup of layout so an offline reload still shows the same canvas.
      saveLayout(nodes, edges);

      // Strip the ephemeral shared-data (agents/flows/departments lists) injected
      // into route_target / default_fallback nodes — it belongs to the session,
      // not the persisted graph.
      const serializedNodes = nodes.map((n) => ({
        id: n.id,
        type: n.type,
        position: n.position,
        data: {
          ...n.data,
          agents: undefined,
          flows: undefined,
          departments: undefined,
        },
      }));
      const serializedEdges = edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle ?? null,
        targetHandle: e.targetHandle ?? null,
      }));

      await saveFlowCanvas(token, { nodes: serializedNodes, edges: serializedEdges });
      setSavedToast("Flow saved");
      setTimeout(() => setSavedToast(null), 2200);
    } catch (err) {
      console.error("Save error:", err);
      setSavedToast("Save failed — check the console");
      setTimeout(() => setSavedToast(null), 3500);
    } finally {
      setSaving(false);
    }
  }

  // ─── Delete selected nodes ───────────────────────────────────
  const onNodesDelete = useCallback((deleted: Node[]) => {
    // Also remove connected edges
    const deletedIds = new Set(deleted.map((n) => n.id));
    setEdges((eds) => eds.filter((e) => !deletedIds.has(e.source) && !deletedIds.has(e.target)));
    if (selectedNodeId && deletedIds.has(selectedNodeId)) setSelectedNodeId(null);
  }, [setEdges, selectedNodeId]);

  // ─── Inspector wiring ────────────────────────────────────────
  // Update a single node's data via setNodes — the canvas summary will
  // re-render automatically and the inspector reads the latest data on
  // next render.
  const updateNodeData = useCallback((id: string, patch: Record<string, any>) => {
    setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)));
  }, [setNodes]);

  const handleDeleteNode = useCallback((id: string) => {
    setNodes((nds) => nds.filter((n) => n.id !== id));
    setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id));
    setSelectedNodeId(null);
  }, [setNodes, setEdges]);

  const handleDuplicateNode = useCallback((id: string) => {
    setNodes((nds) => {
      const orig = nds.find((n) => n.id === id);
      if (!orig) return nds;
      const newId = `${orig.type}-${Date.now()}`;
      const dup: Node = {
        id: newId,
        type: orig.type,
        position: { x: orig.position.x + 60, y: orig.position.y + 60 },
        data: JSON.parse(JSON.stringify(orig.data || {})),
      };
      return [...nds, dup];
    });
  }, [setNodes]);

  const selectedNode = selectedNodeId ? nodes.find((n) => n.id === selectedNodeId) ?? null : null;
  const sharedForInspector = useMemo(() => ({ agents, flows, departments, channels }), [agents, flows, departments, channels]);

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-violet-200 border-t-violet-600 rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col">
      {/* Toolbar */}
      <div className="bg-white border-b border-gray-100 px-2 md:px-4 py-2 md:py-3 flex items-center gap-2 md:gap-3 shadow-sm z-10">
        {onBack && (
          <button onClick={onBack} className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100 transition shrink-0">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
            </svg>
          </button>
        )}

        <div className="flex items-center gap-2 flex-1 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-violet-700 flex items-center justify-center shadow-sm shrink-0">
            <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5" />
            </svg>
          </div>
          <div>
            <h1 className="text-sm md:text-base font-bold text-gray-900">Main Playbook</h1>
            <p className="text-[10px] text-gray-400 hidden sm:block">Define how incoming messages are routed</p>
          </div>
        </div>

        <button
          onClick={() => setTemplateGalleryOpen(true)}
          className="px-2 md:px-3 py-2 rounded-xl text-xs font-medium transition flex items-center gap-1.5 shrink-0 bg-gray-50 hover:bg-gray-100 text-gray-600"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25a2.25 2.25 0 01-2.25-2.25v-2.25z" />
          </svg>
          <span className="hidden sm:inline">Templates</span>
        </button>

        <button
          onClick={() => setPaletteOpen(!paletteOpen)}
          className={`px-2 md:px-3 py-2 rounded-xl text-xs font-medium transition flex items-center gap-1.5 shrink-0 ${
            paletteOpen
              ? "bg-violet-50 text-violet-600 ring-1 ring-violet-200"
              : "bg-gray-50 hover:bg-gray-100 text-gray-600"
          }`}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          <span className="hidden sm:inline">Nodes</span>
        </button>

        <FlowIssuesPill issues={issues} onSelectNode={focusNode} />

        <button
          onClick={handleSave}
          disabled={saving}
          className="bg-violet-600 hover:bg-violet-700 text-white px-3 md:px-5 py-2 rounded-xl text-xs md:text-sm font-medium transition disabled:opacity-50 shadow-sm shrink-0"
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>

      {/* Canvas area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Node Palette */}
        <div
          className={`bg-white border-e border-gray-100 transition-all duration-300 ease-in-out overflow-y-auto overflow-x-hidden flex-shrink-0 ${
            paletteOpen ? "w-[240px] opacity-100" : "w-0 opacity-0"
          }`}
        >
          <div className="p-3 space-y-4 w-[240px]">
            <div className="flex items-center gap-2 px-1 pt-1">
              <div className="w-6 h-6 rounded-lg bg-violet-100 flex items-center justify-center">
                <svg className="w-3.5 h-3.5 text-violet-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25a2.25 2.25 0 01-2.25-2.25v-2.25z" />
                </svg>
              </div>
              <span className="text-xs font-semibold text-gray-700 tracking-wide">Node Palette</span>
            </div>

            <p className="text-[10px] text-gray-400 px-1">Drag nodes to the canvas or click to add</p>

            {NODE_PALETTE.map((cat) => (
              <div key={cat.category}>
                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider px-1 mb-1.5">{cat.category}</p>
                <div className="space-y-1.5">
                  {cat.items.map((item) => (
                    <div
                      key={item.type}
                      draggable
                      onDragStart={(e) => onDragStart(e, item.type)}
                      onClick={() => addNode(item.type)}
                      className={`group flex items-center gap-2.5 px-2.5 py-2 rounded-xl border cursor-grab active:cursor-grabbing transition-all duration-150 ${item.bg} ${item.border} ${item.hoverBg} hover:shadow-sm hover:ring-1 ${item.ring}`}
                    >
                      <div className={`w-8 h-8 rounded-lg ${item.iconBg} flex items-center justify-center ${item.text} shrink-0 transition-transform duration-150 group-hover:scale-110`}>
                        {item.icon}
                      </div>
                      <div className="min-w-0">
                        <p className={`text-xs font-semibold ${item.text}`}>{item.label}</p>
                        <p className="text-[10px] text-gray-400 truncate">{item.desc}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ReactFlow Canvas */}
        <div className="flex-1" ref={reactFlowWrapper}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodesDelete={onNodesDelete}
            onDragOver={onDragOver}
            onDrop={onDrop}
            onInit={setReactFlowInstance}
            onNodeClick={(_, n) => setSelectedNodeId(n.id)}
            onPaneClick={() => setSelectedNodeId(null)}
            nodeTypes={nodeTypes}
            connectionLineType={"smoothstep" as any}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            snapToGrid
            snapGrid={[15, 15]}
            deleteKeyCode={["Backspace", "Delete"]}
            className="bg-gray-50"
          >
            <Controls className="!rounded-xl !shadow-lg !border-gray-200" />
            <MiniMap
              className="!rounded-xl !shadow-lg !border-gray-200"
              nodeColor={(n) => {
                if (n.type === "channel_entry") return "#8b5cf6";
                if (n.type === "condition_group") return "#f59e0b";
                if (n.type === "route_target") return "#7c3aed";
                if (n.type === "default_fallback") return "#9ca3af";
                if (n.type === "start") return "#10b981";
                if (n.type === "end") return "#f43f5e";
                if (n.type === "send_message_text") return "#0ea5e9";
                if (n.type === "send_message_interactive") return "#6366f1";
                if (n.type === "send_message_quick_reply") return "#14b8a6";
                if (n.type === "send_message_image") return "#d946ef";
                if (n.type === "send_message_file") return "#64748b";
                if (n.type === "wait") return "#f97316";
                if (n.type === "collect_input") return "#3b82f6";
                if (n.type === "set_variable") return "#a855f7";
                if (n.type === "http_request") return "#52525b";
                if (n.type === "ai_generate") return "#8b5cf6";
                if (n.type === "update_customer") return "#ec4899";
                if (n.type === "bring_user_data") return "#f43f5e";
                if (n.type === "comment_trigger") return "#10b981";
                if (n.type === "keyword_trigger") return "#10b981";
                if (n.type === "schedule_trigger") return "#10b981";
                return "#e5e7eb";
              }}
            />
            <Background variant={BackgroundVariant.Dots} gap={15} size={1} color="#d1d5db" />
          </ReactFlow>
        </div>
      </div>

      {/* Template gallery — opens automatically on first-time empty canvas,
          and on demand via the toolbar Templates button. */}
      <TemplateGalleryModal
        open={templateGalleryOpen}
        onClose={() => setTemplateGalleryOpen(false)}
        onPick={({ nodes: tNodes, edges: tEdges }) => {
          // Keep any existing channel_entry nodes so the user's already-
          // connected channels remain wired. If the template supplies its own
          // channel_entry (or none at all), just use the template as-is.
          const existingChannels = nodes.filter((n) => n.type === "channel_entry");
          const templateHasChannelEntry = tNodes.some((n: any) => n.type === "channel_entry");
          const shared = { agents, flows, departments };
          const hydrated: Node[] = tNodes.map((n: any) => ({
            id: n.id,
            type: n.type,
            position: n.position,
            data: {
              ...n.data,
              ...(n.type === "route_target" || n.type === "default_fallback" ? shared : {}),
            },
          }));
          const nextNodes =
            templateHasChannelEntry || existingChannels.length === 0
              ? hydrated
              : [...existingChannels, ...hydrated.filter((n) => n.type !== "channel_entry")];
          const nextEdges: Edge[] = tEdges.map((e: any) => ({
            id: e.id,
            source: e.source,
            target: e.target,
            sourceHandle: e.sourceHandle ?? undefined,
            type: "smoothstep",
            animated: true,
            style: { stroke: "#7c5cfc", strokeWidth: 2 },
            markerEnd: { type: MarkerType.ArrowClosed, color: "#7c5cfc", width: 16, height: 16 },
          }));
          setNodes(nextNodes);
          setEdges(nextEdges);
        }}
      />

      {/* Inspector — opens when a node is selected. Spec: ALL editing happens here. */}
      <NodeInspector
        node={selectedNode}
        shared={sharedForInspector}
        onChange={updateNodeData}
        onClose={() => setSelectedNodeId(null)}
        onDelete={handleDeleteNode}
        onDuplicate={handleDuplicateNode}
      />

      {/* Save confirmation toast */}
      {savedToast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 bg-gray-900 text-white text-xs font-medium px-4 py-2.5 rounded-full shadow-lg flex items-center gap-2 animate-fade-in">
          <svg className="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
          </svg>
          {savedToast}
        </div>
      )}
    </div>
  );
}
