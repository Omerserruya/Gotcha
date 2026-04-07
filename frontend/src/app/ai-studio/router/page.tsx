"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { AppLayout } from "@/components/AppLayout";
import { useI18n } from "@/context/I18nContext";
import { useAuth } from "@/context/AuthContext";
import {
  getRouterRules,
  createRouterRule,
  updateRouterRule,
  deleteRouterRule,
  reorderRouterRules,
  getAIAgents,
  getChatbotFlows,
  getChannels,
  getDepartments,
} from "@/lib/api";
import clsx from "clsx";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  BackgroundVariant,
  Node,
  Edge,
  NodeChange,
  applyNodeChanges,
  MarkerType,
  useReactFlow,
  ReactFlowProvider,
} from "reactflow";
import "reactflow/dist/style.css";
import { ChannelNode } from "@/components/routing/ChannelNode";
import { RuleNode } from "@/components/routing/RuleNode";
import { FlowNode } from "@/components/routing/FlowNode";
import { HandlerNode } from "@/components/routing/HandlerNode";

// ─── Types ────────────────────────────────────────────────────
type ConditionType = "intent" | "keyword" | "attribute" | "channel" | "time" | "sentiment";
type ConditionOperator = "equals" | "contains" | "is_not";
type RouteType = "agent" | "flow" | "human";
type LogicType = "AND" | "OR";

interface Condition {
  id: string;
  type: ConditionType;
  operator: ConditionOperator;
  value: string;
}

interface RouterRule {
  id: string;
  priority: number;
  name: string;
  conditions: Condition[];
  logic: LogicType;
  routeType: RouteType;
  routeTarget: string;
  routeTargetName?: string;
  enabled: boolean;
  isDefault?: boolean;
}

// ─── Data mapping ─────────────────────────────────────────────
function mapRule(apiRule: any): RouterRule {
  const typeMap: Record<string, RouteType> = {
    AI_AGENT: "agent",
    FLOW: "flow",
    HUMAN: "human",
    DEPARTMENT: "human",
  };
  return {
    id: apiRule.id,
    priority: apiRule.priority,
    name: apiRule.name,
    conditions: (apiRule.conditions || []).map((c: any, i: number) => ({
      id: c.id || `c_${i}`,
      type: c.type || "intent",
      operator: c.operator || "equals",
      value: c.value || "",
    })),
    logic: apiRule.logic || "AND",
    routeType: typeMap[apiRule.routeType] || "agent",
    routeTarget:
      apiRule.routeType === "AI_AGENT"
        ? apiRule.aiAgentId || ""
        : apiRule.routeTarget || "",
    routeTargetName: apiRule.routeTargetName || "",
    enabled: apiRule.enabled,
    isDefault: apiRule.isDefault,
  };
}

function toApiPayload(rule: RouterRule) {
  const typeMap: Record<RouteType, string> = {
    agent: "AI_AGENT",
    flow: "FLOW",
    human: "HUMAN",
  };
  return {
    name: rule.name,
    conditions: rule.conditions.map(({ id, ...rest }) => rest),
    logic: rule.logic,
    routeType: typeMap[rule.routeType],
    routeTarget: rule.routeType === "agent" ? null : rule.routeTarget,
    aiAgentId: rule.routeType === "agent" ? rule.routeTarget : null,
    enabled: rule.enabled,
    isDefault: rule.isDefault || false,
  };
}

// ─── Labels ───────────────────────────────────────────────────
const CONDITION_TYPE_LABELS: Record<ConditionType, string> = {
  intent: "AI Intent",
  keyword: "Keywords",
  attribute: "Customer Attribute",
  channel: "Channel",
  time: "Time",
  sentiment: "Sentiment",
};

const OPERATOR_LABELS: Record<ConditionOperator, string> = {
  equals: "equals",
  contains: "contains",
  is_not: "is not",
};

const ROUTE_TYPE_LABELS: Record<RouteType, string> = {
  agent: "AI Agent",
  flow: "Flow",
  human: "Human Agent",
};

function conditionSummary(rule: RouterRule): string {
  if (rule.isDefault) return "Default fallback — catches all unmatched conversations";
  return rule.conditions
    .map((c) => `${CONDITION_TYPE_LABELS[c.type]} ${OPERATOR_LABELS[c.operator]} "${c.value}"`)
    .join(` ${rule.logic} `);
}

