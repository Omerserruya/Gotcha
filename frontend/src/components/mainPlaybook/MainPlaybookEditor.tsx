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
  EdgeTypes,
  Panel,
  MarkerType,
  ReactFlowInstance,
  ReactFlowProvider,
} from "reactflow";
import "reactflow/dist/style.css";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { nodeLabel, nodeDesc, nodeCategoryLabel } from "./node-i18n";
import { leftBoundaryX, normalizeGraphPositions } from "./connection-rules";
import {
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
import { SendMessageTemplateNode } from "./SendMessageTemplateNode";
import { WaitNode } from "./WaitNode";
import { CollectInputNode } from "./CollectInputNode";
import { SetVariableNode } from "./SetVariableNode";
import { HttpRequestNode } from "./HttpRequestNode";
import { AIGenerateNode } from "./AIGenerateNode";
import { UpdateCustomerNode } from "./UpdateCustomerNode";
import { BringUserDataNode } from "./BringUserDataNode";
import { SendCommentReplyNode } from "./SendCommentReplyNode";
import { CommentTriggerNode } from "./CommentTriggerNode";
import { KeywordTriggerNode } from "./KeywordTriggerNode";
import { ScheduleTriggerNode } from "./ScheduleTriggerNode";
import { VoiceAddParticipantNode } from "./VoiceAddParticipantNode";
import { TemplateGalleryModal } from "./TemplateGalleryModal";
import { validateFlow } from "./flow-validator";
import { validateConnection, type ConnectionError } from "./connection-rules";
import { FlowIssuesPill } from "./FlowIssuesPill";
import { NodeInspector } from "./NodeInspector";
import { TRIGGER_TYPES, isTriggerNode } from "./trigger-types";
import { TriggerCardNode } from "./TriggerCardNode";
import { TriggerSectionHeaderNode } from "./TriggerSectionHeaderNode";
import { DeletableEdge } from "./DeletableEdge";

// ─── Edge types ────────────────────────────────────────────────
// All edges render through DeletableEdge so a selected edge shows a ✕ to
// unlink the two nodes. Aliased under "bezier" too, because saved canvases
// and onConnect both create edges with type "bezier".
const edgeTypes: EdgeTypes = {
  deletable: DeletableEdge,
  bezier: DeletableEdge,
};

// ─── Node types ────────────────────────────────────────────────
const nodeTypes: NodeTypes = {
  // Triggers - all share the canvas-integrated TriggerCardNode (When… style)
  channel_entry: TriggerCardNode,
  comment_trigger: TriggerCardNode,
  keyword_trigger: TriggerCardNode,
  schedule_trigger: TriggerCardNode,
  webhook_trigger: TriggerCardNode,
  // Voice triggers (7) reuse the same When… card chrome - TriggerCardNode's
  // describe() handles the per-type icon + title + subtitle.
  "voice_trigger:call.incoming": TriggerCardNode,
  "voice_trigger:call.answered": TriggerCardNode,
  "voice_trigger:call.missed": TriggerCardNode,
  "voice_trigger:call.hangup_customer": TriggerCardNode,
  "voice_trigger:call.hangup_agent": TriggerCardNode,
  "voice_trigger:call.intent_detected": TriggerCardNode,
  "voice_trigger:call.keyword_spoken": TriggerCardNode,
  // Voice actions render with the standard CollapsedNode chrome.
  voice_add_participant: VoiceAddParticipantNode,
  // Decorative section header rendered above each trigger bucket.
  trigger_section_header: TriggerSectionHeaderNode,
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
  send_message_template: SendMessageTemplateNode,
  send_comment_reply: SendCommentReplyNode,
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
};

// ─── Node palette ──────────────────────────────────────────────
// Shared palette for Main Playbook AND sub-flow editors.
// Export so the sub-flow editor can reuse the same items.
export const NODE_PALETTE = [
  {
    category: "Triggers",
    items: [
      {
        type: "channel_entry",
        label: "Channel Entry",
        desc: "Channel-specific entry point",
        color: "violet", bg: "bg-violet-50", border: "border-violet-200", text: "text-violet-600",
        iconBg: "bg-violet-100", hoverBg: "hover:bg-violet-100", ring: "ring-violet-300",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.288 15.038a5.25 5.25 0 017.424 0M5.106 11.856c3.807-3.808 9.98-3.808 13.788 0M1.924 8.674c5.565-5.565 14.587-5.565 20.152 0M12.53 18.22l-.53.53-.53-.53a.75.75 0 011.06 0z" />
          </svg>
        ),
      },
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
      {
        type: "webhook_trigger",
        label: "Webhook Trigger",
        desc: "Run a flow from an inbound HTTP POST",
        color: "emerald", bg: "bg-emerald-50", border: "border-emerald-200", text: "text-emerald-600",
        iconBg: "bg-emerald-100", hoverBg: "hover:bg-emerald-100", ring: "ring-emerald-300",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" />
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
      {
        type: "send_message_template",
        label: "Send WhatsApp Template",
        desc: "Approved WABA template - re-opens 24h window",
        color: "emerald",
        bg: "bg-emerald-50",
        border: "border-emerald-200",
        text: "text-emerald-600",
        iconBg: "bg-emerald-100",
        hoverBg: "hover:bg-emerald-100",
        ring: "ring-emerald-300",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
          </svg>
        ),
      },
      {
        type: "send_comment_reply",
        label: "Reply to Comment",
        desc: "Public reply on the original comment",
        color: "emerald",
        bg: "bg-emerald-50",
        border: "border-emerald-200",
        text: "text-emerald-600",
        iconBg: "bg-emerald-100",
        hoverBg: "hover:bg-emerald-100",
        ring: "ring-emerald-300",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 8.25H7.5a2.25 2.25 0 00-2.25 2.25v9a2.25 2.25 0 002.25 2.25h9a2.25 2.25 0 002.25-2.25v-1.5M16.5 7.5l-9 9M16.5 7.5h-3M16.5 7.5v3" />
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
  // ── Voice ─────────────────────────────────────────────────
  // Triggers + actions for live-call automations. Wired in
  // services/ai/src/services/voice-flow/voice-flow-runner.ts.
  {
    category: "Voice Triggers",
    items: [
      {
        type: "voice_trigger:call.incoming", label: "Incoming Call",
        desc: "Inbound call ringing on this channel",
        color: "emerald", bg: "bg-emerald-50", border: "border-emerald-200", text: "text-emerald-600",
        iconBg: "bg-emerald-100", hoverBg: "hover:bg-emerald-100", ring: "ring-emerald-300",
        icon: (<svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 002.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 01-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 00-1.091-.852H4.5A2.25 2.25 0 002.25 4.5v2.25z" /></svg>),
      },
      {
        type: "voice_trigger:call.answered", label: "Call Answered",
        desc: "Agent picked up (state → ACTIVE)",
        color: "emerald", bg: "bg-emerald-50", border: "border-emerald-200", text: "text-emerald-600",
        iconBg: "bg-emerald-100", hoverBg: "hover:bg-emerald-100", ring: "ring-emerald-300",
        icon: (<svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>),
      },
      {
        type: "voice_trigger:call.missed", label: "Missed Call",
        desc: "Customer hung up before answer",
        color: "emerald", bg: "bg-emerald-50", border: "border-emerald-200", text: "text-emerald-600",
        iconBg: "bg-emerald-100", hoverBg: "hover:bg-emerald-100", ring: "ring-emerald-300",
        icon: (<svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9.75 9.75l4.5 4.5m0-4.5l-4.5 4.5M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>),
      },
      {
        type: "voice_trigger:call.hangup_customer", label: "Customer Hung Up",
        desc: "Call ended; customer disconnected first",
        color: "emerald", bg: "bg-emerald-50", border: "border-emerald-200", text: "text-emerald-600",
        iconBg: "bg-emerald-100", hoverBg: "hover:bg-emerald-100", ring: "ring-emerald-300",
        icon: (<svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85" /></svg>),
      },
      {
        type: "voice_trigger:call.hangup_agent", label: "Agent Hung Up",
        desc: "Call ended; agent disconnected first",
        color: "emerald", bg: "bg-emerald-50", border: "border-emerald-200", text: "text-emerald-600",
        iconBg: "bg-emerald-100", hoverBg: "hover:bg-emerald-100", ring: "ring-emerald-300",
        icon: (<svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 19V5a2 2 0 012-2h6a2 2 0 012 2v14m-8 0H5m4 0a2 2 0 002-2v-1" /></svg>),
      },
      {
        type: "voice_trigger:call.intent_detected", label: "Intent Detected",
        desc: "AI detected an intent in the live transcript",
        color: "emerald", bg: "bg-emerald-50", border: "border-emerald-200", text: "text-emerald-600",
        iconBg: "bg-emerald-100", hoverBg: "hover:bg-emerald-100", ring: "ring-emerald-300",
        icon: (<svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" /></svg>),
      },
      {
        type: "voice_trigger:call.keyword_spoken", label: "Keyword Spoken",
        desc: "A configured keyword appears in the call",
        color: "emerald", bg: "bg-emerald-50", border: "border-emerald-200", text: "text-emerald-600",
        iconBg: "bg-emerald-100", hoverBg: "hover:bg-emerald-100", ring: "ring-emerald-300",
        icon: (<svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" /></svg>),
      },
    ],
  },
  {
    category: "Voice Actions",
    items: [
      {
        type: "voice_add_participant", label: "Add Participant",
        desc: "Dial a 3rd party into the live conference",
        color: "indigo", bg: "bg-indigo-50", border: "border-indigo-200", text: "text-indigo-600",
        iconBg: "bg-indigo-100", hoverBg: "hover:bg-indigo-100", ring: "ring-indigo-300",
        icon: (<svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M18 9v6m3-3h-6m-3 0a4 4 0 11-8 0 4 4 0 018 0zm-4 6c-3.3 0-6 1.5-6 4v1h12v-1c0-2.5-2.7-4-6-4z" /></svg>),
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
      return { channelId: "", channelType: "", label: "", connected: false };
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
      return { text: "", waitForReply: false };
    case "send_message_interactive":
      return { text: "", buttonLabel: "", buttonUrl: "" };
    case "send_message_quick_reply":
      return { text: "", replies: [{ id: `r_${Date.now()}`, label: "Yes", payload: "yes" }] };
    case "send_message_image":
      return { url: "", caption: "" };
    case "send_message_file":
      return { url: "", filename: "", caption: "" };
    case "send_message_template":
      return { templateId: "", templateName: "", language: "", variables: {}, headerMediaUrl: "" };
    case "send_comment_reply":
      return { mode: "text", text: "", agentId: "", fallbackText: "" };
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
    case "webhook_trigger":
      // Only the linked workflow is stored on the node; the URL/secret/enabled
      // state live on the WebhookTrigger record and are fetched live by the
      // Inspector (so a rotated secret is never stale in the canvas JSON).
      return { name: "Webhook", workflowId: "" };
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
      type: "bezier",
      animated: false,
      style: { stroke: "#c7c7cc", strokeWidth: 1.5 },
      markerEnd: { type: MarkerType.ArrowClosed, color: "#c7c7cc", width: 16, height: 16 },
    }));
    return { nodes: restoredNodes, edges: restoredEdges };
  }

  // Otherwise build from channel connections + router rules
  const nodesOut: Node[] = [];
  const edgesOut: Edge[] = [];
  const shared = { agents, flows, departments };

  // 1. Channel entry nodes (left column) - one per connected channel
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
        type: "bezier",
        animated: false,
        style: { stroke: "#c7c7cc", strokeWidth: 1.5 },
        markerEnd: { type: MarkerType.ArrowClosed, color: "#c7c7cc", width: 16, height: 16 },
      });
    }

    // Edge: condition (match) -> route target
    edgesOut.push({
      id: `e_${condId}_${routeId}`,
      source: condId,
      sourceHandle: "true",
      target: routeId,
      type: "bezier",
      animated: false,
      style: { stroke: "#16a34a", strokeWidth: 1.5 },
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
        type: "bezier",
        animated: false,
        style: { stroke: "#ef4444", strokeWidth: 1.5 },
        markerEnd: { type: MarkerType.ArrowClosed, color: "#ef4444", width: 16, height: 16 },
      });
    } else {
      // Connect channels directly to fallback
      for (const chId of channelNodeIds) {
        edgesOut.push({
          id: `e_${chId}_fallback`,
          source: chId,
          target: fallbackId,
          type: "bezier",
          animated: false,
          style: { stroke: "#c7c7cc", strokeWidth: 1.5 },
          markerEnd: { type: MarkerType.ArrowClosed, color: "#c7c7cc", width: 16, height: 16 },
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
  /** Embedded in a tab (fills its container) rather than owning the viewport. */
  embedded?: boolean;
}

export function MainPlaybookEditor(props: Props) {
  // Wrap so that the side-panel Inspector - which renders OUTSIDE <ReactFlow>
  // but inside the editor - can call hooks like useReactFlow (used by
  // VariableMentionInput's variable scanner) and share state with the canvas.
  return (
    <ReactFlowProvider>
      <MainPlaybookEditorInner {...props} />
    </ReactFlowProvider>
  );
}

function MainPlaybookEditorInner({ onBack, embedded }: Props) {
  const { token } = useAuth();
  const { t } = useI18n();
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  // Full-screen editing. This canvas had none: the Main Playbook is the widest
  // graph in the product and was being edited inside a padded panel.
  const [fullscreen, setFullscreen] = useState(false);
  // Escape leaves full screen - the first thing anyone tries.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); setFullscreen(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  // Left boundary in GRAPH space, recomputed as nodes move.
  const playbookExtent = useMemo(() => {
    const left = leftBoundaryX(nodes.map((n) => ({ position: n.position, type: n.type as string })));
    const FAR = 1_000_000;
    return [[left, -FAR], [FAR, FAR]] as [[number, number], [number, number]];
  }, [nodes]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(true);
  // Template gallery - auto-opens once on an empty canvas to give new users a
  // starting point. We track whether we've already auto-opened so a user who
  // dismisses it doesn't get re-prompted every render.
  const [templateGalleryOpen, setTemplateGalleryOpen] = useState(false);
  // Open the gallery automatically when the editor was navigated to with
  // `?templates=open` (e.g. from the Playbooks tab "Templates" button).
  // Reading window.location.search here avoids the Next 14 Suspense bailout
  // that `useSearchParams` would force on this page.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("templates") === "open") setTemplateGalleryOpen(true);
  }, []);
  const [savedToast, setSavedToast] = useState<string | null>(null);
  const [connError, setConnError] = useState<ConnectionError | null>(null);
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null);
  // Per the Flow Builder UX spec: nodes are read-only on canvas and ALL
  // configuration happens in the side-panel Inspector. Track the selected
  // node id to drive the panel.
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Validator - recomputed whenever the graph changes. Cheap, O(nodes+edges).
  const issues = useMemo(
    () =>
      validateFlow(
        nodes.filter((n) => n.type !== "trigger_section_header") as any,
        edges as any,
      ),
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

  // Deep-link from the channels page (?focus=<channelType>): once the canvas is
  // loaded, center on that channel's entry node and pulse it so the user knows
  // exactly which one was just connected and can wire it up.
  const didFocusParamRef = useRef(false);
  useEffect(() => {
    if (didFocusParamRef.current || !reactFlowInstance || nodes.length === 0) return;
    const focus = new URLSearchParams(window.location.search).get("focus");
    if (!focus) return;
    const target = nodes.find(
      (n) => n.type === "channel_entry" && String(n.data?.channelType || "").toLowerCase() === focus.toLowerCase(),
    );
    if (!target) return;
    didFocusParamRef.current = true;
    focusNode(target.id);
    setNodes((nds) => nds.map((n) => (n.id === target.id ? { ...n, data: { ...n.data, __highlight: true } } : n)));
    setTimeout(() => {
      setNodes((nds) => nds.map((n) => (n.id === target.id ? { ...n, data: { ...n.data, __highlight: false } } : n)));
    }, 4500);
    // Drop the param so a refresh doesn't re-trigger the focus animation.
    window.history.replaceState({}, "", "/ai-studio/router");
  }, [nodes, reactFlowInstance, focusNode, setNodes]);

  // Shared data for dropdowns inside nodes
  const [agents, setAgents] = useState<any[]>([]);
  const [flows, setFlows] = useState<any[]>([]);
  const [departments, setDepartments] = useState<any[]>([]);
  const [channels, setChannels] = useState<any[]>([]);

  // Load all data.
  // Source of truth for the graph is the server-persisted FlowCanvas.
  // Empty canvas → open the template gallery so authors get a concrete
  // starting point instead of a blank sheet.
  useEffect(() => {
    if (!token) return;
    Promise.all([
      getChannels(token).then((r) => r.data || r || []),
      getAIAgents(token).then((r) => r.data || []),
      getChatbotFlows(token).then((r) => (Array.isArray(r) ? r : (r as any).data || [])),
      getDepartments(token).then((r) => r.data || []),
      getFlowCanvas(token).then((r) => r.data || null).catch(() => null),
    ])
      .then(([channelsData, agentsData, flowsData, deptsData, canvasData]) => {
        setChannels(channelsData);
        setAgents(agentsData);
        setFlows(flowsData);
        setDepartments(deptsData);

        const shared = { agents: agentsData, flows: flowsData, departments: deptsData };
        const serverCanvas = canvasData && Array.isArray(canvasData.nodes) && canvasData.nodes.length > 0
          ? { nodes: canvasData.nodes, edges: canvasData.edges || [] }
          : null;

        if (serverCanvas) {
          // Restore directly from the persisted graph - this is THE flow.
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
            type: "bezier",
            animated: false,
            style: { stroke: "#c7c7cc", strokeWidth: 1.5 },
            markerEnd: { type: MarkerType.ArrowClosed, color: "#c7c7cc", width: 16, height: 16 },
          }));
          // Repair coordinates before the first render: a playbook saved by an
          // older version can arrive with its entry node at a negative X, which
          // would drag the left boundary out with it and open the canvas on
          // empty space.
          setNodes(normalizeGraphPositions(restoredNodes));
          setEdges(restoredEdges);
        } else {
          // No saved canvas yet - open the template gallery so the author
          // can pick a starting point instead of seeing a blank sheet.
          setNodes([]);
          setEdges([]);
          setTemplateGalleryOpen(true);
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
      const id = `${type}-${Date.now()}`;
      const shared = { agents, flows, departments };

      if (TRIGGER_TYPES.has(type)) {
        // Triggers belong in the static column, not the canvas. Drop position
        // is ignored - the column auto-routes by category bucket.
        const newNode: Node = {
          id, type,
          position: { x: 0, y: 0 },
          data: getDefaultData(type, shared),
        };
        setNodes((nds) => [...nds, newNode]);
        return;
      }

      const bounds = reactFlowWrapper.current.getBoundingClientRect();
      const position = reactFlowInstance.project({
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      });
      const newNode: Node = { id, type, position, data: getDefaultData(type, shared) };
      setNodes((nds) => [...nds, newNode]);
    },
    [reactFlowInstance, setNodes, agents, flows, departments]
  );

  const onConnect = useCallback(
    (params: Connection) => {
      // §3 semantic validation - reject invalid drops, don't create the edge.
      const res = validateConnection(
        params,
        nodes.map((n) => ({ id: n.id, type: n.type as string, data: n.data })),
        edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle, targetHandle: (e as any).targetHandle })),
      );
      if (!res.ok) {
        setConnError(res.code ?? "incompatible");
        window.setTimeout(() => setConnError(null), 4500);
        return;
      }
      setConnError(null);
      setEdges((eds) =>
        addEdge({
          ...params,
          type: "bezier",
          animated: false,
          style: { stroke: "#c7c7cc", strokeWidth: 1.5 },
          markerEnd: { type: MarkerType.ArrowClosed, color: "#c7c7cc", width: 16, height: 16 },
        }, eds)
      );
    },
    [setEdges, nodes, edges]
  );

  function addNode(type: string) {
    const id = `${type}-${Date.now()}`;
    const shared = { agents, flows, departments };
    if (TRIGGER_TYPES.has(type)) {
      // Trigger nodes live in the static column - position is unused.
      const newNode: Node = { id, type, position: { x: 0, y: 0 }, data: getDefaultData(type, shared) };
      setNodes((nds) => [...nds, newNode]);
      return;
    }
    const position = findClearPosition(nodes);
    const newNode: Node = { id, type, position, data: getDefaultData(type, shared) };
    setNodes((nds) => [...nds, newNode]);
  }

  // ─── Save ────────────────────────────────────────────────────
  // The graph IS the flow. We persist it as-is to FlowCanvas.
  // The runtime (services/incoming-worker/src/services/flow-executor.service.ts)
  // walks exactly these nodes and edges at message time - NO conversion to
  // RouterRule entities. What you see here is exactly what executes.
  async function handleSave() {
    if (!token) return;
    setSaving(true);
    try {
      // Keep a local backup of layout so an offline reload still shows the same canvas.
      saveLayout(nodes, edges);

      // Strip the ephemeral shared-data (agents/flows/departments lists) injected
      // into route_target / default_fallback nodes - it belongs to the session,
      // not the persisted graph.
      const serializedNodes = nodes
        .filter((n) => n.type !== "trigger_section_header")
        .map((n) => ({
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
      setSavedToast("Save failed - check the console");
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
  // Update a single node's data via setNodes - the canvas summary will
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

  // ─── Keyboard shortcuts ──────────────────────────────────────
  // Ctrl/Cmd+A: select all (excluding synthetic section headers).
  // Ctrl/Cmd+C: copy selected nodes + edges between them to an in-memory
  //             clipboard (we don't touch the OS clipboard).
  // Ctrl/Cmd+V: paste with new IDs and a small position offset; rewires
  //             internal edges to the cloned nodes.
  // Ctrl/Cmd+S: save the canvas.
  // Delete:     handled by ReactFlow's `deleteKeyCode` (set on the canvas).
  // Skips when an input/textarea/contenteditable is focused so the editor
  // never hijacks shortcuts inside the side-panel Inspector.
  const clipboardRef = useRef<{ nodes: Node[]; edges: Edge[] } | null>(null);
  const stateRef = useRef({ nodes, edges, selectedNodeId });
  stateRef.current = { nodes, edges, selectedNodeId };
  const handleSaveRef = useRef<() => Promise<void> | void>(() => {});
  handleSaveRef.current = handleSave;
  useEffect(() => {
    function isTextTarget(t: EventTarget | null): boolean {
      const el = t as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
    }
    function isSelectedFor(n: Node): boolean {
      if (n.type === "trigger_section_header") return false;
      if (n.selected) return true;
      return n.id === stateRef.current.selectedNodeId;
    }
    function onKeyDown(e: KeyboardEvent) {
      if (isTextTarget(e.target)) return;
      const k = e.key.toLowerCase();
      // Delete / Backspace work without a modifier - and without requiring
      // ReactFlow to have focus - so the popup-selected node is deletable.
      if (k === "delete" || k === "backspace") {
        const { nodes: ns, edges: es, selectedNodeId: sid } = stateRef.current;
        const targetIds = new Set(ns.filter(isSelectedFor).map((n) => n.id));
        // Selected edges are removed too, so the user can click an edge and
        // hit Delete to unlink two nodes (the ✕ on the edge does the same).
        const selectedEdgeIds = new Set(es.filter((ed) => ed.selected).map((ed) => ed.id));
        if (targetIds.size === 0 && selectedEdgeIds.size === 0) return;
        e.preventDefault();
        if (targetIds.size > 0) setNodes((nds) => nds.filter((n) => !targetIds.has(n.id)));
        setEdges((eds) =>
          eds.filter(
            (ed) =>
              !selectedEdgeIds.has(ed.id) &&
              !targetIds.has(ed.source) &&
              !targetIds.has(ed.target),
          ),
        );
        if (sid && targetIds.has(sid)) setSelectedNodeId(null);
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      if (k === "a") {
        e.preventDefault();
        setNodes((nds) =>
          nds.map((n) =>
            n.type === "trigger_section_header" || n.selected
              ? n
              : { ...n, selected: true },
          ),
        );
        setEdges((eds) =>
          eds.map((ed) => (ed.selected ? ed : { ...ed, selected: true })),
        );
      } else if (k === "c") {
        e.preventDefault();
        const { nodes: ns, edges: es } = stateRef.current;
        const sel = ns.filter(isSelectedFor);
        if (sel.length === 0) return;
        const ids = new Set(sel.map((n) => n.id));
        const selEdges = es.filter(
          (ed) => ids.has(ed.source) && ids.has(ed.target),
        );
        clipboardRef.current = {
          nodes: JSON.parse(JSON.stringify(sel)),
          edges: JSON.parse(JSON.stringify(selEdges)),
        };
      } else if (k === "v") {
        e.preventDefault();
        const cb = clipboardRef.current;
        if (!cb || cb.nodes.length === 0) return;
        const idMap = new Map<string, string>();
        const stamp = Date.now();
        const offset = 40;
        const newNodes: Node[] = cb.nodes.map((n, i) => {
          const newId = `${n.type}-${stamp}-${i}`;
          idMap.set(n.id, newId);
          const isTrigger = n.type ? TRIGGER_TYPES.has(n.type) : false;
          // Triggers get auto-snapped by the trigger-layout effect, so the
          // initial position is irrelevant - but reset draggable so the
          // pasted node isn't accidentally locked before that effect runs.
          return {
            ...n,
            id: newId,
            position: isTrigger
              ? { x: 0, y: 0 }
              : {
                  x: (n.position?.x ?? 0) + offset,
                  y: (n.position?.y ?? 0) + offset,
                },
            selected: true,
            draggable: isTrigger ? false : undefined,
          };
        });
        const newEdges: Edge[] = cb.edges.map((ed, i) => ({
          ...ed,
          id: `e-${stamp}-${i}`,
          source: idMap.get(ed.source) ?? ed.source,
          target: idMap.get(ed.target) ?? ed.target,
          selected: false,
        }));
        setNodes((nds) => [
          ...nds.map((n) => (n.selected ? { ...n, selected: false } : n)),
          ...newNodes,
        ]);
        setEdges((eds) => [
          ...eds.map((ed) => (ed.selected ? { ...ed, selected: false } : ed)),
          ...newEdges,
        ]);
      } else if (k === "s") {
        e.preventDefault();
        void handleSaveRef.current();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
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
  const sharedForInspector = useMemo(() => ({ agents, flows, departments, channels, nodes, edges }), [agents, flows, departments, channels, nodes, edges]);

  // ─── Trigger placement ──────────────────────────────────────
  // Triggers ARE rendered on the canvas, but auto-laid-out as a static
  // left-edge stack: the user can't drag or reposition them. Wiring is
  // explicit - the user drags from the "Then ●" handle to whatever node
  // should fire next. We do NOT auto-create trigger→entry edges (that
  // caused arrows to retarget on every drag).
  const triggerNodes = useMemo(() => nodes.filter((n) => isTriggerNode(n)), [nodes]);

  // Auto-layout triggers down the left edge, in stable bucket order, with a
  // small section header above each present bucket ("Chats", "Comments", etc.).
  // Triggers and headers are pinned as `draggable: false`. Headers are
  // synthetic - never persisted - and are stripped on save and from the
  // validator.
  // Each bucket renders a single section header followed by one or more
  // trigger cards. Most buckets hold a single type; Voice groups all 7
  // voice-trigger types under one "Voice" header (incoming/answered/missed
  // /hangups/AI signals) and preserves the declared order between them.
  const TRIGGER_BUCKET_ORDER: { types: string[]; label: string }[] = [
    { types: ["channel_entry"], label: "Chats" },
    { types: ["comment_trigger"], label: "Comments" },
    { types: ["keyword_trigger"], label: "Keywords" },
    { types: ["schedule_trigger"], label: "Schedule" },
    { types: ["webhook_trigger"], label: "Webhook" },
    {
      types: [
        "voice_trigger:call.incoming",
        "voice_trigger:call.answered",
        "voice_trigger:call.missed",
        "voice_trigger:call.hangup_customer",
        "voice_trigger:call.hangup_agent",
        "voice_trigger:call.intent_detected",
        "voice_trigger:call.keyword_spoken",
      ],
      label: "Voice",
    },
  ];
  useEffect(() => {
    const PIN_X = -360;
    const HEADER_H = 24;
    const HEADER_GAP = 6;
    const CARD_H = 150;
    const BUCKET_GAP = 18;

    const buckets = TRIGGER_BUCKET_ORDER.map(({ types, label }) => {
      const headerId = `__sh_${types[0]}`;
      return {
        types,
        label,
        headerId,
        items: triggerNodes
          .filter((n) => n.type && types.includes(n.type))
          .sort((a, b) => {
            const ai = a.type ? types.indexOf(a.type) : -1;
            const bi = b.type ? types.indexOf(b.type) : -1;
            if (ai !== bi) return ai - bi;
            return a.id.localeCompare(b.id);
          }),
      };
    }).filter((b) => b.items.length > 0);

    // Desired position map for triggers + their section headers.
    const targets = new Map<string, { x: number; y: number }>();
    const desiredHeaderIds = new Set<string>();
    let y = 0;
    for (const b of buckets) {
      targets.set(b.headerId, { x: PIN_X, y });
      desiredHeaderIds.add(b.headerId);
      y += HEADER_H + HEADER_GAP;
      for (const item of b.items) {
        targets.set(item.id, { x: PIN_X, y });
        y += CARD_H;
      }
      y += BUCKET_GAP;
    }

    setNodes((nds) => {
      // Drop section-header nodes whose bucket is no longer present.
      const trimmed = nds.filter(
        (n) => n.type !== "trigger_section_header" || desiredHeaderIds.has(n.id),
      );
      // Inject any missing headers.
      const presentIds = new Set(trimmed.map((n) => n.id));
      const missing = buckets
        .filter((b) => !presentIds.has(b.headerId))
        .map<Node>((b) => ({
          id: b.headerId,
          type: "trigger_section_header",
          position: targets.get(b.headerId)!,
          data: { label: b.label },
          draggable: false,
          selectable: false,
          deletable: false,
        }));
      const withHeaders = missing.length > 0 ? [...trimmed, ...missing] : trimmed;
      // Apply target positions; pin trigger + header nodes as non-draggable.
      const next = withHeaders.map((n) => {
        const t = targets.get(n.id);
        if (!t) return n;
        const samePos = n.position?.x === t.x && n.position?.y === t.y;
        const isPinned = (n as any).draggable === false;
        if (samePos && isPinned) return n;
        return { ...n, position: { x: t.x, y: t.y }, draggable: false };
      });
      // Bail if nothing actually changed (avoids effect feedback loop).
      if (next.length === nds.length && next.every((n, i) => n === nds[i])) {
        return nds;
      }
      return next;
    });
  }, [triggerNodes, setNodes]);

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-violet-200 border-t-violet-600 rounded-full animate-spin" />
      </div>
    );
  }

  return (
    // Editor must own its own height: AppLayout's <main> is `flex-1` with no
    // explicit height, so `h-full` (= 100% of parent) collapses to auto.
    // Use viewport units, subtracting AppLayout's 8px top + 8px bottom padding.
    <div className={fullscreen ? "fixed inset-0 z-40 bg-white h-screen flex flex-col overflow-hidden" : (embedded ? "h-full flex flex-col overflow-hidden" : "h-screen md:h-[calc(100vh-1rem)] flex flex-col overflow-hidden")}>
      {/* Toolbar - breadcrumb left, secondary actions middle, primary CTA right */}
      <div className="bg-white border-b border-[var(--border-hairline)] px-2 md:px-4 h-14 flex items-center gap-2 md:gap-3 z-10">
        {onBack && (
          <button onClick={onBack} className="text-gray-400 hover:text-gray-700 p-1.5 rounded-md hover:bg-black/[0.04] transition shrink-0">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
            </svg>
          </button>
        )}

        <div className="flex items-center gap-1.5 flex-1 min-w-0 text-sm">
          <span className="text-gray-400 hidden sm:inline">Automations</span>
          <span className="text-gray-300 hidden sm:inline">/</span>
          <span className="font-medium text-gray-900 truncate">Main Playbook</span>
        </div>

        {/* Full screen. The Main Playbook is the widest graph in the product;
            editing it inside a padded panel wasted most of the window. */}
        <button
          onClick={() => setFullscreen((v) => !v)}
          data-testid="playbook-fullscreen-toggle"
          title={fullscreen ? "Exit full screen (Esc)" : "Full screen"}
          aria-label={fullscreen ? "Exit full screen" : "Full screen"}
          aria-pressed={fullscreen}
          className="px-2.5 py-1.5 rounded-md text-xs font-medium text-gray-600 hover:bg-black/[0.04] transition flex items-center gap-1.5 shrink-0"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            {fullscreen ? (
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
            )}
          </svg>
        </button>

        <button
          onClick={() => setTemplateGalleryOpen(true)}
          className="px-2.5 md:px-3 py-1.5 rounded-md text-xs font-medium text-gray-600 hover:bg-black/[0.04] transition flex items-center gap-1.5 shrink-0"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25a2.25 2.25 0 01-2.25-2.25v-2.25z" />
          </svg>
          <span className="hidden sm:inline">Templates</span>
        </button>

        <button
          onClick={() => setPaletteOpen(!paletteOpen)}
          className={`px-2.5 md:px-3 py-1.5 rounded-md text-xs font-medium transition flex items-center gap-1.5 shrink-0 ${
            paletteOpen
              ? "bg-black/[0.06] text-gray-900"
              : "text-gray-600 hover:bg-black/[0.04]"
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
          className="bg-violet-600 hover:bg-violet-700 text-white px-3 md:px-4 py-1.5 rounded-md text-xs md:text-sm font-medium transition disabled:opacity-50 shrink-0"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      {/* Canvas area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Node Palette */}
        <div
          className={`bg-white border-e border-[var(--border-hairline)] transition-all duration-300 ease-in-out overflow-y-auto overflow-x-hidden flex-shrink-0 ${
            paletteOpen ? "w-[260px] opacity-100" : "w-0 opacity-0"
          }`}
        >
          <div className="p-4 space-y-5 w-[260px]">
            <div className="px-1">
              <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-[0.08em]">{t("aiStudio.nodePaletteTitle")}</p>
              <p className="text-[11px] text-gray-400 mt-1">{t("aiStudio.nodePaletteHint")}</p>
            </div>

            {NODE_PALETTE.map((cat) => (
              <div key={cat.category}>
                <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-[0.08em] px-1 mb-1.5">{nodeCategoryLabel(cat.category, t)}</p>
                <div className="space-y-0.5">
                  {cat.items.map((item) => (
                    <div
                      key={item.type}
                      draggable
                      onDragStart={(e) => onDragStart(e, item.type)}
                      onClick={() => addNode(item.type)}
                      className="group flex items-center gap-2.5 px-2 py-1.5 rounded-lg cursor-grab active:cursor-grabbing transition-colors duration-150 hover:bg-black/[0.04]"
                    >
                      <div className={`w-7 h-7 rounded-md ${item.iconBg} ${item.text} flex items-center justify-center shrink-0 [&_svg]:w-4 [&_svg]:h-4`}>
                        {item.icon}
                      </div>
                      <div className="min-w-0">
                        <p className="text-[13px] font-medium text-gray-800 truncate">{nodeLabel(item.type, t, item.label)}</p>
                        <p className="text-[11px] text-gray-400 truncate">{nodeDesc(item.type, t, item.desc)}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ReactFlow Canvas - triggers are pinned at the left as static
            (non-draggable) nodes, connected by bezier edges to the entry node. */}
        <div className="flex-1 relative" ref={reactFlowWrapper}>
          {connError && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 max-w-md rounded-xl bg-red-600 text-white text-xs font-medium px-3.5 py-2 shadow-lg">
              {t(`chatbot.connErrors.${connError}`)}
            </div>
          )}
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
            onNodeClick={(e, n) => {
              setSelectedNodeId(n.id);
              // Mirror the click into ReactFlow's selection state so
              // Ctrl+C / Delete shortcuts find the node as "selected" and
              // the violet ring renders. Ctrl/Cmd/Shift-click extends the
              // current selection instead of replacing it.
              const multi = e.ctrlKey || e.metaKey || e.shiftKey;
              setNodes((nds) =>
                nds.map((x) => {
                  if (x.id === n.id) return x.selected ? x : { ...x, selected: true };
                  if (multi) return x;
                  return x.selected ? { ...x, selected: false } : x;
                }),
              );
            }}
            onPaneClick={() => {
              setSelectedNodeId(null);
              setNodes((nds) =>
                nds.map((x) => (x.selected ? { ...x, selected: false } : x)),
              );
            }}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            connectionLineType={"bezier" as any}
            defaultEdgeOptions={{
              type: "bezier",
              animated: false,
              style: { stroke: "#c7c7cc", strokeWidth: 1.5 },
              markerEnd: { type: MarkerType.ArrowClosed, color: "#c7c7cc", width: 16, height: 16 },
            }}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            // Triggers anchor the LEFT edge: panning stops there and nodes
            // cannot be dragged left of it, while rightward growth and zoom
            // stay free. Graph-space, so it survives zoom and RTL. Same shared
            // helper the chatbot canvas uses.
            translateExtent={playbookExtent}
            nodeExtent={playbookExtent}
            snapToGrid
            snapGrid={[15, 15]}
            // Delete handling is owned by our window keydown listener so it
            // works even when ReactFlow doesn't have focus (e.g., the user
            // clicked a node, the Inspector opened, then they hit Delete).
            deleteKeyCode={null}
            proOptions={{ hideAttribution: true }}
            className="bg-[var(--surface-canvas)]"
          >
            <Controls className="!rounded-lg !shadow-sm !border !border-[var(--border-hairline)]" />
            <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="rgba(0,0,0,0.06)" />
          </ReactFlow>
        </div>
      </div>

      {/* Template gallery - opens automatically on first-time empty canvas,
          and on demand via the toolbar Templates button. */}
      <TemplateGalleryModal
        open={templateGalleryOpen}
        onClose={() => setTemplateGalleryOpen(false)}
        onPick={({ nodes: tNodes, edges: tEdges }) => {
          // ADDITIVE - drop the template into the existing canvas instead of
          // replacing it. Trigger nodes get re-pinned into the left column by
          // the auto-layout effect, so we only need to offset the non-trigger
          // flow nodes so they don't collide with what's already there.
          const shared = { agents, flows, departments };
          const existingFlowNodes = nodes.filter(
            (n) =>
              !isTriggerNode(n)
              && n.type !== "trigger_section_header",
          );
          const maxExistingX = existingFlowNodes.reduce(
            (acc, n) => Math.max(acc, (n.position?.x ?? 0) + 280),
            0,
          );
          const offsetX = existingFlowNodes.length > 0 ? maxExistingX + 80 : 0;
          const minTemplateNonTriggerX = tNodes
            .filter((n: any) => !TRIGGER_TYPES.has(n.type))
            .reduce(
              (acc: number, n: any) => Math.min(acc, n.position?.x ?? 0),
              Number.POSITIVE_INFINITY,
            );
          const shiftX =
            offsetX > 0 && Number.isFinite(minTemplateNonTriggerX)
              ? offsetX - (minTemplateNonTriggerX as number)
              : 0;
          const hydrated: Node[] = tNodes.map((n: any) => {
            const isTrigger = TRIGGER_TYPES.has(n.type);
            return {
              id: n.id,
              type: n.type,
              position: isTrigger
                ? n.position
                : { x: (n.position?.x ?? 0) + shiftX, y: n.position?.y ?? 0 },
              data: {
                ...n.data,
                ...(n.type === "route_target" || n.type === "default_fallback" ? shared : {}),
              },
            };
          });
          const newEdges: Edge[] = tEdges.map((e: any) => ({
            id: e.id,
            source: e.source,
            target: e.target,
            sourceHandle: e.sourceHandle ?? undefined,
            type: "bezier",
            animated: false,
            style: { stroke: "#c7c7cc", strokeWidth: 1.5 },
            markerEnd: { type: MarkerType.ArrowClosed, color: "#c7c7cc", width: 16, height: 16 },
          }));
          setNodes((nds) => [...nds, ...hydrated]);
          setEdges((eds) => [...eds, ...newEdges]);
        }}
      />

      {/* Inspector - opens when a node is selected. Spec: ALL editing happens here. */}
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
