"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";

const LIVE_URL = "/api/voice-copilot/live";
const POLL_INTERVAL = 5000;

interface CallRow {
  callSid: string;
  conversationId: string;
  agentId: string;
  state: string;
  durationMs: number;
  lastTranscriptLatencyMs: number;
  reconnectCount?: number;
  framesReceived?: number;
  framesDropped?: number;
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function HealthDot({ row }: { row: CallRow }) {
  const { lastTranscriptLatencyMs, state } = row;
  let color: string;
  if (lastTranscriptLatencyMs <= 500 && state === "active") {
    color = "bg-green-500";
  } else if (lastTranscriptLatencyMs <= 1500) {
    color = "bg-yellow-400";
  } else {
    color = "bg-red-500";
  }
  return (
    <span
      className={`inline-block h-2.5 w-2.5 rounded-full ${color}`}
      title={`${lastTranscriptLatencyMs}ms`}
    />
  );
}

export function LiveMonitoringPanel() {
  const { token } = useAuth();
  const { t } = useI18n();

  const [rows, setRows] = useState<CallRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;

    function fetchLive() {
      fetch(LIVE_URL, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then((data) => {
          setRows(data?.data ?? []);
          setError(null);
        })
        .catch(() => setError(t("settings.voiceCopilot.errors.loadFailed")))
        .finally(() => setLoading(false));
    }

    fetchLive();
    const id = setInterval(fetchLive, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [token]);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-gray-700">
          {t("settings.voiceCopilot.live.title")}
        </h2>
        <span className="text-xs text-gray-400">
          {t("settings.voiceCopilot.live.refreshingEvery")}
        </span>
      </div>

      {error && (
        <div className="mb-3 px-4 py-2 text-sm bg-red-50 border border-red-200 text-red-700 rounded-lg">
          {error}
        </div>
      )}

      {loading && rows.length === 0 ? (
        <div className="text-sm text-gray-500 py-8 text-center">
          {t("app.loading")}
        </div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-gray-500 py-8 text-center bg-gray-50 rounded-xl border border-gray-100">
          {t("settings.voiceCopilot.live.empty")}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-100">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
              <tr>
                <th className="px-4 py-2 text-left font-medium">
                  {t("settings.voiceCopilot.live.columns.callSid")}
                </th>
                <th className="px-4 py-2 text-left font-medium">
                  {t("settings.voiceCopilot.live.columns.conversationId")}
                </th>
                <th className="px-4 py-2 text-left font-medium">
                  {t("settings.voiceCopilot.live.columns.agent")}
                </th>
                <th className="px-4 py-2 text-left font-medium">
                  {t("settings.voiceCopilot.live.columns.duration")}
                </th>
                <th className="px-4 py-2 text-left font-medium">
                  {t("settings.voiceCopilot.live.columns.latency")}
                </th>
                <th className="px-4 py-2 text-left font-medium">
                  {t("settings.voiceCopilot.live.columns.health")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 bg-white">
              {rows.map((row) => (
                <tr key={row.callSid} className="hover:bg-gray-50 transition">
                  <td className="px-4 py-2 font-mono text-xs text-gray-700">
                    {row.callSid}
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-600">
                    {row.conversationId}
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-600">
                    {row.agentId}
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-600">
                    {formatDuration(row.durationMs)}
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-600">
                    {row.lastTranscriptLatencyMs}ms
                  </td>
                  <td className="px-4 py-2">
                    <HealthDot row={row} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
