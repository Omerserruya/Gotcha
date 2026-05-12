"use client";

import { useEffect } from "react";
import clsx from "clsx";
import { useVoiceCall } from "@/context/VoiceCallContext";
import { useAuth } from "@/context/AuthContext";
import { normalizeE164, ensureDefaultCountry } from "@/lib/phone";

interface Props {
  to?: string | null;
  contactName?: string | null;
  conversationId?: string | null;
  label?: string;
}

export function VoiceCallButton({ to, contactName, conversationId, label }: Props) {
  const { placeCall, state, isReady } = useVoiceCall();
  const { token } = useAuth();
  useEffect(() => {
    ensureDefaultCountry(token);
  }, [token]);
  const isBusy = state !== "idle";
  const normalized = normalizeE164(to || "");
  const canCall = !!normalized && isReady && !isBusy;

  async function onClick() {
    if (!canCall || !normalized) return;
    try {
      await placeCall(normalized, {
        contactName: contactName ?? undefined,
        conversationId: conversationId ?? undefined,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[voice] place call failed:", err);
    }
  }

  const title = !normalized
    ? "No phone number on this contact"
    : !isReady
      ? "Voice not ready"
      : isBusy
        ? "Already on a call"
        : `Call ${normalized}`;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!canCall}
      title={title}
      className={clsx(
        "flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg font-medium transition shrink-0",
        canCall
          ? "bg-emerald-50 text-emerald-600 hover:bg-emerald-100"
          : "bg-gray-50 text-gray-400 cursor-not-allowed"
      )}
    >
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 002.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 01-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 00-1.091-.852H4.5A2.25 2.25 0 002.25 4.5v2.25z" />
      </svg>
      <span className="hidden sm:inline">{label || "Call"}</span>
    </button>
  );
}

