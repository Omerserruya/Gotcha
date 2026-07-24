"use client";

import { useState, useEffect, useCallback, useRef, DragEvent } from "react";
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
  ConnectionLineType,
  MarkerType,
  ReactFlowInstance,
  ReactFlowProvider,
} from "reactflow";
import "reactflow/dist/style.css";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { getChatbotFlow, createChatbotFlow, updateChatbotFlow, activateChatbotFlow, deactivateChatbotFlow, getChannels } from "@/lib/api";
import { StartNode } from "./nodes/StartNode";
import { MessageNode } from "./nodes/MessageNode";
import { QuickReplyNode } from "./nodes/QuickReplyNode";
import { ConditionNode } from "./nodes/ConditionNode";
import { HandoverNode } from "./nodes/HandoverNode";
import { DepartmentRouteNode } from "./nodes/DepartmentRouteNode";
import { EndNode } from "./nodes/EndNode";
// Unified node types shared with the Main Playbook. Authoring a sub-flow uses
// the SAME palette and the SAME runtime walker (executeSubFlow), so everything
// the main flow can do, a sub-flow can do - and vice-versa.
import { ConditionGroupNode } from "../mainPlaybook/ConditionGroupNode";
import { RouteTargetNode } from "../mainPlaybook/RouteTargetNode";
import { SendMessageTextNode } from "../mainPlaybook/SendMessageTextNode";
import { SendMessageInteractiveNode } from "../mainPlaybook/SendMessageInteractiveNode";
import { SendMessageQuickReplyNode } from "../mainPlaybook/SendMessageQuickReplyNode";
import { SendMessageImageNode } from "../mainPlaybook/SendMessageImageNode";
import { SendMessageFileNode } from "../mainPlaybook/SendMessageFileNode";
import { WaitNode } from "../mainPlaybook/WaitNode";
import { CollectInputNode } from "../mainPlaybook/CollectInputNode";
import { SetVariableNode } from "../mainPlaybook/SetVariableNode";
import { HttpRequestNode } from "../mainPlaybook/HttpRequestNode";
import { AIGenerateNode } from "../mainPlaybook/AIGenerateNode";
import { UpdateCustomerNode } from "../mainPlaybook/UpdateCustomerNode";
import { BringUserDataNode } from "../mainPlaybook/BringUserDataNode";
import { CommentTriggerNode } from "../mainPlaybook/CommentTriggerNode";
import { KeywordTriggerNode } from "../mainPlaybook/KeywordTriggerNode";
import { ScheduleTriggerNode } from "../mainPlaybook/ScheduleTriggerNode";
import { ChannelEntryNode } from "../mainPlaybook/ChannelEntryNode";
import { SendCommentReplyNode } from "../mainPlaybook/SendCommentReplyNode";
import { NodeInspector } from "../mainPlaybook/NodeInspector";
import { NODE_REGISTRY } from "../mainPlaybook/node-registry";

const nodeTypes: NodeTypes = {
  // Legacy types - still supported for existing flows
  start: StartNode,
  message: MessageNode,
  quick_reply: QuickReplyNode,
  condition: ConditionNode,
  handover: HandoverNode,
  department_route: DepartmentRouteNode,
  end: EndNode,
  // Unified types (new)
  condition_group: ConditionGroupNode,
  route_target: RouteTargetNode,
  send_message_text: SendMessageTextNode,
  send_message_interactive: SendMessageInteractiveNode,
  send_message_quick_reply: SendMessageQuickReplyNode,
  send_message_image: SendMessageImageNode,
  send_message_file: SendMessageFileNode,
  send_comment_reply: SendCommentReplyNode,
  // Control / data / integrations / triggers
  wait: WaitNode,
  collect_input: CollectInputNode,
  set_variable: SetVariableNode,
  http_request: HttpRequestNode,
  ai_generate: AIGenerateNode,
  update_customer: UpdateCustomerNode,
  bring_user_data: BringUserDataNode,
  comment_trigger: CommentTriggerNode,
  keyword_trigger: KeywordTriggerNode,
  schedule_trigger: ScheduleTriggerNode,
  channel_entry: ChannelEntryNode,
};

