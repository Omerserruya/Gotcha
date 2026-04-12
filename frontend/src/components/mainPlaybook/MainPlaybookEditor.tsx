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
  MarkerType,
  ReactFlowInstance,
  MiniMap,
} from "reactflow";
import "reactflow/dist/style.css";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
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
import { ChannelEntryNode } from "./ChannelEntryNode";
import { ConditionGroupNode } from "./ConditionGroupNode";
import { RouteTargetNode } from "./RouteTargetNode";
import { DefaultFallbackNode } from "./DefaultFallbackNode";

// ─── Node types ────────────────────────────────────────────────
const nodeTypes: NodeTypes = {
  channel_entry: ChannelEntryNode,
  condition_group: ConditionGroupNode,
  route_target: RouteTargetNode,
  default_fallback: DefaultFallbackNode,
};

// ─── Node palette ──────────────────────────────────────────────
const NODE_PALETTE = [
  {
    category: "Logic",
    items: [
      {
        type: "condition_group",
        label: "Condition",
        desc: "Route based on conditions",
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
    category: "Destinations",
    items: [
      {
        type: "route_target",
        label: "Route To",
        desc: "AI agent, flow, or human",
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
  const nonDefaultRules = rules.filter((r: any) => !r.isDefault).sort((a: any, b: any) => a.priority - b.priority);
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

export function MainPlaybookEditor({ onBack }: Props) {
  const { token } = useAuth();
  const { t } = useI18n();
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(true);
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null);

  // Shared data for dropdowns inside nodes
  const [agents, setAgents] = useState<any[]>([]);
  const [flows, setFlows] = useState<any[]>([]);
  const [departments, setDepartments] = useState<any[]>([]);
  const [channels, setChannels] = useState<any[]>([]);
  const [rules, setRules] = useState<any[]>([]);

  // Load all data
  useEffect(() => {
    if (!token) return;
    Promise.all([
      getChannels(token).then((r) => r.data || r || []),
      getRouterRules(token).then((r) => r.data || []),
      getAIAgents(token).then((r) => r.data || []),
      getChatbotFlows(token).then((r) => (Array.isArray(r) ? r : (r as any).data || [])),
      getDepartments(token).then((r) => r.data || []),
    ])
      .then(([channelsData, rulesData, agentsData, flowsData, deptsData]) => {
        setChannels(channelsData);
        setRules(rulesData);
        setAgents(agentsData);
        setFlows(flowsData);
        setDepartments(deptsData);

        const savedLayout = loadLayout();
        const { nodes: initNodes, edges: initEdges } = buildNodesFromData(
          channelsData, rulesData, agentsData, flowsData, deptsData, savedLayout
        );
        setNodes(initNodes);
        setEdges(initEdges);
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
  async function handleSave() {
    if (!token) return;
    setSaving(true);
    try {
      // Save layout to localStorage for position persistence
      saveLayout(nodes, edges);

      // Convert canvas nodes back to router rules
      const channelNodes = nodes.filter((n) => n.type === "channel_entry");
      const conditionNodes = nodes.filter((n) => n.type === "condition_group");
      const fallbackNode = nodes.find((n) => n.type === "default_fallback");
      const routeTypeMap: Record<string, string> = { agent: "AI_AGENT", flow: "FLOW", human: "HUMAN" };

      // Delete non-default rules, update default rule
      const defaultRule = rules.find((r: any) => r.isDefault);
      for (const rule of rules) {
        if ((rule as any).isDefault) continue;
        try { await deleteRouterRule(token, rule.id); } catch {}
      }

      const newRuleIds: string[] = [];
      let priority = 1;

      // 1. Direct channel → route_target connections (no condition in between)
      for (const chNode of channelNodes) {
        const outEdges = edges.filter((e) => e.source === chNode.id);
        for (const outEdge of outEdges) {
          const targetNode = nodes.find((n) => n.id === outEdge.target);
          if (!targetNode) continue;

          if (targetNode.type === "route_target") {
            // Direct channel → target: create a rule with channel condition
            const channelType = (chNode.data?.channelType || "").toUpperCase();
            const routeType = routeTypeMap[targetNode.data?.routeType || "agent"] || "AI_AGENT";
            const targetId = targetNode.data?.targetId || "";
            const channelLabel = chNode.data?.label || chNode.data?.platformName || channelType;

            const payload: any = {
              name: `${channelLabel} Route`,
              conditions: [{ type: "channel", operator: "equals", value: channelType }],
              logic: "AND",
              routeType,
              routeTarget: targetId || null,
              aiAgentId: routeType === "AI_AGENT" ? targetId : null,
              enabled: true,
              isDefault: false,
            };

            const created: any = await createRouterRule(token, payload);
            newRuleIds.push(created.id || created.data?.id);
            priority++;
          }
          // If target is a condition_group, it will be handled below with channel info
        }
      }

      // 2. Condition group nodes (may have channel source connected)
      for (const condNode of conditionNodes) {
        const outEdge = edges.find((e) => e.source === condNode.id && e.sourceHandle === "true");
        const targetNode = outEdge ? nodes.find((n) => n.id === outEdge.target && n.type === "route_target") : null;

        // Find if a channel_entry connects to this condition node
        const inEdge = edges.find((e) => e.target === condNode.id);
        const sourceNode = inEdge ? nodes.find((n) => n.id === inEdge.source && n.type === "channel_entry") : null;

        const routeType = routeTypeMap[targetNode?.data?.routeType || "agent"] || "AI_AGENT";
        const targetId = targetNode?.data?.targetId || "";

        // Build conditions — include channel condition if connected to a channel entry
        const conditions = (condNode.data?.conditions || []).map((c: any) => ({
          type: c.type,
          operator: c.operator,
          value: c.value,
        }));
        if (sourceNode) {
          const channelType = (sourceNode.data?.channelType || "").toUpperCase();
          // Add channel condition if not already present
          if (!conditions.some((c: any) => c.type === "channel")) {
            conditions.unshift({ type: "channel", operator: "equals", value: channelType });
          }
        }

        const payload: any = {
          name: condNode.data?.name || `Rule ${priority}`,
          conditions,
          logic: condNode.data?.logic || "AND",
          routeType,
          routeTarget: targetId || null,
          aiAgentId: routeType === "AI_AGENT" ? targetId : null,
          enabled: true,
          isDefault: false,
        };

        const created: any = await createRouterRule(token, payload);
        newRuleIds.push(created.id || created.data?.id);
        priority++;
      }

      // Default fallback rule — update existing or create new
      if (fallbackNode) {
        const routeTypeMap: Record<string, string> = { agent: "AI_AGENT", flow: "FLOW", human: "HUMAN" };
        const routeType = routeTypeMap[fallbackNode.data?.routeType || "human"] || "HUMAN";
        const targetId = fallbackNode.data?.targetId || "";

        const payload: any = {
          name: "Default Fallback",
          conditions: [],
          logic: "AND",
          routeType,
          routeTarget: targetId || null,
          aiAgentId: routeType === "AI_AGENT" ? targetId : null,
          enabled: true,
          isDefault: true,
        };

        if (defaultRule) {
          // Update the existing default rule
          await updateRouterRule(token, defaultRule.id, payload);
          newRuleIds.push(defaultRule.id);
        } else {
          const created: any = await createRouterRule(token, payload);
          newRuleIds.push(created.id || created.data?.id);
        }
      }

      // Reorder
      if (newRuleIds.length > 0) {
        await reorderRouterRules(token, newRuleIds.filter(Boolean));
      }

      // Refresh rules
      const refreshed = await getRouterRules(token);
      setRules(refreshed.data || []);
    } catch (err) {
      console.error("Save error:", err);
    } finally {
      setSaving(false);
    }
  }

  // ─── Delete selected nodes ───────────────────────────────────
  const onNodesDelete = useCallback((deleted: Node[]) => {
    // Also remove connected edges
    const deletedIds = new Set(deleted.map((n) => n.id));
    setEdges((eds) => eds.filter((e) => !deletedIds.has(e.source) && !deletedIds.has(e.target)));
  }, [setEdges]);

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
                return "#e5e7eb";
              }}
            />
            <Background variant={BackgroundVariant.Dots} gap={15} size={1} color="#d1d5db" />
          </ReactFlow>
        </div>
      </div>
    </div>
  );
}
