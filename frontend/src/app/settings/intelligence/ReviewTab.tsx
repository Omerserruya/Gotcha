"use client";

import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import {
  listIntelligenceReviews,
  approveIntelligenceReview,
  rejectIntelligenceReview,
  type IntelligenceReview,
} from "@/lib/gotcha-api";

function reasonLabel(reason: string, he: boolean): string {
  if (reason === "low_confidence") return he ? "ביטחון נמוך" : "Low confidence";
  if (reason === "conflict") return he ? "ערך מתנגש" : "Conflicting value";
  return reason;
}

function formatValue(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

export default function ReviewTab() {
  const { token } = useAuth();
  const { locale } = useI18n();
  const he = locale === "he";

  const [reviews, setReviews] = useState<IntelligenceReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2000);
  }, []);

  const reload = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const res = await listIntelligenceReviews(token);
      setReviews((res.reviews ?? []).filter((r) => r.status === "PENDING" || r.status === "pending"));
    } catch (e: any) {
      setError(e?.message ?? "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    reload();
  }, [reload]);

  async function handleApprove(id: string) {
    if (!token) return;
    setBusyId(id);
    try {
      await approveIntelligenceReview(token, id);
      setReviews((prev) => prev.filter((r) => r.id !== id));
      flash(he ? "אושר" : "Approved");
    } catch (e: any) {
      setError(e?.message ?? "Approve failed");
    } finally {
      setBusyId(null);
    }
  }

  async function handleReject(id: string) {
    if (!token) return;
    setBusyId(id);
    try {
      await rejectIntelligenceReview(token, id);
      setReviews((prev) => prev.filter((r) => r.id !== id));
      flash(he ? "נדחה" : "Rejected");
    } catch (e: any) {
      setError(e?.message ?? "Reject failed");
    } finally {
      setBusyId(null);
    }
  }

  if (!token) return null;

  return (
    <div>
      <p className="text-xs text-gray-500 mb-4 max-w-4xl">
        {he
          ? "ערכים שה-AI חילץ וזקוקים לאישור לפני שמירה — ביטחון נמוך או התנגשות עם ערך קיים."
          : "AI-extracted values that need human review before being saved — low confidence or conflict with existing data."}
      </p>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2 rounded-lg mb-4 max-w-4xl">
          {error}
        </div>
      )}
      {toast && (
        <div className="bg-green-50 border border-green-200 text-green-700 text-sm px-4 py-2 rounded-lg mb-4 max-w-4xl">
          {toast}
        </div>
      )}

      {loading ? (
        <div className="bg-white rounded-xl shadow-subtle p-6 text-sm text-gray-500 max-w-4xl">
          {he ? "טוען…" : "Loading…"}
        </div>
      ) : reviews.length === 0 ? (
        <div className="bg-white rounded-xl shadow-subtle p-10 text-center text-sm text-gray-400 max-w-4xl">
          {he ? "אין סקירות ממתינות." : "No pending reviews."}
        </div>
      ) : (
        <div className="space-y-3 max-w-4xl">
          {reviews.map((r) => {
            const isBusy = busyId === r.id;
            return (
              <div key={r.id} className="bg-white rounded-xl shadow-subtle p-5 flex flex-col gap-3">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0 space-y-1.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-gray-900 font-mono">{r.fieldKey}</span>
                      <span className="text-[10px] px-2 py-0.5 rounded-full border bg-amber-50 text-amber-700 border-amber-200">
                        {reasonLabel(r.reason, he)}
                      </span>
                      <span className="text-[10px] text-gray-400">
                        {he ? "ביטחון:" : "Confidence:"}{" "}
                        <span className={clsx(
                          "font-medium",
                          r.confidence >= 0.7 ? "text-green-600" : r.confidence >= 0.5 ? "text-amber-600" : "text-red-600",
                        )}>
                          {Math.round(r.confidence * 100)}%
                        </span>
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-3 text-xs">
                      <div>
                        <div className="text-gray-400 mb-0.5">{he ? "ערך מוצע" : "Proposed value"}</div>
                        <div className="font-medium text-gray-900 bg-gray-50 rounded px-2 py-1 font-mono">
                          {formatValue(r.proposedValue)}
                        </div>
                      </div>
                      {r.currentValue != null && (
                        <div>
                          <div className="text-gray-400 mb-0.5">{he ? "ערך נוכחי" : "Current value"}</div>
                          <div className="font-medium text-gray-700 bg-gray-50 rounded px-2 py-1 font-mono">
                            {formatValue(r.currentValue)}
                          </div>
                        </div>
                      )}
                    </div>

                    {r.evidence && (
                      <blockquote className="border-l-2 border-gray-300 pl-3 text-xs text-gray-500 italic">
                        "{r.evidence}"
                      </blockquote>
                    )}

                    <div className="text-[10px] text-gray-400">
                      {r.entityType} · {he ? "ישות:" : "Entity:"} {r.entityId.slice(0, 12)}…
                      {r.conversationId && ` · ${he ? "שיחה:" : "Conv:"} ${r.conversationId.slice(0, 8)}…`}
                    </div>
                  </div>

                  <div className="flex flex-col gap-2 shrink-0">
                    <button
                      onClick={() => handleApprove(r.id)}
                      disabled={isBusy}
                      className={clsx(
                        "px-4 py-1.5 rounded-lg text-sm font-medium transition",
                        isBusy
                          ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                          : "bg-green-600 text-white hover:bg-green-700",
                      )}
                    >
                      {he ? "אישור" : "Approve"}
                    </button>
                    <button
                      onClick={() => handleReject(r.id)}
                      disabled={isBusy}
                      className={clsx(
                        "px-4 py-1.5 rounded-lg text-sm font-medium transition",
                        isBusy
                          ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                          : "bg-gray-200 text-gray-700 hover:bg-gray-300",
                      )}
                    >
                      {he ? "דחייה" : "Reject"}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