// ─── Toggle ───────────────────────────────────────────────────
function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onChange(!checked); }}
      className={clsx(
        "relative shrink-0 rounded-full transition-colors",
        checked ? "bg-violet-500" : "bg-gray-200"
      )}
      style={{ width: 40, height: 22 }}
    >
      <span
        className={clsx(
          "absolute top-0.5 left-0.5 w-[18px] h-[18px] bg-white rounded-full shadow transition-transform",
          checked && "translate-x-[18px]"
        )}
      />
    </button>
  );
}

// ─── Condition Row ────────────────────────────────────────────
function ConditionRow({
  condition,
  onChange,
  onRemove,
  canRemove,
}: {
  condition: Condition;
  onChange: (updated: Condition) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const inputClass =
    "px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition";

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <select
        value={condition.type}
        onChange={(e) => onChange({ ...condition, type: e.target.value as ConditionType })}
        className={clsx(inputClass, "flex-1 min-w-[130px]")}
      >
        {(Object.keys(CONDITION_TYPE_LABELS) as ConditionType[]).map((t) => (
          <option key={t} value={t}>{CONDITION_TYPE_LABELS[t]}</option>
        ))}
      </select>
      <select
        value={condition.operator}
        onChange={(e) => onChange({ ...condition, operator: e.target.value as ConditionOperator })}
        className={clsx(inputClass, "w-28")}
      >
        {(Object.keys(OPERATOR_LABELS) as ConditionOperator[]).map((o) => (
          <option key={o} value={o}>{OPERATOR_LABELS[o]}</option>
        ))}
      </select>
      <input
        type="text"
        value={condition.value}
        onChange={(e) => onChange({ ...condition, value: e.target.value })}
        placeholder="Value..."
        className={clsx(inputClass, "flex-1 min-w-[120px]")}
      />
      {canRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="p-1.5 rounded-lg text-gray-300 hover:text-red-400 transition shrink-0"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  );
}

// ─── Rule Edit Panel (slide-over) ─────────────────────────────
function RuleEditPanel({
  rule,
  onClose,
  onSave,
  onDelete,
  onToggleEnabled,
  agents,
  flows,
  departments,
  isNew,
}: {
  rule: RouterRule;
  onClose: () => void;
  onSave: (updated: RouterRule) => void;
  onDelete?: () => void;
  onToggleEnabled?: () => void;
  agents: any[];
  flows: any[];
  departments: any[];
  isNew?: boolean;
}) {
  const [draft, setDraft] = useState<RouterRule>({ ...rule, conditions: rule.conditions.map((c) => ({ ...c })) });

  useEffect(() => {
    setDraft({ ...rule, conditions: rule.conditions.map((c) => ({ ...c })) });
  }, [rule]);

  function patchDraft(partial: Partial<RouterRule>) {
    setDraft((prev) => ({ ...prev, ...partial }));
  }

  function addCondition() {
    patchDraft({
      conditions: [...draft.conditions, { id: `c_${Date.now()}`, type: "intent", operator: "equals", value: "" }],
    });
  }

  function updateCondition(id: string, updated: Condition) {
    patchDraft({ conditions: draft.conditions.map((c) => (c.id === id ? updated : c)) });
  }

  function removeCondition(id: string) {
    patchDraft({ conditions: draft.conditions.filter((c) => c.id !== id) });
  }

  const inputClass =
    "w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition";

  const targetOptions: { value: string; label: string }[] =
    draft.routeType === "agent"
      ? agents.map((a) => ({ value: a.id, label: a.name }))
      : draft.routeType === "flow"
      ? flows.map((f) => ({ value: f.id, label: f.name }))
      : departments.map((d) => ({ value: d.id, label: d.name }));

  return (
    <div className="absolute top-0 right-0 z-20 h-full w-[420px] bg-white border-l border-gray-200 shadow-xl flex flex-col animate-in slide-in-from-right duration-200">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 rounded-xl bg-blue-50 flex items-center justify-center shrink-0">
            <svg className="w-4 h-4 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 3M21 7.5H7.5" />
            </svg>
          </div>
          <span className="text-sm font-semibold text-gray-900 truncate">
            {isNew ? "New Rule" : "Edit Rule"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {!draft.isDefault && onToggleEnabled && !isNew && (
            <Toggle checked={draft.enabled} onChange={() => onToggleEnabled()} />
          )}
          <button onClick={onClose} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-5 space-y-5">
        {/* Name */}
        <div>
          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Rule Name</label>
          <input
            type="text"
            value={draft.name}
            onChange={(e) => patchDraft({ name: e.target.value })}
            placeholder="Name this rule..."
            className={inputClass}
          />
        </div>

        {/* Conditions */}
        {!draft.isDefault && (
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">When (Conditions)</label>
            <div className="space-y-2.5">
              {draft.conditions.map((cond) => (
                <ConditionRow
                  key={cond.id}
                  condition={cond}
                  onChange={(updated) => updateCondition(cond.id, updated)}
                  onRemove={() => removeCondition(cond.id)}
                  canRemove={draft.conditions.length > 1}
                />
              ))}
            </div>
            <button
              type="button"
              onClick={addCondition}
              className="mt-2.5 flex items-center gap-1.5 text-sm text-violet-600 hover:text-violet-700 font-medium transition"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
              Add Condition
            </button>
            {draft.conditions.length > 1 && (
              <div className="mt-3 flex items-center gap-3">
                <span className="text-sm text-gray-500">Match:</span>
                <div className="flex gap-1 bg-gray-100 rounded-xl p-0.5">
                  {(["AND", "OR"] as LogicType[]).map((l) => (
                    <button
                      key={l}
                      type="button"
                      onClick={() => patchDraft({ logic: l })}
                      className={clsx(
                        "px-3 py-1 rounded-lg text-xs font-semibold transition",
                        draft.logic === l ? "bg-white text-violet-700 shadow-sm" : "text-gray-500 hover:text-gray-700"
                      )}
                    >
                      {l === "AND" ? "All (AND)" : "Any (OR)"}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Route To */}
        <div>
          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Route To</label>
          <div className="space-y-2">
            {(["agent", "flow", "human"] as RouteType[]).map((rt) => (
              <label
                key={rt}
                className={clsx(
                  "flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition",
                  draft.routeType === rt ? "border-violet-300 bg-violet-50" : "border-gray-100 bg-white hover:border-gray-200"
                )}
              >
                <input
                  type="radio"
                  name="routeType"
                  checked={draft.routeType === rt}
                  onChange={() => patchDraft({ routeType: rt, routeTarget: "" })}
                  className="w-4 h-4 text-violet-600 border-gray-300 focus:ring-violet-500"
                />
                <span className={clsx("text-sm font-medium", draft.routeType === rt ? "text-violet-800" : "text-gray-700")}>
                  {ROUTE_TYPE_LABELS[rt]}
                </span>
                {draft.routeType === rt && (
                  <select
                    value={draft.routeTarget}
                    onChange={(e) => patchDraft({ routeTarget: e.target.value })}
                    onClick={(e) => e.stopPropagation()}
                    className="ml-auto px-3 py-1.5 bg-white border border-violet-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 outline-none transition text-gray-700 max-w-[180px]"
                  >
                    <option value="">Select...</option>
                    {targetOptions.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                )}
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center gap-3 px-5 py-4 border-t border-gray-100">
        <button
          type="button"
          onClick={() => onSave(draft)}
          className="flex items-center gap-2 px-5 py-2.5 bg-violet-600 hover:bg-violet-700 text-white rounded-xl text-sm font-medium transition shadow-sm"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
          </svg>
          {isNew ? "Create Rule" : "Save Rule"}
        </button>
        <button type="button" onClick={onClose} className="px-4 py-2.5 text-gray-500 hover:text-gray-700 text-sm transition">
          Cancel
        </button>
        {onDelete && !rule.isDefault && !isNew && (
          <button
            type="button"
            onClick={onDelete}
            className="ml-auto flex items-center gap-1.5 px-3 py-2 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-xl text-sm transition"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
            </svg>
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Unconnected Channels Banner ──────────────────────────────
function UnconnectedBanner({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <div className="absolute top-4 left-4 z-10 flex items-center gap-2 px-4 py-2.5 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800 shadow-sm">
      <svg className="w-4 h-4 text-amber-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
      </svg>
      <span className="font-medium">{count}</span> channel{count > 1 ? "s have" : " has"} no routing rule connected
    </div>
  );
}

// ─── Node Types (memoized outside component) ──────────────────
const nodeTypes = {
  channelNode: ChannelNode,
  ruleNode: RuleNode,
  flowNode: FlowNode,
  handlerNode: HandlerNode,
};

// ─── Build Unified Canvas ─────────────────────────────────────
function buildUnifiedCanvas(
  channels: any[],
  rules: RouterRule[],
  agents: any[],
  flows: any[],
  departments: any[],
  selectedRuleId: string | null,
  onRuleSelect: (ruleId: string) => void,
): { nodes: Node[]; edges: Edge[]; unconnectedCount: number } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const handlerIds = new Set<string>();

  const COL_X = { channel: 60, rule: 380, destination: 700 };
  const ROW_H = 120;
  const TOP_PAD = 60;

  // Sort rules: non-default by priority, then default last
  const sortedRules = [...rules].sort((a, b) => {
    if (a.isDefault) return 1;
    if (b.isDefault) return -1;
    return a.priority - b.priority;
  });

  // Track which channels have edges
  const channelsWithEdges = new Set<string>();

  // ── Left column: Channel nodes ──
  const activeChannels = channels.filter((ch) => ch.isActive !== false);
  activeChannels.forEach((ch, idx) => {
    const channelType = (ch.channel || "webchat").toLowerCase();
    nodes.push({
      id: `channel_${ch.id}`,
      type: "channelNode",
      position: { x: COL_X.channel, y: idx * ROW_H + TOP_PAD },
      data: {
        label: ch.displayName || ch.channel,
        channelType,
        connected: ch.connectionStatus === "CONNECTED",
        accountName: ch.externalId,
        hasWarning: false, // will be updated after edges
      },
    });
  });

  // ── Middle column: Rule nodes ──
  sortedRules.forEach((rule, idx) => {
    const nodeId = `rule_${rule.id}`;
    nodes.push({
      id: nodeId,
      type: "ruleNode",
      position: { x: COL_X.rule, y: idx * ROW_H + TOP_PAD },
      data: {
        label: rule.name,
        conditionSummary: conditionSummary(rule),
        enabled: rule.enabled,
        priority: rule.priority,
        isDefault: rule.isDefault,
        selected: selectedRuleId === rule.id,
        onSelect: () => onRuleSelect(rule.id),
      },
    });

    // ── Channel → Rule edges ──
    const channelConditions = rule.conditions.filter((c) => c.type === "channel");

    if (channelConditions.length > 0 && !rule.isDefault) {
      // Connect only matching channels
      activeChannels.forEach((ch) => {
        const channelType = (ch.channel || "").toLowerCase();
        const matches = channelConditions.some((cc) => {
          const val = cc.value.toLowerCase();
          if (cc.operator === "equals") return channelType === val;
          if (cc.operator === "contains") return channelType.includes(val);
          if (cc.operator === "is_not") return channelType !== val;
          return false;
        });
        if (matches) {
          channelsWithEdges.add(ch.id);
          edges.push({
            id: `e_ch${ch.id}_${nodeId}`,
            source: `channel_${ch.id}`,
            target: nodeId,
            type: "smoothstep",
            animated: rule.enabled,
            markerEnd: { type: MarkerType.ArrowClosed, color: rule.enabled ? "#a78bfa" : "#d1d5db" },
            style: { stroke: rule.enabled ? "#a78bfa" : "#d1d5db", strokeWidth: 1.5, opacity: rule.enabled ? 1 : 0.3 },
          });
        }
      });
    } else {
      // No channel conditions or default rule: connect all channels
      activeChannels.forEach((ch) => {
        channelsWithEdges.add(ch.id);
        edges.push({
          id: `e_ch${ch.id}_${nodeId}`,
          source: `channel_${ch.id}`,
          target: nodeId,
          type: "smoothstep",
          animated: rule.enabled && !rule.isDefault,
          markerEnd: { type: MarkerType.ArrowClosed, color: rule.enabled ? (rule.isDefault ? "#9ca3af" : "#a78bfa") : "#d1d5db" },
          style: {
            stroke: rule.enabled ? (rule.isDefault ? "#9ca3af" : "#a78bfa") : "#d1d5db",
            strokeWidth: rule.isDefault ? 1 : 1.5,
            strokeDasharray: rule.isDefault ? "5,5" : undefined,
            opacity: rule.enabled ? (rule.isDefault ? 0.5 : 1) : 0.3,
          },
        });
      });
    }

    // ── Rule → Destination edges ──
    let handlerNodeId: string | null = null;

    if (rule.routeType === "agent" && rule.routeTarget) {
      const agent = agents.find((a) => a.id === rule.routeTarget);
      handlerNodeId = `handler_agent_${rule.routeTarget}`;
      if (!handlerIds.has(handlerNodeId)) {
        handlerIds.add(handlerNodeId);
        nodes.push({
          id: handlerNodeId,
          type: "handlerNode",
          position: { x: COL_X.destination, y: 0 }, // repositioned below
          data: {
            label: agent?.name || rule.routeTargetName || "AI Agent",
            handlerType: "agent",
            mode: agent?.mode || "auto",
            status: agent?.isActive ? "active" : "inactive",
          },
        });
      }
    } else if (rule.routeType === "flow" && rule.routeTarget) {
      const flow = flows.find((f) => f.id === rule.routeTarget);
      handlerNodeId = `handler_flow_${rule.routeTarget}`;
      if (!handlerIds.has(handlerNodeId)) {
        handlerIds.add(handlerNodeId);
        nodes.push({
          id: handlerNodeId,
          type: "flowNode",
          position: { x: COL_X.destination, y: 0 },
          data: {
            label: flow?.name || rule.routeTargetName || "Flow",
            active: flow?.isActive !== false,
          },
        });
      }
    } else if (rule.routeType === "human") {
      const deptId = rule.routeTarget;
      const dept = departments.find((d) => d.id === deptId);
      handlerNodeId = deptId ? `handler_dept_${deptId}` : "handler_human_default";
      if (!handlerIds.has(handlerNodeId)) {
        handlerIds.add(handlerNodeId);
        nodes.push({
          id: handlerNodeId,
          type: "handlerNode",
          position: { x: COL_X.destination, y: 0 },
          data: {
            label: dept?.name || "Human Agents",
            handlerType: "human",
            status: "online",
            memberCount: dept?.memberCount,
          },
        });
      }
    }

    if (handlerNodeId) {
      edges.push({
        id: `e_${nodeId}_${handlerNodeId}`,
        source: nodeId,
        target: handlerNodeId,
        type: "smoothstep",
        animated: rule.enabled,
        markerEnd: { type: MarkerType.ArrowClosed, color: rule.enabled ? "#a78bfa" : "#d1d5db" },
        style: { stroke: rule.enabled ? "#a78bfa" : "#d1d5db", strokeWidth: 1.5, opacity: rule.enabled ? 1 : 0.3 },
      });
    }
  });

  // ── Position destination nodes evenly ──
  const destNodes = nodes.filter(
    (n) => n.type === "handlerNode" || n.type === "flowNode"
  );
  destNodes.forEach((n, idx) => {
    n.position = { x: COL_X.destination, y: idx * ROW_H + TOP_PAD };
  });

  // ── Mark unconnected channels ──
  let unconnectedCount = 0;
  activeChannels.forEach((ch) => {
    if (!channelsWithEdges.has(ch.id)) {
      const node = nodes.find((n) => n.id === `channel_${ch.id}`);
      if (node) {
        node.data = { ...node.data, hasWarning: true };
        unconnectedCount++;
      }
    }
  });

  return { nodes, edges, unconnectedCount };
}

// ─── Canvas Inner (needs useReactFlow) ────────────────────────
function CanvasInner({
  nodes: initialNodes,
  edges,
  unconnectedCount,
  selectedRuleId,
  selectedRule,
  onRuleSelect,
  onClosePanel,
  onSaveRule,
  onDeleteRule,
  onToggleEnabled,
  onAddRule,
  agents,
  flows,
  departments,
  isNewRule,
  loading,
}: {
  nodes: Node[];
  edges: Edge[];
  unconnectedCount: number;
  selectedRuleId: string | null;
  selectedRule: RouterRule | null;
  onRuleSelect: (id: string) => void;
  onClosePanel: () => void;
  onSaveRule: (updated: RouterRule) => void;
  onDeleteRule: (id: string) => void;
  onToggleEnabled: (id: string) => void;
  onAddRule: () => void;
  agents: any[];
  flows: any[];
  departments: any[];
  isNewRule: boolean;
  loading: boolean;
}) {
  const [nodes, setNodes] = useState<Node[]>(initialNodes);
  const { fitView } = useReactFlow();
  const prevNodeCountRef = useRef(initialNodes.length);

  useEffect(() => {
    setNodes(initialNodes);
    if (initialNodes.length !== prevNodeCountRef.current) {
      prevNodeCountRef.current = initialNodes.length;
      setTimeout(() => fitView({ padding: 0.15 }), 150);
    }
  }, [initialNodes, fitView]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setNodes((prev) => applyNodeChanges(changes, prev));
    },
    []
  );

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-violet-400 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm text-gray-400">Loading routing flow...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 relative">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={(_, node) => {
          if (node.type === "ruleNode" && node.id.startsWith("rule_")) {
            const ruleId = node.id.replace("rule_", "");
            onRuleSelect(ruleId);
          }
        }}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        defaultEdgeOptions={{
          type: "smoothstep",
          animated: true,
          markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: "#a78bfa" },
          style: { stroke: "#a78bfa", strokeWidth: 2 },
        }}
        className="bg-gray-50"
        nodesDraggable
        nodesConnectable={false}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#e5e7eb" />
        <Controls className="!shadow-sm !border !border-gray-100 !rounded-xl overflow-hidden" />
        <MiniMap
          nodeColor={(n) => {
            if (n.type === "channelNode") return "#10b981";
            if (n.type === "ruleNode") return "#60a5fa";
            if (n.type === "flowNode") return "#34d399";
            return "#a78bfa";
          }}
          className="!shadow-sm !border !border-gray-100 !rounded-xl overflow-hidden"
        />
      </ReactFlow>

      <UnconnectedBanner count={unconnectedCount} />

      {/* Add Rule button */}
      <button
        onClick={onAddRule}
        className="absolute bottom-4 left-4 z-10 flex items-center gap-2 px-4 py-2.5 bg-violet-600 hover:bg-violet-700 text-white rounded-xl text-sm font-medium shadow-lg transition"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
        </svg>
        Add Rule
      </button>

      {/* Re-layout button */}
      <button
        onClick={() => fitView({ padding: 0.15 })}
        className="absolute bottom-4 right-4 z-10 flex items-center gap-2 px-3 py-2 bg-white hover:bg-gray-50 text-gray-600 border border-gray-200 rounded-xl text-xs font-medium shadow-sm transition"
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
        </svg>
        Fit View
      </button>

      {/* Side panel */}
      {selectedRule && (
        <RuleEditPanel
          rule={selectedRule}
          onClose={onClosePanel}
          onSave={onSaveRule}
          onDelete={() => onDeleteRule(selectedRule.id)}
          onToggleEnabled={() => onToggleEnabled(selectedRule.id)}
          agents={agents}
          flows={flows}
          departments={departments}
          isNew={isNewRule}
        />
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────
export default function RouterPage() {
  const router = useRouter();
  const { t } = useI18n();
  const { token } = useAuth();

  const [rules, setRules] = useState<RouterRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [agents, setAgents] = useState<any[]>([]);
  const [flows, setFlows] = useState<any[]>([]);
  const [channels, setChannels] = useState<any[]>([]);
  const [departments, setDepartments] = useState<any[]>([]);
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);
  const [isNewRule, setIsNewRule] = useState(false);
  const [saved, setSaved] = useState(false);

  async function fetchAll() {
    if (!token) return;
    setLoading(true);
    try {
      const [rulesRes, agentsRes, flowsRes, channelsRes, deptsRes] = await Promise.all([
        getRouterRules(token),
        getAIAgents(token),
        getChatbotFlows(token),
        getChannels(token),
        getDepartments(token),
      ]);
      setRules((rulesRes.data || []).map(mapRule));
      setAgents(agentsRes.data || []);
      setFlows(flowsRes as any[] || []);
      setChannels(channelsRes.data || []);
      setDepartments(deptsRes.data || []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // ── Canvas data derived from state ──
  const handleRuleSelect = useCallback((ruleId: string) => {
    setIsNewRule(false);
    setSelectedRuleId((prev) => (prev === ruleId ? null : ruleId));
  }, []);

  const { nodes, edges, unconnectedCount } = useMemo(
    () => buildUnifiedCanvas(channels, rules, agents, flows, departments, selectedRuleId, handleRuleSelect),
    [channels, rules, agents, flows, departments, selectedRuleId, handleRuleSelect]
  );

  // ── Find the selected rule object ──
  const selectedRule = useMemo(() => {
    if (!selectedRuleId) return null;
    if (isNewRule) {
      return {
        id: selectedRuleId,
        priority: rules.length + 1,
        name: "",
        conditions: [{ id: `c_${Date.now()}`, type: "intent" as ConditionType, operator: "equals" as ConditionOperator, value: "" }],
        logic: "AND" as LogicType,
        routeType: "agent" as RouteType,
        routeTarget: "",
        enabled: true,
      };
    }
    return rules.find((r) => r.id === selectedRuleId) || null;
  }, [selectedRuleId, rules, isNewRule]);

  function flashSaved() {
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function toggleEnabled(id: string) {
    if (!token) return;
    const rule = rules.find((r) => r.id === id);
    if (!rule) return;
    await updateRouterRule(token, id, { enabled: !rule.enabled });
    flashSaved();
    await fetchAll();
  }

  async function saveRule(updated: RouterRule) {
    if (!token) return;
    if (!updated.name.trim()) {
      alert("Please enter a rule name");
      return;
    }
    const payload = toApiPayload(updated);
    const existsInDb = rules.some((r) => r.id === updated.id);
    if (existsInDb) {
      await updateRouterRule(token, updated.id, payload);
    } else {
      const hasDefault = rules.some((r) => r.isDefault);
      if (!hasDefault) {
        await createRouterRule(token, {
          name: "Default Fallback",
          conditions: [],
          logic: "AND",
          routeType: "HUMAN",
          routeTarget: null,
          enabled: true,
          isDefault: true,
        });
      }
      await createRouterRule(token, payload);
    }
    setSelectedRuleId(null);
    setIsNewRule(false);
    flashSaved();
    await fetchAll();
  }

  async function deleteRule(id: string) {
    if (!token) return;
    await deleteRouterRule(token, id);
    setSelectedRuleId(null);
    setIsNewRule(false);
    await fetchAll();
  }

  function handleAddRule() {
    const tempId = `new_${Date.now()}`;
    setIsNewRule(true);
    setSelectedRuleId(tempId);
  }

  return (
    <AppLayout>
      <div className="flex flex-col h-screen overflow-hidden">
        {/* Header */}
        <div className="p-3 md:p-5 pb-0 shrink-0">
          <button
            onClick={() => router.push("/ai-studio")}
            className="flex items-center gap-2 text-gray-400 hover:text-gray-700 text-sm mb-4 transition"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
            </svg>
            {t("aiStudio.router.backToStudio")}
          </button>

          <div className="flex items-start justify-between gap-4 mb-4">
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-2xl bg-violet-100 flex items-center justify-center shrink-0">
                <svg className="w-5 h-5 text-violet-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 6.75V15m6-6v8.25m.503 3.498l4.875-2.437c.381-.19.622-.58.622-1.006V4.82c0-.836-.88-1.38-1.628-1.006l-3.869 1.934c-.317.159-.69.159-1.006 0L9.503 3.252a1.125 1.125 0 00-1.006 0L3.622 5.689C3.24 5.88 3 6.27 3 6.695V19.18c0 .836.88 1.38 1.628 1.006l3.869-1.934c.317-.159.69-.159 1.006 0l4.994 2.497c.317.158.69.158 1.006 0z" />
                </svg>
              </div>
              <div>
                <h1 className="text-xl font-bold text-gray-900">{t("aiStudio.router.pageTitle")}</h1>
                <p className="text-sm text-gray-400 mt-0.5">{t("aiStudio.router.pageSubtitle")}</p>
              </div>
            </div>

            <div className="flex items-center gap-3 shrink-0">
              {saved && (
                <div className="flex items-center gap-2 px-3 py-2 bg-green-50 text-green-700 rounded-xl text-sm font-medium">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                  Saved
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Canvas */}
        <ReactFlowProvider>
          <CanvasInner
            nodes={nodes}
            edges={edges}
            unconnectedCount={unconnectedCount}
            selectedRuleId={selectedRuleId}
            selectedRule={selectedRule}
            onRuleSelect={handleRuleSelect}
            onClosePanel={() => { setSelectedRuleId(null); setIsNewRule(false); }}
            onSaveRule={saveRule}
            onDeleteRule={deleteRule}
            onToggleEnabled={toggleEnabled}
            onAddRule={handleAddRule}
            agents={agents}
            flows={flows}
            departments={departments}
            isNewRule={isNewRule}
            loading={loading}
          />
        </ReactFlowProvider>
      </div>
    </AppLayout>
  );
}