// ─── Node palette config ────────────────────────────────────────
const NODE_PALETTE = [
  {
    category: "Triggers",
    items: [
      {
        type: "start",
        label: "Start",
        desc: "Entry point of the flow",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z" />
          </svg>
        ),
        color: "emerald",
        bg: "bg-emerald-50",
        border: "border-emerald-200",
        text: "text-emerald-600",
        iconBg: "bg-emerald-100",
        hoverBg: "hover:bg-emerald-100",
        ring: "ring-emerald-300",
        dot: "bg-emerald-500",
      },
    ],
  },
  {
    category: "Messages",
    items: [
      {
        type: "message",
        label: "Send Message",
        desc: "Send a text message to the user",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
          </svg>
        ),
        color: "blue",
        bg: "bg-blue-50",
        border: "border-blue-200",
        text: "text-blue-600",
        iconBg: "bg-blue-100",
        hoverBg: "hover:bg-blue-100",
        ring: "ring-blue-300",
        dot: "bg-blue-500",
      },
      {
        type: "quick_reply",
        label: "Quick Reply",
        desc: "Show buttons for the user to choose",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25a2.25 2.25 0 01-2.25-2.25v-2.25z" />
          </svg>
        ),
        color: "violet",
        bg: "bg-violet-50",
        border: "border-violet-200",
        text: "text-violet-600",
        iconBg: "bg-violet-100",
        hoverBg: "hover:bg-violet-100",
        ring: "ring-violet-300",
        dot: "bg-violet-500",
      },
    ],
  },
  {
    category: "Logic",
    items: [
      {
        type: "condition",
        label: "Condition",
        desc: "Branch based on user input",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
          </svg>
        ),
        color: "amber",
        bg: "bg-amber-50",
        border: "border-amber-200",
        text: "text-amber-600",
        iconBg: "bg-amber-100",
        hoverBg: "hover:bg-amber-100",
        ring: "ring-amber-300",
        dot: "bg-amber-500",
      },
    ],
  },
  {
    category: "Actions",
    items: [
      {
        type: "handover",
        label: "Handover",
        desc: "Transfer conversation to a human agent",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
          </svg>
        ),
        color: "sky",
        bg: "bg-sky-50",
        border: "border-sky-200",
        text: "text-sky-600",
        iconBg: "bg-sky-100",
        hoverBg: "hover:bg-sky-100",
        ring: "ring-sky-300",
        dot: "bg-sky-500",
      },
      {
        type: "end",
        label: "End",
        desc: "End the conversation flow",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 7.5A2.25 2.25 0 017.5 5.25h9a2.25 2.25 0 012.25 2.25v9a2.25 2.25 0 01-2.25 2.25h-9a2.25 2.25 0 01-2.25-2.25v-9z" />
          </svg>
        ),
        color: "rose",
        bg: "bg-rose-50",
        border: "border-rose-200",
        text: "text-rose-600",
        iconBg: "bg-rose-100",
        hoverBg: "hover:bg-rose-100",
        ring: "ring-rose-300",
        dot: "bg-rose-500",
      },
    ],
  },
  // Unified palette - these are the same node types used by the Main Playbook.
  // They produce n8n-style flow graphs that the single graph walker executes
  // exactly as drawn. Prefer these for new sub-flows.
  {
    category: "Unified (new)",
    items: [
      {
        type: "condition_group",
        label: "Condition (unified)",
        desc: "Branch on keyword / regex / channel",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
          </svg>
        ),
        color: "amber",
        bg: "bg-amber-50",
        border: "border-amber-200",
        text: "text-amber-600",
        iconBg: "bg-amber-100",
        hoverBg: "hover:bg-amber-100",
        ring: "ring-amber-300",
        dot: "bg-amber-500",
      },
      {
        type: "send_message_text",
        label: "Send Text",
        desc: "Plain text message",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
          </svg>
        ),
        color: "sky",
        bg: "bg-sky-50",
        border: "border-sky-200",
        text: "text-sky-600",
        iconBg: "bg-sky-100",
        hoverBg: "hover:bg-sky-100",
        ring: "ring-sky-300",
        dot: "bg-sky-500",
      },
      {
        type: "send_message_interactive",
        label: "Send Interactive (Link)",
        desc: "Text + CTA URL button",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" />
          </svg>
        ),
        color: "indigo",
        bg: "bg-indigo-50",
        border: "border-indigo-200",
        text: "text-indigo-600",
        iconBg: "bg-indigo-100",
        hoverBg: "hover:bg-indigo-100",
        ring: "ring-indigo-300",
        dot: "bg-indigo-500",
      },
      {
        type: "send_message_quick_reply",
        label: "Send Quick Reply",
        desc: "Prompt with tappable options",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
          </svg>
        ),
        color: "teal",
        bg: "bg-teal-50",
        border: "border-teal-200",
        text: "text-teal-600",
        iconBg: "bg-teal-100",
        hoverBg: "hover:bg-teal-100",
        ring: "ring-teal-300",
        dot: "bg-teal-500",
      },
      {
        type: "send_message_image",
        label: "Send Image",
        desc: "Image from URL + caption",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
          </svg>
        ),
        color: "fuchsia",
        bg: "bg-fuchsia-50",
        border: "border-fuchsia-200",
        text: "text-fuchsia-600",
        iconBg: "bg-fuchsia-100",
        hoverBg: "hover:bg-fuchsia-100",
        ring: "ring-fuchsia-300",
        dot: "bg-fuchsia-500",
      },
      {
        type: "send_message_file",
        label: "Send File",
        desc: "File from URL (PDF, doc, ...)",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
          </svg>
        ),
        color: "slate",
        bg: "bg-slate-50",
        border: "border-slate-200",
        text: "text-slate-600",
        iconBg: "bg-slate-100",
        hoverBg: "hover:bg-slate-100",
        ring: "ring-slate-300",
        dot: "bg-slate-500",
      },
      {
        type: "send_comment_reply",
        label: "Reply to Comment",
        desc: "Public reply on the original comment",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 8.25H7.5a2.25 2.25 0 00-2.25 2.25v9a2.25 2.25 0 002.25 2.25h9a2.25 2.25 0 002.25-2.25v-1.5M16.5 7.5l-9 9M16.5 7.5h-3M16.5 7.5v3" />
          </svg>
        ),
        color: "emerald",
        bg: "bg-emerald-50",
        border: "border-emerald-200",
        text: "text-emerald-600",
        iconBg: "bg-emerald-100",
        hoverBg: "hover:bg-emerald-100",
        ring: "ring-emerald-300",
        dot: "bg-emerald-500",
      },
      {
        type: "route_target",
        label: "Route To",
        desc: "AI agent / sub-flow / human",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
          </svg>
        ),
        color: "violet",
        bg: "bg-violet-50",
        border: "border-violet-200",
        text: "text-violet-600",
        iconBg: "bg-violet-100",
        hoverBg: "hover:bg-violet-100",
        ring: "ring-violet-300",
        dot: "bg-violet-500",
      },
      {
        type: "wait",
        label: "Wait / Delay",
        desc: "Pause N seconds/minutes",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        ),
        color: "orange", bg: "bg-orange-50", border: "border-orange-200", text: "text-orange-600",
        iconBg: "bg-orange-100", hoverBg: "hover:bg-orange-100", ring: "ring-orange-300", dot: "bg-orange-500",
      },
      {
        type: "collect_input",
        label: "Collect Input",
        desc: "Ask + capture user reply",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" />
          </svg>
        ),
        color: "blue", bg: "bg-blue-50", border: "border-blue-200", text: "text-blue-600",
        iconBg: "bg-blue-100", hoverBg: "hover:bg-blue-100", ring: "ring-blue-300", dot: "bg-blue-500",
      },
      {
        type: "set_variable",
        label: "Set Variable",
        desc: "Assign a flow variable",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
          </svg>
        ),
        color: "purple", bg: "bg-purple-50", border: "border-purple-200", text: "text-purple-600",
        iconBg: "bg-purple-100", hoverBg: "hover:bg-purple-100", ring: "ring-purple-300", dot: "bg-purple-500",
      },
      {
        type: "http_request",
        label: "HTTP Request",
        desc: "Call external API",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747" />
          </svg>
        ),
        color: "zinc", bg: "bg-zinc-50", border: "border-zinc-200", text: "text-zinc-700",
        iconBg: "bg-zinc-100", hoverBg: "hover:bg-zinc-100", ring: "ring-zinc-300", dot: "bg-zinc-500",
      },
      {
        type: "ai_generate",
        label: "AI Generate",
        desc: "Single-shot LLM call",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25" />
          </svg>
        ),
        color: "violet", bg: "bg-violet-50", border: "border-violet-200", text: "text-violet-600",
        iconBg: "bg-violet-100", hoverBg: "hover:bg-violet-100", ring: "ring-violet-300", dot: "bg-violet-500",
      },
      {
        type: "bring_user_data",
        label: "Bring User Data",
        desc: "Load contact into vars",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375" />
          </svg>
        ),
        color: "rose", bg: "bg-rose-50", border: "border-rose-200", text: "text-rose-600",
        iconBg: "bg-rose-100", hoverBg: "hover:bg-rose-100", ring: "ring-rose-300", dot: "bg-rose-500",
      },
      {
        type: "update_customer",
        label: "Update Customer",
        desc: "Tag / attribute",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" />
          </svg>
        ),
        color: "pink", bg: "bg-pink-50", border: "border-pink-200", text: "text-pink-600",
        iconBg: "bg-pink-100", hoverBg: "hover:bg-pink-100", ring: "ring-pink-300", dot: "bg-pink-500",
      },
    ],
  },
  {
    category: "Triggers",
    items: [
      {
        type: "channel_entry",
        label: "Channel Entry",
        desc: "Channel-specific entry point",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.288 15.038a5.25 5.25 0 017.424 0M5.106 11.856c3.807-3.808 9.98-3.808 13.788 0M1.924 8.674c5.565-5.565 14.587-5.565 20.152 0M12.53 18.22l-.53.53-.53-.53a.75.75 0 011.06 0z" />
          </svg>
        ),
        color: "violet", bg: "bg-violet-50", border: "border-violet-200", text: "text-violet-600",
        iconBg: "bg-violet-100", hoverBg: "hover:bg-violet-100", ring: "ring-violet-300", dot: "bg-violet-500",
      },
      {
        type: "comment_trigger",
        label: "Comment Received",
        desc: "IG/FB post comments",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 20.25c4.97 0 9-3.694 9-8.25s-4.03-8.25-9-8.25S3 7.444 3 12" />
          </svg>
        ),
        color: "emerald", bg: "bg-emerald-50", border: "border-emerald-200", text: "text-emerald-600",
        iconBg: "bg-emerald-100", hoverBg: "hover:bg-emerald-100", ring: "ring-emerald-300", dot: "bg-emerald-500",
      },
      {
        type: "keyword_trigger",
        label: "Keyword Trigger",
        desc: "Fires on inbound keyword",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
          </svg>
        ),
        color: "emerald", bg: "bg-emerald-50", border: "border-emerald-200", text: "text-emerald-600",
        iconBg: "bg-emerald-100", hoverBg: "hover:bg-emerald-100", ring: "ring-emerald-300", dot: "bg-emerald-500",
      },
      {
        type: "schedule_trigger",
        label: "Schedule Trigger",
        desc: "Cron schedule",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25" />
          </svg>
        ),
        color: "emerald", bg: "bg-emerald-50", border: "border-emerald-200", text: "text-emerald-600",
        iconBg: "bg-emerald-100", hoverBg: "hover:bg-emerald-100", ring: "ring-emerald-300", dot: "bg-emerald-500",
      },
    ],
  },
];

