"use client";

import { Handle, Position, NodeProps } from "reactflow";

const CHANNEL_COLORS: Record<string, { border: string; bg: string; text: string; dot: string; gradient: string; glow: string }> = {
  whatsapp:  { border: "border-green-300",  bg: "bg-green-50",  text: "text-green-600",  dot: "bg-green-500",  gradient: "from-[#25D366] to-[#128C7E]", glow: "shadow-green-200/60" },
  instagram: { border: "border-pink-300",   bg: "bg-pink-50",   text: "text-pink-600",   dot: "bg-pink-500",   gradient: "from-[#F58529] via-[#DD2A7B] to-[#8134AF]", glow: "shadow-pink-200/60" },
  facebook:  { border: "border-blue-300",   bg: "bg-blue-50",   text: "text-blue-600",   dot: "bg-blue-500",   gradient: "from-[#0078FF] to-[#0055DE]", glow: "shadow-blue-200/60" },
  messenger: { border: "border-blue-300",   bg: "bg-blue-50",   text: "text-blue-600",   dot: "bg-blue-500",   gradient: "from-[#0078FF] to-[#0055DE]", glow: "shadow-blue-200/60" },
  email:     { border: "border-amber-300",  bg: "bg-amber-50",  text: "text-amber-600",  dot: "bg-amber-500",  gradient: "from-[#EA4335] to-[#FBBC05]", glow: "shadow-amber-200/60" },
  gmail:     { border: "border-red-300",    bg: "bg-red-50",    text: "text-red-600",    dot: "bg-red-500",    gradient: "from-[#EA4335] to-[#D93025]", glow: "shadow-red-200/60" },
  sms:       { border: "border-teal-300",   bg: "bg-teal-50",   text: "text-teal-600",   dot: "bg-teal-500",   gradient: "from-[#2DD4BF] to-[#0D9488]", glow: "shadow-teal-200/60" },
  webchat:   { border: "border-violet-300", bg: "bg-violet-50", text: "text-violet-600", dot: "bg-violet-500", gradient: "from-[#8B5CF6] to-[#6D28D9]", glow: "shadow-violet-200/60" },
};

const CHANNEL_ICONS: Record<string, React.ReactNode> = {
  whatsapp: (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
    </svg>
  ),
  instagram: (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z" />
    </svg>
  ),
  facebook: (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2C6.477 2 2 6.477 2 12c0 4.991 3.657 9.128 8.438 9.879V14.89h-2.54V12h2.54V9.797c0-2.506 1.492-3.89 3.777-3.89 1.094 0 2.238.195 2.238.195v2.46h-1.26c-1.243 0-1.63.771-1.63 1.562V12h2.773l-.443 2.89h-2.33v6.989C18.343 21.129 22 16.99 22 12c0-5.523-4.477-10-10-10z" />
    </svg>
  ),
  messenger: (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2C6.36 2 2 6.13 2 11.7c0 2.91 1.2 5.42 3.15 7.18.16.15.26.36.27.58l.05 1.82c.02.58.62.96 1.15.73l2.03-.9c.17-.08.37-.1.55-.06.95.26 1.97.4 3.03.4C17.64 21.45 22 17.32 22 11.75 22 6.13 17.64 2 12 2zm5.85 7.58l-2.84 4.51c-.45.72-1.42.9-2.09.38l-2.26-1.7a.6.6 0 00-.72 0l-3.05 2.31c-.41.31-.94-.19-.67-.63l2.84-4.51c.45-.72 1.42-.9 2.09-.38l2.26 1.7a.6.6 0 00.72 0l3.05-2.31c.41-.31.94.19.67.63z" />
    </svg>
  ),
  email: (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
    </svg>
  ),
  gmail: (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
      <path d="M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 010 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z" />
    </svg>
  ),
  sms: (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 9.75a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
    </svg>
  ),
  webchat: (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 01-.825-.242m9.345-8.334a2.126 2.126 0 00-.476-.095 48.64 48.64 0 00-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0011.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155" />
    </svg>
  ),
};

const PLATFORM_NAMES: Record<string, string> = {
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  facebook: "Facebook Messenger",
  messenger: "Messenger",
  email: "Email",
  gmail: "Gmail",
  sms: "SMS",
  webchat: "Webchat",
};

function getChannelIcon(type: string) {
  return CHANNEL_ICONS[type] || (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.288 15.038a5.25 5.25 0 017.424 0M5.106 11.856c3.807-3.808 9.98-3.808 13.788 0M1.924 8.674c5.565-5.565 14.587-5.565 20.152 0M12.53 18.22l-.53.53-.53-.53a.75.75 0 011.06 0z" />
    </svg>
  );
}

export function ChannelEntryNode({ data }: NodeProps) {
  const channelType = (data.channelType || "webchat").toLowerCase();
  const colors = CHANNEL_COLORS[channelType] || CHANNEL_COLORS.webchat;
  const platformName = data.platformName || PLATFORM_NAMES[channelType] || channelType;

  return (
    <div className={`bg-white rounded-2xl shadow-lg ${colors.glow} border-2 ${colors.border} min-w-[220px] max-w-[260px] transition-all hover:shadow-xl hover:scale-[1.02]`}>
      {/* Gradient header with large icon */}
      <div className={`bg-gradient-to-r ${colors.gradient} text-white px-4 py-3 rounded-t-[14px] flex items-center gap-3`}>
        <div className="w-9 h-9 rounded-xl bg-white/20 backdrop-blur-sm flex items-center justify-center shadow-inner">
          {getChannelIcon(channelType)}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold leading-tight">{platformName}</p>
          <p className="text-[10px] text-white/70 font-medium">Entry Point</p>
        </div>
      </div>

      {/* Body */}
      <div className="px-4 py-3">
        <p className="text-sm font-semibold text-gray-900 truncate">{data.label || "Unnamed Channel"}</p>
        {data.accountName && data.accountName !== data.label && (
          <p className="text-xs text-gray-400 truncate mt-0.5">{data.accountName}</p>
        )}

        {/* Status pill */}
        <div className="mt-2.5 flex items-center gap-2">
          <div className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold ${
            data.connected
              ? `${colors.bg} ${colors.text}`
              : "bg-gray-100 text-gray-400"
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${data.connected ? colors.dot : "bg-gray-300"} ${data.connected ? "animate-pulse" : ""}`} />
            {data.connected ? "Connected" : "Disconnected"}
          </div>
        </div>
      </div>

      {/* Source handle */}
      <Handle
        type="source"
        position={Position.Right}
        className={`!w-3.5 !h-3.5 !border-[3px] !border-white !shadow-md ${colors.dot.replace("bg-", "!bg-")}`}
      />
    </div>
  );
}
