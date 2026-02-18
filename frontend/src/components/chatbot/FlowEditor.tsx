"use client";

import { useState, useEffect, useCallback } from "react";
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

      {/* Canvas */}
      <div className="flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
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
          <Panel position="top-right">
            <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-3 space-y-1.5">
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Add Node</p>
              {(["message", "quick_reply", "condition", "handover", "department_route", "end"] as const).map(
                (type) => {
                  const labelMap: Record<string, string> = { quick_reply: "quickReply", department_route: "departmentRoute" };
                  return (
                    <button
                      key={type}
                      onClick={() => addNode(type)}
                      className="block w-full text-start text-xs px-3 py-2 rounded-xl bg-gray-50 hover:bg-primary-50 hover:text-primary-600 transition font-medium"
                    >
                      {t(`chatbot.nodeTypes.${labelMap[type] || type}`)}
                    </button>
                  );
                }
              )}
            </div>
          </Panel>
        </ReactFlow>
      </div>
    </div>
  );
}
