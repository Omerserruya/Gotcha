"use client";

import { BaseEdge, EdgeLabelRenderer, getBezierPath, useReactFlow, type EdgeProps } from "reactflow";

/**
 * Bezier edge that renders a small ✕ delete button at its midpoint when the
 * edge is selected. Clicking an edge selects it (ReactFlow default), then the
 * ✕ unlinks the two nodes - giving an explicit on-canvas way to remove a
 * connection without the keyboard-delete footgun (the canvas sets
 * deleteKeyCode={null} so typing in inputs never nukes nodes).
 *
 * The component removes itself via useReactFlow().setEdges, so no per-edge
 * callback wiring is needed - it works for every edge that uses this type.
 */
export function DeletableEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  selected,
}: EdgeProps) {
  const { setEdges } = useReactFlow();
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={style} />
      {selected && (
        <EdgeLabelRenderer>
          <button
            type="button"
            className="nodrag nopan"
            title="Delete connection"
            onClick={(e) => {
              e.stopPropagation();
              setEdges((eds) => eds.filter((ed) => ed.id !== id));
            }}
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "all",
              width: 20,
              height: 20,
              borderRadius: "9999px",
              background: "#ef4444",
              color: "#fff",
              fontSize: 12,
              lineHeight: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              border: "2px solid #fff",
              boxShadow: "0 1px 4px rgba(0,0,0,0.25)",
              cursor: "pointer",
            }}
          >
            ✕
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
