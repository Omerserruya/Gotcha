"use client";

import { Handle, Position, NodeProps } from "reactflow";

const CHANNEL_COLORS: Record<string, { border: string; bg: string; text: string; dot: string }> = {
  whatsapp:  { border: "border-l-green-500",  bg: "bg-green-50",  text: "text-green-700",  dot: "bg-green-500"  },
  instagram: { border: "border-l-pink-500",   bg: "bg-pink-50",   text: "text-pink-700",   dot: "bg-pink-500"   },
  facebook:  { border: "border-l-blue-500",   bg: "bg-blue-50",   text: "text-blue-700",   dot: "bg-blue-500"   },
  email:     { border: "border-l-amber-500",  bg: "bg-amber-50",  text: "text-amber-700",  dot: "bg-amber-500"  },
  sms:       { border: "border-l-teal-500",   bg: "bg-teal-50",   text: "text-teal-700",   dot: "bg-teal-500"   },
  webchat:   { border: "border-l-violet-500", bg: "bg-violet-50", text: "text-violet-700", dot: "bg-violet-500" },
};

const CHANNEL_ICONS: Record<string, React.ReactNode> = {
  whatsapp: (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
    </svg>
  ),
  instagram: (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z" />
    </svg>
  ),
  email: (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
    </svg>
  ),
};

function getChannelIcon(type: string) {
  return CHANNEL_ICONS[type] || (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.288 15.038a5.25 5.25 0 017.424 0M5.106 11.856c3.807-3.808 9.98-3.808 13.788 0M1.924 8.674c5.565-5.565 14.587-5.565 20.152 0M12.53 18.22l-.53.53-.53-.53a.75.75 0 011.06 0z" />
    </svg>
  );
}

export function ChannelNode({ data }: NodeProps) {
  const channelType = (data.channelType || "webchat").toLowerCase();
  const colors = CHANNEL_COLORS[channelType] || CHANNEL_COLORS.webchat;

  const hasWarning = data.hasWarning === true;

  return (
    <div
      className={`bg-white rounded-xl shadow-sm border ${hasWarning ? "border-amber-400 ring-2 ring-amber-200" : "border-gray-100"} border-l-4 ${colors.border} min-w-[180px] max-w-[220px] cursor-pointer hover:shadow-md transition-shadow relative`}
      onClick={data.onSelect}
    >
      {hasWarning && (
        <div className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-amber-400 flex items-center justify-center shadow-sm z-10">
          <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
        </div>
      )}
      <div className="p-3">
        <div className="flex items-center gap-2 mb-1">
          <span className={`${colors.text} flex-shrink-0`}>{getChannelIcon(channelType)}</span>
          <span className="text-xs font-semibold text-gray-700 capitalize">{data.channelType || "Channel"}</span>
          <span className={`ml-auto w-2 h-2 rounded-full flex-shrink-0 ${data.connected ? colors.dot : "bg-gray-300"}`} />
        </div>
        <p className="text-sm font-medium text-gray-900 truncate">{data.label || "Unnamed"}</p>
        {data.accountName && (
          <p className="text-xs text-gray-400 truncate mt-0.5">{data.accountName}</p>
        )}
      </div>
      <Handle type="source" position={Position.Right} className="!bg-gray-400 !w-2.5 !h-2.5 !border-2 !border-white" />
    </div>
  );
}
