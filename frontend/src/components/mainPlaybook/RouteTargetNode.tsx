"use client";

import { Handle, Position, NodeProps } from "reactflow";
import { useState } from "react";

type RouteType = "agent" | "flow" | "human";

const ROUTE_STYLES: Record<RouteType, { gradient: string; icon: React.ReactNode; label: string }> = {
  agent: {
    gradient: "from-violet-500 to-violet-600",
    label: "AI Agent",
    icon: (
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
      </svg>
    ),
  },
  flow: {
    gradient: "from-blue-500 to-blue-600",
    label: "Sub-Playbook",
    icon: (
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
      </svg>
    ),
  },
  human: {
    gradient: "from-sky-500 to-sky-600",
    label: "Human Agent",
    icon: (
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
      </svg>
    ),
  },
};

export function RouteTargetNode({ data }: NodeProps) {
  const [routeType, setRouteType] = useState<RouteType>(data.routeType || "agent");
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

  const style = ROUTE_STYLES[routeType];
  const targetOptions = routeType === "agent" ? agents : routeType === "flow" ? flows : departments;
  const selectedName = targetOptions.find((o) => o.id === targetId)?.name;

  return (
    <div className="bg-white rounded-2xl shadow-lg border border-gray-200 min-w-[220px] max-w-[260px] transition-shadow hover:shadow-xl">
      <Handle type="target" position={Position.Top} className="!bg-gray-400 !w-3 !h-3 !border-2 !border-white !shadow-sm" />

      {/* Header */}
      <div className={`bg-gradient-to-r ${style.gradient} text-white px-3.5 py-2 rounded-t-2xl text-xs font-semibold flex items-center gap-2`}>
        <div className="w-5 h-5 rounded-md bg-white/20 flex items-center justify-center">
          {style.icon}
        </div>
        {style.label}
      </div>

      {/* Body */}
      <div className="p-3 space-y-2">
        {/* Route type selector */}
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

        {/* Target selector */}
        <select
          value={targetId}
          onChange={(e) => handleTargetChange(e.target.value)}
          className="w-full text-xs border border-gray-200 bg-gray-50/50 rounded-lg px-2.5 py-1.5 focus:ring-2 focus:ring-violet-400/30 focus:border-violet-300 outline-none transition"
        >
          <option value="">Select {routeType === "agent" ? "agent" : routeType === "flow" ? "playbook" : "department"}...</option>
          {targetOptions.map((opt) => (
            <option key={opt.id} value={opt.id}>{opt.name}</option>
          ))}
        </select>

        {selectedName && (
          <div className="flex items-center gap-1.5 text-xs text-gray-500">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
            Route to: <span className="font-medium text-gray-700">{selectedName}</span>
          </div>
        )}
      </div>
    </div>
  );
}
