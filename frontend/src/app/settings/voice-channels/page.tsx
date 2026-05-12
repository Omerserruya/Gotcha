"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { useVoiceFlags } from "@/lib/use-voice-flags";
import {
  listVoiceChannels,
  type VoiceChannel,
  type VoiceChannelAuthType,
  type VoiceChannelStatus,
} from "@/lib/api";
import { playRingtone } from "@/components/voice/IncomingCallBanner";
import clsx from "clsx";

const SOUND_KEY = "gotcha.incomingCallSound";

const STATUS_CLASS: Record<VoiceChannelStatus, string> = {
  PENDING: "bg-amber-50 text-amber-700 ring-amber-200",
  ACTIVE: "bg-green-50 text-green-700 ring-green-200",
  DISABLED: "bg-gray-100 text-gray-600 ring-gray-200",
  ERROR: "bg-red-50 text-red-700 ring-red-200",
};

export default function VoiceChannelsListPage() {
  const { token, user } = useAuth();
  const { t } = useI18n();
  const router = useRouter();
  const searchParams = useSearchParams();
  const flags = useVoiceFlags();

  const STATUS_LABEL: Record<VoiceChannelStatus, string> = {
    PENDING: t("settings.voiceChannels.statusPending"),
    ACTIVE: t("settings.voiceChannels.statusActive"),
    DISABLED: t("settings.voiceChannels.statusDisabled"),
    ERROR: t("settings.voiceChannels.statusError"),
  };

  const AUTH_LABEL: Record<VoiceChannelAuthType, string> = {
    BYO: t("settings.voiceChannels.authBYO"),
  };

  const onboardedId = searchParams.get("onboarded");

  const [channels, setChannels] = useState<VoiceChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [soundEnabled, setSoundEnabled] = useState(true);

  // Read sound pref from localStorage on mount
  useEffect(() => {
    if (typeof window !== "undefined") {
      setSoundEnabled(localStorage.getItem(SOUND_KEY) !== "off");
    }
  }, []);

  function handleSoundToggle(checked: boolean) {
    setSoundEnabled(checked);
    localStorage.setItem(SOUND_KEY, checked ? "on" : "off");
  }

  function handleTestSound() {
    const stop = playRingtone();
    // Play one pattern cycle (2 s) then stop
    setTimeout(stop, 2000);
  }

  const reload = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await listVoiceChannels(token);
      setChannels(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "load_failed");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    reload();
  }, [reload]);

  // After Twilio OAuth callback: show toast, auto-open the new channel.
  useEffect(() => {
    if (!onboardedId || loading) return;
    if (!channels.some((c) => c.id === onboardedId)) return;
    setToast(t("settings.voiceChannels.connectedSuccess"));
    const handle = window.setTimeout(() => {
      router.push(`/settings/voice-channels/${onboardedId}`);
    }, 800);
    return () => window.clearTimeout(handle);
  }, [onboardedId, loading, channels, router]);

  const sorted = useMemo(
    () => [...channels].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    [channels],
  );

  if (user?.role !== "ADMIN") {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-gray-400 text-sm">{t("settings.voiceChannels.adminRequired")}</p>
      </div>
    );
  }

  if (flags.loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm py-16">
        {t("settings.voiceChannels.loading")}
      </div>
    );
  }

  if (!flags.voiceCopilotEnabled) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-16">
        <h1 className="text-2xl font-semibold text-gray-800 mb-2">404</h1>
        <p className="text-sm text-gray-500">{t("settings.voiceChannels.pageNotAvailable")}</p>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto p-4 md:p-6 space-y-6 overflow-y-auto h-full pb-20">
      {/* ── Ring sound toggle ── */}
      <section className="bg-white rounded-2xl ring-1 ring-gray-100 shadow-sm p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-gray-800">{t("voice.banner.soundToggle")}</p>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleTestSound}
              className="text-xs text-primary-600 hover:text-primary-700 font-medium transition-colors"
            >
              {t("voice.banner.testSound")}
            </button>
            <div
              onClick={() => handleSoundToggle(!soundEnabled)}
              className={clsx(
                "relative w-10 h-6 rounded-full transition-colors cursor-pointer shrink-0",
                soundEnabled ? "bg-primary-500" : "bg-gray-200"
              )}
              role="switch"
              aria-checked={soundEnabled}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === " " || e.key === "Enter") handleSoundToggle(!soundEnabled);
              }}
            >
              <span
                className={clsx(
                  "absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow transition-transform",
                  soundEnabled ? "translate-x-4" : "translate-x-0"
                )}
              />
            </div>
          </div>
        </div>
      </section>

      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t("settings.voiceChannels.title")}</h1>
          <p className="text-sm text-gray-500 mt-1">
            {t("settings.voiceChannels.subtitle")}
          </p>
        </div>
        <Link
          href="/settings/voice-channels/new"
          className="px-4 py-2 min-h-[40px] bg-primary-500 text-white rounded-xl hover:bg-primary-600 transition text-sm font-medium whitespace-nowrap"
        >
          {t("settings.voiceChannels.newButton")}
        </Link>
      </div>

      {toast && (
        <div className="bg-green-50 text-green-700 text-sm px-4 py-2.5 rounded-xl ring-1 ring-green-200">
          {toast}
        </div>
      )}

      {error && (
        <div className="bg-red-50 text-red-700 text-sm px-4 py-2.5 rounded-xl ring-1 ring-red-200">
          {error}
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="bg-white rounded-2xl ring-1 ring-gray-100 shadow-sm p-5 animate-pulse h-28"
            />
          ))}
        </div>
      ) : sorted.length === 0 ? (
        <div className="bg-white rounded-2xl ring-1 ring-gray-100 shadow-sm p-10 text-center">
          <div className="w-12 h-12 mx-auto rounded-2xl bg-primary-50 flex items-center justify-center mb-4">
            <svg
              className="w-6 h-6 text-primary-600"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 002.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 01-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 00-1.091-.852H4.5A2.25 2.25 0 002.25 4.5v2.25z"
              />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-gray-900 mb-1">{t("settings.voiceChannels.emptyTitle")}</h2>
          <p className="text-sm text-gray-500 max-w-md mx-auto">
            {t("settings.voiceChannels.emptyDescription")}
          </p>
          <Link
            href="/settings/voice-channels/new"
            className="mt-5 inline-block px-5 py-2.5 min-h-[44px] bg-primary-500 text-white rounded-xl hover:bg-primary-600 transition text-sm font-medium"
          >
            {t("settings.voiceChannels.startConnect")}
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {sorted.map((channel) => {
            const total = channel.numbers.length;
            const active = channel.numbers.filter((n) => n.isActive).length;
            return (
              <Link
                key={channel.id}
                href={`/settings/voice-channels/${channel.id}`}
                className="group bg-white rounded-2xl ring-1 ring-gray-100 shadow-sm p-5 hover:ring-primary-200 hover:shadow transition block text-start"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-base font-semibold text-gray-900 truncate group-hover:text-primary-700">
                      {channel.friendlyName}
                    </h3>
                    <p className="text-xs text-gray-400 mt-0.5 font-mono truncate">
                      {channel.accountSidFingerprint}
                    </p>
                  </div>
                  <span
                    className={clsx(
                      "text-[11px] font-medium px-2 py-0.5 rounded-full ring-1 whitespace-nowrap",
                      STATUS_CLASS[channel.status],
                    )}
                  >
                    {STATUS_LABEL[channel.status]}
                  </span>
                </div>

                <div className="mt-4 flex items-center justify-between gap-3 text-xs">
                  <span className="px-2 py-0.5 rounded-md bg-gray-50 text-gray-600 ring-1 ring-gray-200">
                    {AUTH_LABEL[channel.authType]}
                  </span>
                  <span className="text-gray-500">
                    <strong className="text-gray-900 font-semibold">{active}</strong>
                    <span className="mx-1">/</span>
                    <span>{total}</span>
                    <span className="ms-1">{t("settings.voiceChannels.activeNumbers")}</span>
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