const NODE_WIDTH = 300;
const NODE_HEIGHT = 180;
const LAYER_GAP_Y = 250;
const SIBLING_GAP_X = 350;

// ─── Auto-layout: layered tree (Sugiyama-style) ─────────────────

function autoLayout(rawNodes: any[], rawEdges: any[]): Node[] {
  if (rawNodes.length === 0) return [];

  // Build adjacency map (source -> targets)
  const children = new Map<string, string[]>();
  const hasParent = new Set<string>();
  for (const e of rawEdges) {
    const list = children.get(e.source) || [];
    list.push(e.target);
    children.set(e.source, list);
    hasParent.add(e.target);
  }

  // Find root: prefer "start" type, then any node with no incoming edges
  const nodeMap = new Map(rawNodes.map((n: any) => [n.id, n]));
  let rootId = rawNodes.find((n: any) => n.type === "start")?.id;
  if (!rootId) rootId = rawNodes.find((n: any) => !hasParent.has(n.id))?.id;
  if (!rootId) rootId = rawNodes[0].id;

  // BFS to assign layers
  const layers = new Map<string, number>();
  const queue: string[] = [rootId];
  layers.set(rootId, 0);
  const visited = new Set<string>([rootId]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentLayer = layers.get(current)!;
    for (const child of children.get(current) || []) {
      if (!visited.has(child)) {
        visited.add(child);
        layers.set(child, currentLayer + 1);
        queue.push(child);
      }
    }
  }

  // Any disconnected nodes go to the bottom
  let maxLayer = 0;
  for (const l of Array.from(layers.values())) maxLayer = Math.max(maxLayer, l);
  for (const n of rawNodes) {
    if (!layers.has(n.id)) {
      maxLayer++;
      layers.set(n.id, maxLayer);
    }
  }

  // Group nodes by layer
  const layerGroups = new Map<number, any[]>();
  for (const n of rawNodes) {
    const l = layers.get(n.id) || 0;
    const group = layerGroups.get(l) || [];
    group.push(n);
    layerGroups.set(l, group);
  }

  // Position each layer: center horizontally, stack vertically
  const positioned: Node[] = [];
  const sortedLayers = Array.from(layerGroups.keys()).sort((a, b) => a - b);

  for (const layerIdx of sortedLayers) {
    const group = layerGroups.get(layerIdx)!;
    const totalWidth = group.length * SIBLING_GAP_X;
    const startX = -totalWidth / 2 + SIBLING_GAP_X / 2;

    group.forEach((n: any, i: number) => {
      positioned.push({
        id: n.id,
        type: n.type,
        position: { x: startX + i * SIBLING_GAP_X, y: layerIdx * LAYER_GAP_Y },
        data: n.data || {},
      });
    });
  }

  return positioned;
}

