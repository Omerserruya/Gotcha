"use client";

import { useState, useRef, useEffect } from "react";

const CHANNEL_META: Record<string, { icon: string; color: string; label: string }> = {
  WHATSAPP:  { icon: "/icons/wa.png",  color: "#25D366", label: "WhatsApp" },
  INSTAGRAM: { icon: "/icons/ins.png", color: "#E1306C", label: "Instagram" },
  MESSENGER: { icon: "/icons/msn.png", color: "#0084FF", label: "Messenger" },
  GMAIL:     { icon: "/icons/gm.png",  color: "#EA4335", label: "Gmail" },
  OUTLOOK:   { icon: "/icons/ol.png",  color: "#0078D4", label: "Outlook" },
  SLACK:     { icon: "/icons/slk.png", color: "#4A154B", label: "Slack" },
  EMAIL:     { icon: "/icons/gm.png",  color: "#6B7280", label: "Email" },
};

interface ChannelAccount {
  id: string;
  channel: string;
  displayName: string;
  externalId?: string;
}

interface ChannelAccountPickerProps {
  accounts: ChannelAccount[];
  value: string;
  onChange: (accountId: string, channel: string) => void;
  placeholder?: string;
}

export default function ChannelAccountPicker({ accounts, value, onChange, placeholder = "Select channel" }: ChannelAccountPickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = accounts.find((a) => a.id === value);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  function getMeta(channel: string) {
    return CHANNEL_META[channel] || { icon: "", color: "#6B7280", label: channel };
  }

  return (
    <div ref={ref} className="relative">
      {/* Trigger */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-3 px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition hover:border-gray-300"
      >
        {selected ? (
          <>
            <span
              className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
              style={{ backgroundColor: `${getMeta(selected.channel).color}12` }}
            >
              <img src={getMeta(selected.channel).icon} alt="" className="w-5 h-5" />
            </span>
            <div className="flex-1 text-start min-w-0">
              <span className="font-medium text-gray-900 block truncate">{selected.displayName}</span>
              <span className="text-xs text-gray-400">{getMeta(selected.channel).label}{selected.externalId ? ` · ${selected.externalId}` : ""}</span>
            </div>
            <svg className="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
            </svg>
          </>
        ) : (
          <>
            <span className="w-8 h-8 rounded-lg bg-gray-100 flex items-center justify-center flex-shrink-0">
              <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z" />
              </svg>
            </span>
            <span className="flex-1 text-start text-gray-400">{placeholder}</span>
            <svg className="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
            </svg>
          </>
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute z-50 mt-1.5 w-full bg-white rounded-xl border border-gray-200 shadow-lg overflow-hidden animate-in fade-in zoom-in-95 duration-150">
          {accounts.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-gray-400">No connected channels</div>
          ) : (
            <div className="max-h-64 overflow-y-auto py-1">
              {accounts.map((ca) => {
                const meta = getMeta(ca.channel);
                const isSelected = ca.id === value;
                return (
                  <button
                    key={ca.id}
                    type="button"
                    onClick={() => { onChange(ca.id, ca.channel); setOpen(false); }}
                    className={`w-full flex items-center gap-3 px-4 py-2.5 text-start transition hover:bg-gray-50 ${isSelected ? "bg-primary-50/50" : ""}`}
                  >
                    <span
                      className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                      style={{ backgroundColor: `${meta.color}15`, border: `1px solid ${meta.color}25` }}
                    >
                      <img src={meta.icon} alt="" className="w-5 h-5" />
                    </span>
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium text-gray-900 block truncate">{ca.displayName}</span>
                      <span className="text-xs text-gray-400">{meta.label}{ca.externalId ? ` · ${ca.externalId}` : ""}</span>
                    </div>
                    {isSelected && (
                      <svg className="w-4 h-4 text-primary-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                      </svg>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
