"use client";

import { usePathname } from "next/navigation";
import { useVoiceCall } from "@/context/VoiceCallContext";

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function ActiveCallWidget() {
  const pathname = usePathname();
  const { state, call, elapsedMs, error, hangup } = useVoiceCall();

  if (state === "idle") return null;
  // The /outbound/call page shows its own full phone UI — don't double up.
  if (pathname === "/outbound/call") return null;

  const label = {
    connecting: "Connecting…",
    ringing: "Ringing…",
    active: formatDuration(elapsedMs),
    ended: "Call ended",
    error: error || "Call failed",
  }[state];

  const dotColor = {
    connecting: "bg-amber-400",
    ringing: "bg-amber-400",
    active: "bg-emerald-500",
    ended: "bg-gray-400",
    error: "bg-red-500",
  }[state];

  return (
    <div className="fixed bottom-4 right-4 z-50 bg-white shadow-2xl border border-gray-200 rounded-xl px-4 py-3 flex items-center gap-3 min-w-[260px]">
      <div className="flex items-center gap-2">
        <span className={`inline-block w-2.5 h-2.5 rounded-full ${dotColor} ${state === "active" ? "animate-pulse" : ""}`} />
        <div className="flex flex-col">
          <span className="text-xs text-gray-500">{call?.contactName || "Outbound call"}</span>
          <span className="text-sm font-medium text-gray-900 tabular-nums">
            {call?.to && <span className="mr-2 text-gray-700">{call.to}</span>}
            {label}
          </span>
        </div>
      </div>
      {(state === "connecting" || state === "ringing" || state === "active") && (
        <button
          type="button"
          onClick={hangup}
          className="ml-auto px-3 py-1.5 text-sm font-semibold text-white bg-red-600 hover:bg-red-700 rounded-md"
        >
          Hang up
        </button>
      )}
    </div>
  );
}
