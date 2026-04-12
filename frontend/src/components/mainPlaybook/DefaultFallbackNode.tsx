"use client";

import { Handle, Position, NodeProps } from "reactflow";
import { useState } from "react";

type RouteType = "agent" | "flow" | "human";

export function DefaultFallbackNode({ data }: NodeProps) {
  const [routeType, setRouteType] = useState<RouteType>(data.routeType || "human");
  const [targetId, setTargetId] = useState<string>(data.targetId || "");

  const agents: { id: string; name: string }[] = data.agents || [];
  const flows: { id: string; name: string }[] = data.flows || [];
  const departments: { id: string; name: string }[] = data.departments || [];

  function handleTypeChange(type: RouteType) {
    setRouteType(type);
    setTargetId("");
    data.routeType = type;
    data.targetId = "";
  }

  function handleTargetChange(id: string) {
    setTargetId(id);
    data.targetId = id;
  }

  const targetOptions = routeType === "agent" ? agents : routeType === "flow" ? flows : departments;

  return (
    <div className="bg-white rounded-2xl shadow-lg border-2 border-dashed border-gray-300 min-w-[220px] max-w-[260px] transition-shadow hover:shadow-xl">
      <Handle type="target" position={Position.Top} className="!bg-gray-400 !w-3 !h-3 !border-2 !border-white !shadow-sm" />

      <div className="bg-gradient-to-r from-gray-400 to-gray-500 text-white px-3.5 py-2 rounded-t-xl text-xs font-semibold flex items-center gap-2">
        <div className="w-5 h-5 rounded-md bg-white/20 flex items-center justify-center">
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 12.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 18.75a.75.75 0 110-1.5.75.75 0 010 1.5z" />
          </svg>
        </div>
        Default Fallback
      </div>

      <div className="p-3 space-y-2">
        <p className="text-[10px] text-gray-400">Catches all unmatched conversations</p>

        <div className="flex rounded-lg border border-gray-200 overflow-hidden">
          {(["agent", "flow", "human"] as RouteType[]).map((type) => (
            <button
              key={type}
              onClick={() => handleTypeChange(type)}
              className={`flex-1 py-1.5 text-[10px] font-semibold transition ${
                routeType === type
                  ? "bg-gray-900 text-white"
                  : "bg-gray-50 text-gray-500 hover:bg-gray-100"
              }`}
            >
              {type === "agent" ? "AI" : type === "flow" ? "Flow" : "Human"}
            </button>
          ))}
        </div>

        <select
          value={targetId}
          onChange={(e) => handleTargetChange(e.target.value)}
          className="w-full text-xs border border-gray-200 bg-gray-50/50 rounded-lg px-2.5 py-1.5 focus:ring-2 focus:ring-gray-300 focus:border-gray-300 outline-none transition"
        >
          <option value="">Select target...</option>
          {targetOptions.map((opt) => (
            <option key={opt.id} value={opt.id}>{opt.name}</option>
          ))}
        </select>
      </div>
    </div>
  );
}
