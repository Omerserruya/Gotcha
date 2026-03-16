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
} from "reactflow";
import "reactflow/dist/style.css";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { getChatbotFlow, updateChatbotFlow, activateChatbotFlow, deactivateChatbotFlow } from "@/lib/api";
import { StartNode } from "./nodes/StartNode";
import { MessageNode } from "./nodes/MessageNode";
import { QuickReplyNode } from "./nodes/QuickReplyNode";
import { ConditionNode } from "./nodes/ConditionNode";
import { HandoverNode } from "./nodes/HandoverNode";
import { DepartmentRouteNode } from "./nodes/DepartmentRouteNode";
import { EndNode } from "./nodes/EndNode";

const nodeTypes: NodeTypes = {
  start: StartNode,
  message: MessageNode,
  quick_reply: QuickReplyNode,
  condition: ConditionNode,
  handover: HandoverNode,
  department_route: DepartmentRouteNode,
  end: EndNode,
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
      {
        type: "department_route",
        label: "Dept. Route",
        desc: "Route to a department queue",
        icon: (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z" />
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
    case "message": return { text: "Hello!" };
    case "quick_reply": return { text: "Choose an option:", buttons: [{ id: "opt1", title: "Option 1" }] };
    case "condition": return { conditions: [], defaultTargetNodeId: null };
    case "handover": return {};
    case "department_route": return { departmentId: "" };
    case "end": return {};
    default: return {};
  }
}

// ─── Component ──────────────────────────────────────────────────

interface Props {
  flowId: string;
  onBack?: () => void;
}

export function FlowEditor({ flowId, onBack }: Props) {
  const { token } = useAuth();
  const { t } = useI18n();
  const [flow, setFlow] = useState<any>(null);
  const [flowName, setFlowName] = useState("");
  const [flowActive, setFlowActive] = useState(false);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [saving, setSaving] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(true);
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null);

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
    getChatbotFlow(token, flowId).then((data) => {
      setFlow(data);
      setFlowName(data.name);
      setFlowActive(data.isActive ?? false);

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
          type: "smoothstep",
          animated: true,
          style: { stroke: "#7c5cfc", strokeWidth: 2 },
          markerEnd: { type: MarkerType.ArrowClosed, color: "#7c5cfc", width: 16, height: 16 },
        }))
      );
    });
  }, [token, flowId]);

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
    if (!token || !flow) return;
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
    if (!token) return;
    setSaving(true);
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
      await updateChatbotFlow(token, flowId, {
        name: flowName,
        description: flow?.description || "",
        nodes: backendNodes,
        edges: backendEdges,
      });
    } catch (err) {
      console.error("Save error:", err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="h-screen flex flex-col">
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
        <button
          onClick={handleSave}
          disabled={saving}
          className="bg-primary-500 hover:bg-primary-600 text-white px-3 md:px-4 py-2 rounded-xl text-xs md:text-sm font-medium transition disabled:opacity-50 shadow-sm shrink-0"
        >
          {saving ? t("common.loading") : t("chatbot.save")}
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
            nodeTypes={nodeTypes}
            connectionLineType={ConnectionLineType.SmoothStep}
            defaultEdgeOptions={{ type: "smoothstep" }}
            fitView
            fitViewOptions={{ padding: 0.3 }}
            snapToGrid
            snapGrid={[15, 15]}
            minZoom={0.2}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#e2e8f0" />
            <Controls />
          </ReactFlow>
        </div>
      </div>
    </div>
  );
}
