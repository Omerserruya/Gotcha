"use client";

import { Handle, Position, NodeProps } from "reactflow";

const MODE_LABELS: Record<string, string> = {
  auto: "Auto",
  copilot: "Copilot",
  manual: "Manual",
};

export function HandlerNode({ data }: NodeProps) {
  const isHuman = data.handlerType === "human" || data.handlerType === "department";
  const borderColor = isHuman ? "border-l-blue-400" : "border-l-violet-500";
  const iconBg = isHuman ? "bg-blue-50" : "bg-violet-50";
  const iconColor = isHuman ? "text-blue-500" : "text-violet-500";
  const labelColor = isHuman ? "text-blue-600" : "text-violet-600";
  const badgeBg = data.status === "active" || data.status === "online"
    ? "bg-green-50 text-green-600"
    : "bg-gray-100 text-gray-400";

  return (
    <div
      className={`bg-white rounded-xl shadow-sm border border-gray-100 border-l-4 ${borderColor} min-w-[180px] max-w-[220px] cursor-pointer hover:shadow-md transition-shadow`}
      onClick={data.onSelect}
    >
      <Handle type="target" position={Position.Left} className={`!w-2.5 !h-2.5 !border-2 !border-white ${isHuman ? "!bg-blue-400" : "!bg-violet-500"}`} />
      <div className="p-3">
        <div className="flex items-center gap-2 mb-1">
          <div className={`w-5 h-5 rounded-md ${iconBg} flex items-center justify-center flex-shrink-0`}>
            {isHuman ? (
              <svg className={`w-3 h-3 ${iconColor}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
              </svg>
            ) : (
              <svg className={`w-3 h-3 ${iconColor}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
              </svg>
            )}
          </div>
          <span className={`text-xs font-semibold ${labelColor} uppercase tracking-wide`}>
            {isHuman ? "Human" : "AI Agent"}
          </span>
          {data.status && (
            <span className={`ml-auto text-xs px-1.5 py-0.5 rounded-full font-medium flex-shrink-0 ${badgeBg}`}>
              {data.status}
            </span>
          )}
        </div>
        <p className="text-sm font-semibold text-gray-900 truncate">{data.label || "Unnamed"}</p>
        {data.mode && !isHuman && (
          <p className="text-xs text-gray-400 mt-0.5">{MODE_LABELS[data.mode] || data.mode} mode</p>
        )}
        {data.memberCount != null && isHuman && (
          <p className="text-xs text-gray-400 mt-0.5">{data.memberCount} member{data.memberCount !== 1 ? "s" : ""}</p>
        )}
      </div>
    </div>
  );
}