// Find a clear spot for a new node that doesn't overlap existing ones
function findClearPosition(existingNodes: Node[]): { x: number; y: number } {
  if (existingNodes.length === 0) return { x: 0, y: 0 };

  // Find the bounding box of existing nodes
  let maxY = -Infinity;
  let sumX = 0;
  for (const n of existingNodes) {
    if (n.position.y > maxY) maxY = n.position.y;
    sumX += n.position.x;
  }

  // Place below the lowest node, centered horizontally
  const avgX = sumX / existingNodes.length;
  const candidateY = maxY + LAYER_GAP_Y;

  // Snap to grid
  const snappedX = Math.round(avgX / 15) * 15;
  const snappedY = Math.round(candidateY / 15) * 15;

  // Check for overlaps and shift if needed
  let finalX = snappedX;
  let finalY = snappedY;
  let attempts = 0;
  while (attempts < 20) {
    const overlaps = existingNodes.some(
      (n) =>
        Math.abs(n.position.x - finalX) < NODE_WIDTH &&
        Math.abs(n.position.y - finalY) < NODE_HEIGHT
    );
    if (!overlaps) break;
    finalX += SIBLING_GAP_X;
    attempts++;
  }

  return { x: finalX, y: finalY };
}

function getDefaultData(type: string) {
  switch (type) {
    // Legacy types
    case "message": return { text: "Hello!" };
    case "quick_reply": return { text: "Choose an option:", buttons: [{ id: "opt1", title: "Option 1" }] };
    case "condition": return { field: "intent", operator: "equals", value: "" };
    case "handover": return { departmentId: "" };
    case "department_route": return { departmentId: "" };
    case "end": return { kind: "wait_for_reply" };
    case "start": return { trigger: "message_received" };
    // Unified types (same as Main Playbook)
    case "condition_group":
      return {
        name: "New Condition",
        logic: "AND",
        conditions: [{ id: `c_${Date.now()}`, type: "keyword", operator: "contains", value: "" }],
      };
    case "route_target":
      return { routeType: "agent", targetId: "" };
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
    case "channel_entry":
      return { channelId: "", channelType: "", label: "", connected: false };
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

// ─── Component ──────────────────────────────────────────────────

interface Props {
  flowId: string;
  onBack?: () => void;
  onCreated?: (id: string) => void;
  /** Embedded in a tab (fills its container) rather than owning the full
   *  viewport - used by the canvas-first Processes tab. */
  embedded?: boolean;
}

export function FlowEditor(props: Props) {
  // ReactFlowProvider so the side-panel Inspector (rendered as a sibling of
  // <ReactFlow>) can call useReactFlow - VariableMentionInput needs it to
  // scan the canvas for available variables.
  return (
    <ReactFlowProvider>
      <FlowEditorInner {...props} />
    </ReactFlowProvider>
  );
}

function FlowEditorInner({ flowId, onBack, onCreated, embedded }: Props) {
  const isNew = flowId === "new";
  const { token } = useAuth();
  const { t } = useI18n();
  const [flow, setFlow] = useState<any>(null);
  const [flowName, setFlowName] = useState("");
  const [flowActive, setFlowActive] = useState(false);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  // Explicit, honest save lifecycle: never claim "saved" before the backend
  // confirms, surface unsaved edits, and block duplicate/concurrent saves.
  // A new (never-persisted) flow starts "unsaved"; a loaded one starts "saved".
  const [saveState, setSaveState] = useState<"saved" | "saving" | "unsaved" | "error">(isNew ? "unsaved" : "saved");
  const saving = saveState === "saving";
  // Guards the dirty-tracking effect so hydrating a loaded flow (or seeding the
  // start node for a new one) doesn't immediately flag "unsaved".
  const loadedRef = useRef(false);
  // Stale-overwrite guard: the version we loaded. A concurrent edit that bumps
  // it server-side makes our save a 409 instead of a silent clobber.
  const loadedUpdatedAtRef = useRef<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(true);
  // Full-screen editing: the editor fills the page (canvas maximised) while
  // keeping its own toolbar (Back + save + Exit) so navigation is never lost.
  const [fullscreen, setFullscreen] = useState(false);
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null);
  // Selection drives the side-panel Inspector (unified nodes only - the
  // legacy `./nodes/*` set still uses inline editing for now).
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  // Connected channels - feeds the channel_entry inspector picker.
  const [channels, setChannels] = useState<any[]>([]);
  useEffect(() => {
    if (!token) return;
    getChannels(token).then((r: any) => setChannels(r?.data || r || [])).catch(() => setChannels([]));
  }, [token]);

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
      const newNode: Node = { id, type, position, data: getDefaultData(type) };
      setNodes((nds) => [...nds, newNode]);
    },
    [reactFlowInstance, setNodes]
  );

  useEffect(() => {
    if (!token) return;
    if (isNew) {
      setFlowName("New Flow");
      const startNode: Node = { id: "start-1", type: "start", position: { x: 250, y: 50 }, data: {} };
      setNodes([startNode]);
      // Defer arming dirty-tracking to after this render commits the seed node.
      requestAnimationFrame(() => { loadedRef.current = true; });
      return;
    }
    getChatbotFlow(token, flowId).then((data) => {
      setFlow(data);
      setFlowName(data.name);
      setFlowActive(data.isActive ?? false);
      loadedUpdatedAtRef.current = data.updatedAt ?? null;

      const rawNodes = data.nodes as any[];
      const rawEdges = data.edges as any[];

      // Use saved positions if all nodes have them, otherwise auto-layout
      const allHavePositions = rawNodes.every((n: any) => n.position?.x !== undefined);

      if (allHavePositions && rawNodes.length > 0) {
        const rfNodes: Node[] = rawNodes.map((n: any) => ({
          id: n.id,
          type: n.type,
          position: n.position,
          data: n.data || {},
        }));
        setNodes(rfNodes);
      } else {
        setNodes(autoLayout(rawNodes, rawEdges));
      }

      setEdges(
        rawEdges.map((e: any) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          sourceHandle: e.sourceHandle,
          type: "bezier",
          animated: false,
          style: { stroke: "#c7c7cc", strokeWidth: 1.5 },
          markerEnd: { type: MarkerType.ArrowClosed, color: "#c7c7cc", width: 16, height: 16 },
        }))
      );
      setSaveState("saved");
      requestAnimationFrame(() => { loadedRef.current = true; });
    });
  }, [token, flowId]);

  // Dirty tracking: any change to the graph or name after load flags "unsaved"
  // (unless a save is already in flight, which will resolve the state itself).
  useEffect(() => {
    if (!loadedRef.current) return;
    setSaveState((s) => (s === "saving" ? s : "unsaved"));
  }, [nodes, edges, flowName]);

  const onConnect = useCallback(
    (params: Connection) => {
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
    [setEdges]
  );

  function addNode(type: string) {
    const id = `${type}-${Date.now()}`;
    const position = findClearPosition(nodes);
    const newNode: Node = {
      id,
      type,
      position,
      data: getDefaultData(type),
    };
    setNodes((nds) => [...nds, newNode]);
  }

  function handleAutoLayout() {
    const rawNodes = nodes.map((n) => ({ id: n.id, type: n.type, data: n.data }));
    const rawEdges = edges.map((e) => ({ source: e.source, target: e.target }));
    setNodes(autoLayout(rawNodes, rawEdges));
  }

  async function handleToggleActive() {
    if (!token || !flow || isNew) return;
    try {
      if (flowActive) {
        await deactivateChatbotFlow(token, flowId);
        setFlowActive(false);
      } else {
        await activateChatbotFlow(token, flowId);
        setFlowActive(true);
      }
    } catch (err) {
      console.error("Toggle active error:", err);
    }
  }

  async function handleSave() {
    // Block duplicate/concurrent saves - a second click while a save is in
    // flight must not fire a second request or race the version guard.
    if (!token || saveState === "saving") return;
    setSaveState("saving");
    setSaveError(null);
    try {
      const backendNodes = nodes.map((n) => ({
        id: n.id,
        type: n.type,
        position: n.position,
        data: n.data,
      }));
      const backendEdges = edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle,
      }));
      if (isNew && !flow) {
        const created = await createChatbotFlow(token, {
          name: flowName,
          description: "",
          nodes: backendNodes,
          edges: backendEdges,
        });
        setFlow(created);
        loadedUpdatedAtRef.current = created?.updatedAt ?? null;
        onCreated?.(created.id);
      } else {
        const updated = await updateChatbotFlow(token, flow?.id || flowId, {
          name: flowName,
          description: flow?.description || "",
          nodes: backendNodes,
          edges: backendEdges,
          // Optimistic concurrency: the backend rejects (409) when another
          // edit advanced the row past what we loaded, so we never clobber.
          expectedUpdatedAt: loadedUpdatedAtRef.current ?? undefined,
        } as any);
        if (updated?.updatedAt) loadedUpdatedAtRef.current = updated.updatedAt;
      }
      // Only NOW - after the backend confirmed - is it truly saved.
      setSaveState("saved");
    } catch (err: any) {
      console.error("Save error:", err);
      const conflict = err?.status === 409 || /conflict|stale|expectedUpdatedAt/i.test(String(err?.message || ""));
      setSaveError(conflict ? t("chatbot.saveConflict") : t("chatbot.saveFailed"));
      setSaveState("error");
    }
  }

  return (
    <div className={fullscreen ? "fixed inset-0 z-40 bg-white h-screen flex flex-col" : (embedded ? "h-full flex flex-col" : "h-screen flex flex-col")}>
      {/* Toolbar */}
      <div className="bg-white border-b border-gray-100 px-2 md:px-4 py-2 md:py-3 flex items-center gap-2 md:gap-3 shadow-sm">
        {onBack && (
          <button onClick={onBack} className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100 transition shrink-0">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
            </svg>
          </button>
        )}
        <input
          type="text"
          value={flowName}
          onChange={(e) => setFlowName(e.target.value)}
          className="text-sm md:text-lg font-bold text-gray-900 border-none outline-none flex-1 min-w-0 bg-transparent ps-8 md:ps-0"
        />

        {/* Toggle palette button */}
        <button
          onClick={() => setPaletteOpen(!paletteOpen)}
          className={`px-2 md:px-3 py-2 rounded-xl text-xs font-medium transition flex items-center gap-1.5 shrink-0 ${
            paletteOpen
              ? "bg-primary-50 text-primary-600 ring-1 ring-primary-200"
              : "bg-gray-50 hover:bg-gray-100 text-gray-600"
          }`}
          title="Toggle node palette"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          <span className="hidden sm:inline">Nodes</span>
        </button>

        <button
          onClick={handleAutoLayout}
          className="bg-gray-50 hover:bg-gray-100 text-gray-600 px-2 md:px-3 py-2 rounded-xl text-xs font-medium transition flex items-center gap-1.5 shrink-0"
          title="Auto-layout"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6z" />
          </svg>
          <span className="hidden sm:inline">Layout</span>
        </button>
        <button
          onClick={handleToggleActive}
          className={`px-2 md:px-3 py-2 rounded-xl text-xs font-medium transition flex items-center gap-1.5 shrink-0 ${
            flowActive
              ? "bg-green-50 text-green-600 hover:bg-green-100 ring-1 ring-green-200"
              : "bg-gray-100 text-gray-500 hover:bg-gray-200"
          }`}
        >
          <span className={`w-2 h-2 rounded-full ${flowActive ? "bg-green-500" : "bg-gray-400"}`} />
          <span className="hidden sm:inline">{flowActive ? t("chatbot.deactivate") : t("chatbot.activate")}</span>
        </button>
        {/* Honest save-state indicator - reflects backend-confirmed state,
            never claims Saved on a click alone. */}
        <span
          className={`hidden md:inline-flex items-center gap-1.5 text-xs font-medium shrink-0 ${
            saveState === "saved" ? "text-green-600"
              : saveState === "saving" ? "text-gray-500"
              : saveState === "error" ? "text-red-600"
              : "text-amber-600"
          }`}
          title={saveError || undefined}
          data-save-state={saveState}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${
            saveState === "saved" ? "bg-green-500"
              : saveState === "saving" ? "bg-gray-400 animate-pulse"
              : saveState === "error" ? "bg-red-500"
              : "bg-amber-500"
          }`} />
          {saveState === "saved" ? t("chatbot.stateSaved")
            : saveState === "saving" ? t("chatbot.stateSaving")
            : saveState === "error" ? (saveError || t("chatbot.saveFailed"))
            : t("chatbot.stateUnsaved")}
        </span>

        {/* Full-screen toggle */}
        <button
          onClick={() => setFullscreen((v) => !v)}
          className="bg-gray-50 hover:bg-gray-100 text-gray-600 p-2 rounded-xl transition shrink-0"
          title={fullscreen ? t("chatbot.exitFullscreen") : t("chatbot.fullscreen")}
          aria-label={fullscreen ? t("chatbot.exitFullscreen") : t("chatbot.fullscreen")}
        >
          {fullscreen ? (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25" /></svg>
          ) : (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" /></svg>
          )}
        </button>

        <button
          onClick={handleSave}
          disabled={saving}
          className="bg-primary-500 hover:bg-primary-600 text-white px-3 md:px-4 py-2 rounded-xl text-xs md:text-sm font-medium transition disabled:opacity-50 shadow-sm shrink-0"
        >
          {saveState === "saving" ? t("chatbot.stateSaving")
            : saveState === "error" ? t("chatbot.retrySave")
            : saveState === "saved" ? t("chatbot.stateSaved")
            : t("chatbot.save")}
        </button>
      </div>

      {/* Main area: palette + canvas */}
      <div className="flex-1 flex overflow-hidden">
        {/* Node Palette Sidebar */}
        <div
          className={`bg-white border-e border-gray-100 transition-all duration-300 ease-in-out overflow-y-auto overflow-x-hidden flex-shrink-0 ${
            paletteOpen ? "w-[240px] opacity-100" : "w-0 opacity-0"
          }`}
        >
          <div className="p-3 space-y-4 w-[240px]">
            {/* Header */}
            <div className="flex items-center gap-2 px-1 pt-1">
              <div className="w-6 h-6 rounded-lg bg-primary-100 flex items-center justify-center">
                <svg className="w-3.5 h-3.5 text-primary-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25a2.25 2.25 0 01-2.25-2.25v-2.25z" />
                </svg>
              </div>
              <span className="text-xs font-semibold text-gray-700 tracking-wide">Node Palette</span>
            </div>

            <p className="text-[10px] text-gray-400 px-1">Drag nodes to the canvas or click to add</p>

            {/* Categories */}
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
                        <p className={`text-xs font-semibold ${item.text} leading-tight`}>{item.label}</p>
                        <p className="text-[10px] text-gray-400 leading-tight mt-0.5 truncate">{item.desc}</p>
                      </div>
                      <div className={`ms-auto w-1.5 h-1.5 rounded-full ${item.dot} opacity-60 shrink-0`} />
                    </div>
                  ))}
                </div>
              </div>
            ))}

            {/* Tip */}
            <div className="mx-1 mt-2 p-2.5 rounded-xl bg-gray-50 border border-dashed border-gray-200">
              <p className="text-[10px] text-gray-400 leading-relaxed">
                <span className="font-semibold text-gray-500">Tip:</span> Connect nodes by dragging from one handle to another.
              </p>
            </div>
          </div>
        </div>

        {/* Canvas */}
        <div className="flex-1" ref={reactFlowWrapper}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onInit={setReactFlowInstance}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onNodeClick={(_, n) => { if (n.type && NODE_REGISTRY[n.type]) setSelectedNodeId(n.id); }}
            onPaneClick={() => setSelectedNodeId(null)}
            nodeTypes={nodeTypes}
            connectionLineType={ConnectionLineType.Bezier}
            defaultEdgeOptions={{
              type: "bezier",
              animated: false,
              style: { stroke: "#c7c7cc", strokeWidth: 1.5 },
              markerEnd: { type: MarkerType.ArrowClosed, color: "#c7c7cc", width: 16, height: 16 },
            }}
            fitView
            fitViewOptions={{ padding: 0.3 }}
            snapToGrid
            snapGrid={[15, 15]}
            minZoom={0.2}
            className="bg-[var(--surface-canvas)]"
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="rgba(0,0,0,0.06)" />
            <Controls />
          </ReactFlow>
        </div>
      </div>

      {/* Inspector for unified node types (canvas cards are read-only). */}
      <NodeInspector
        node={selectedNodeId ? nodes.find((n) => n.id === selectedNodeId) ?? null : null}
        shared={{ channels }}
        onChange={(id, patch) => setNodes((nds) => nds.map((n) => n.id === id ? { ...n, data: { ...n.data, ...patch } } : n))}
        onClose={() => setSelectedNodeId(null)}
        onDelete={(id) => {
          setNodes((nds) => nds.filter((n) => n.id !== id));
          setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id));
          setSelectedNodeId(null);
        }}
        onDuplicate={(id) => {
          setNodes((nds) => {
            const orig = nds.find((n) => n.id === id);
            if (!orig) return nds;
            const newId = `${orig.type}-${Date.now()}`;
            return [...nds, { id: newId, type: orig.type, position: { x: orig.position.x + 60, y: orig.position.y + 60 }, data: JSON.parse(JSON.stringify(orig.data || {})) }];
          });
        }}
      />
    </div>
  );
}
