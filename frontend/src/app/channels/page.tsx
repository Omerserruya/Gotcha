"use client";

import { useState, useEffect, useCallback, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import {
  getChannels,
  connectWhatsApp,
  disconnectChannel,
  getChannelStatus,
  getChannelConfig,
  updateChannelConfig,
} from "@/lib/api";
import { AppLayout } from "@/components/AppLayout";
import { ChannelBadge } from "@/components/conversations/ChannelBadge";
import clsx from "clsx";
import ConfirmModal from "@/components/ConfirmModal";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";
const META_APP_ID = process.env.NEXT_PUBLIC_META_APP_ID || "";
const EMBEDDED_SIGNUP_CONFIG_ID = process.env.NEXT_PUBLIC_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID || "";

// ─── Status Badge Component ──────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const { t } = useI18n();
  const config: Record<string, { bg: string; text: string; ring: string; label: string }> = {
    CONNECTED: { bg: "bg-green-50", text: "text-green-600", ring: "ring-green-200", label: t("channels.statusConnected") },
    ERROR: { bg: "bg-red-50", text: "text-red-600", ring: "ring-red-200", label: t("channels.statusError") },
    DISCONNECTED: { bg: "bg-gray-100", text: "text-gray-500", ring: "ring-gray-200", label: t("channels.statusDisconnected") },
    PENDING: { bg: "bg-yellow-50", text: "text-yellow-600", ring: "ring-yellow-200", label: t("channels.statusPending") },
  };
  const c = config[status] || config.DISCONNECTED;
  return (
    <span className={clsx("text-[10px] px-2 py-0.5 rounded-full font-medium ring-1", c.bg, c.text, c.ring)}>
      {c.label}
    </span>
  );
}

// ─── Platform Connect Card ───────────────────────────────────

function ConnectCard({
  icon,
  title,
  description,
  buttonLabel,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  buttonLabel: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-5 flex flex-col items-center text-center gap-3">
      <div className="w-12 h-12 rounded-xl bg-gray-50 flex items-center justify-center">
        {icon}
      </div>
      <div>
        <h3 className="font-semibold text-sm text-gray-900">{title}</h3>
        <p className="text-xs text-gray-500 mt-0.5">{description}</p>
      </div>
      <button
        onClick={onClick}
        disabled={disabled}
        className="text-xs px-4 py-2 bg-primary-500 text-white rounded-lg hover:bg-primary-600 transition font-medium disabled:opacity-40 w-full"
      >
        {buttonLabel}
      </button>
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────

export default function ChannelsPage() {
  return (
    <Suspense fallback={<AppLayout><div className="flex items-center justify-center h-full"><div className="w-6 h-6 border-2 border-primary-200 border-t-primary-500 rounded-full animate-spin" /></div></AppLayout>}>
      <ChannelsPageContent />
    </Suspense>
  );
}

function ChannelsPageContent() {
  const { token, user } = useAuth();
  const { t } = useI18n();
  const searchParams = useSearchParams();

  const [accounts, setAccounts] = useState<any[]>([]);
  const [botFlowMode, setBotFlowMode] = useState<string>("UNIFIED");
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error">("success");
  const [disconnectConfirm, setDisconnectConfirm] = useState<{ open: boolean; id: string }>({ open: false, id: "" });
  const [disconnecting, setDisconnecting] = useState(false);
  const showMessage = (msg: string, type: "success" | "error" = "success") => {
    setMessage(msg);
    setMessageType(type);
    setTimeout(() => setMessage(""), 5000);
  };

  // Session info captured from WA_EMBEDDED_SIGNUP message event
  const sessionInfoRef = useRef<{ wabaId?: string; phoneNumberId?: string }>({});

  const fetchData = useCallback(async () => {
    if (!token) return;
    try {
      const [channelsRes, configRes] = await Promise.all([
        getChannels(token),
        getChannelConfig(token),
      ]);
      setAccounts(channelsRes.data || []);
      setBotFlowMode(configRes.data?.botFlowMode || "UNIFIED");
    } catch (err) {
      console.error("Failed to load channel data:", err);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // ─── Load Facebook JS SDK ────────────────────────────────
  useEffect(() => {
    if (document.getElementById("facebook-jssdk")) return;
    (window as any).fbAsyncInit = function () {
      (window as any).FB.init({
        appId: META_APP_ID,
        autoLogAppEvents: true,
        xfbml: true,
        version: "v25.0",
      });
    };
    const script = document.createElement("script");
    script.id = "facebook-jssdk";
    script.src = "https://connect.facebook.net/en_US/sdk.js";
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";
    document.body.appendChild(script);
  }, []);

  // ─── WA_EMBEDDED_SIGNUP session info listener ────────────
  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (!event.origin.endsWith("facebook.com")) return;
      try {
        const data = JSON.parse(event.data);
        if (data.type === "WA_EMBEDDED_SIGNUP") {
          console.log("[WA-EMBEDDED] Session info event:", data);
          if (data.event === "FINISH" || data.event === "FINISH_ONLY_WABA" || data.event === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING") {
            sessionInfoRef.current = {
              wabaId: data.data?.waba_id,
              phoneNumberId: data.data?.phone_number_id,
            };
          } else if (data.event === "CANCEL") {
            console.log("[WA-EMBEDDED] User cancelled at step:", data.data?.current_step);
          }
        }
      } catch {
        // Non-JSON message from Facebook, ignore
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  // Handle OAuth redirect results (Messenger / Instagram)
  useEffect(() => {
    const connected = searchParams.get("connected");
    const error = searchParams.get("error");

    if (connected) {
      showMessage(t("channels.connected"), "success");
      fetchData();
      window.history.replaceState({}, "", "/channels");
    } else if (error) {
      const errorMessages: Record<string, string> = {
        access_denied: t("channels.connectionFailed"),
        no_pages: t("channels.noPages"),
        no_instagram_account: t("channels.noInstagram"),
        invalid_state: t("channels.invalidState"),
        missing_params: t("channels.connectionFailed"),
        connection_failed: t("channels.connectionFailed"),
      };
      showMessage(errorMessages[error] || t("channels.connectionFailed"), "error");
      window.history.replaceState({}, "", "/channels");
    }
  }, [searchParams]);

  // ─── WhatsApp Embedded Signup ─────────────────────────────
  // Uses FB.login with config_id to trigger the Embedded Signup wizard.
  // 1. FB.login opens a popup managed by the Facebook SDK
  // 2. WA_EMBEDDED_SIGNUP message event fires with waba_id (captured by our listener)
  // 3. FB.login callback returns the code directly
  // 4. We send code + session info to our backend for token exchange
  function handleConnectWhatsApp() {
    if (!token) return;

    const FB = (window as any).FB;
    if (!FB) {
      showMessage("Facebook SDK not loaded. Please refresh the page.", "error");
      return;
    }

    sessionInfoRef.current = {};
    setConnecting(true);

    FB.login(
      (response: any) => {
        if (!response.authResponse?.code) {
          setConnecting(false);
          return;
        }

        const code = response.authResponse.code;

        // Brief delay to allow WA_EMBEDDED_SIGNUP postMessage to arrive with session info
        setTimeout(() => {
          const sessionInfo = sessionInfoRef.current;
          console.log("[WA-CONNECT] FB.login code received. Session info:", sessionInfo);

          connectWhatsApp(token, code, sessionInfo)
            .then(() => {
              showMessage(t("channels.connected"), "success");
              fetchData();
            })
            .catch((err: any) => {
              showMessage(err.message || t("channels.connectionFailed"), "error");
            })
            .finally(() => {
              setConnecting(false);
            });
        }, 500);
      },
      {
        config_id: EMBEDDED_SIGNUP_CONFIG_ID,
        response_type: "code",
        override_default_response_type: true,
        extras: {
          setup: { channel: "WHATSAPP" },
          sessionInfoVersion: "3",
        },
      }
    );
  }

  // ─── OAuth Redirect (Messenger / Instagram) ─────────────

  function handleOAuthConnect(platform: "messenger" | "instagram") {
    if (!token) return;
    window.location.href = `${API_URL}/api/channels/oauth/init?platform=${platform}&token=${token}`;
  }

  // ─── Disconnect ─────────────────────────────────────────

  function openDisconnectConfirm(id: string) {
    setDisconnectConfirm({ open: true, id });
  }

  async function confirmDisconnect() {
    if (!token) return;
    setDisconnecting(true);
    try {
      await disconnectChannel(token, disconnectConfirm.id);
      setDisconnectConfirm({ open: false, id: "" });
      showMessage(t("channels.disconnected"), "success");
      fetchData();
    } catch (err: any) {
      showMessage(err.message || t("common.error"), "error");
    } finally {
      setDisconnecting(false);
    }
  }

  // ─── Health Check ───────────────────────────────────────

  async function handleCheckStatus(id: string) {
    if (!token) return;
    try {
      await getChannelStatus(token, id);
      fetchData();
    } catch (err: any) {
      showMessage(err.message || t("common.error"), "error");
    }
  }

  // ─── Bot Flow Mode ─────────────────────────────────────

  async function handleModeChange(mode: string) {
    if (!token) return;
    setBotFlowMode(mode);
    try {
      await updateChannelConfig(token, { botFlowMode: mode });
      showMessage(t("channels.saved"), "success");
    } catch (err: any) {
      showMessage(err.message || t("common.error"), "error");
    }
  }

  if (user?.role !== "ADMIN") {
    return (
      <AppLayout>
        <div className="flex items-center justify-center h-full">
          <p className="text-gray-400">Admin access required</p>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
    <div className="max-w-4xl mx-auto p-6 space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{t("channels.title")}</h1>
        <p className="text-sm text-gray-500 mt-1">{t("channels.subtitle")}</p>
      </div>

      {/* Toast message */}
      {message && (
        <div className={clsx(
          "text-sm px-4 py-2.5 rounded-xl border",
          messageType === "success"
            ? "bg-green-50 text-green-700 border-green-200"
            : "bg-red-50 text-red-700 border-red-200"
        )}>
          {message}
        </div>
      )}

      {/* Connect Channel Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <ConnectCard
          icon={
            <svg className="w-6 h-6 text-green-500" viewBox="0 0 24 24" fill="currentColor">
              <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
            </svg>
          }
          title={t("channels.whatsapp")}
          description={t("channels.whatsappDesc")}
          buttonLabel={t("channels.connectWhatsapp")}
          onClick={handleConnectWhatsApp}
          disabled={connecting}
        />

        <ConnectCard
          icon={
            <svg className="w-6 h-6 text-blue-500" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2.04c-5.5 0-10 4.49-10 10.02 0 5 3.66 9.15 8.44 9.9v-7H7.9v-2.9h2.54V9.85c0-2.52 1.49-3.93 3.78-3.93 1.09 0 2.23.19 2.23.19v2.47h-1.26c-1.24 0-1.63.77-1.63 1.56v1.88h2.78l-.45 2.9h-2.33v7a10 10 0 008.44-9.9c0-5.53-4.5-10.02-10-10.02z"/>
            </svg>
          }
          title={t("channels.messenger")}
          description={t("channels.messengerDesc")}
          buttonLabel={t("channels.connectMessenger")}
          onClick={() => handleOAuthConnect("messenger")}
        />

        <ConnectCard
          icon={
            <svg className="w-6 h-6 text-pink-500" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z"/>
            </svg>
          }
          title={t("channels.instagram")}
          description={t("channels.instagramDesc")}
          buttonLabel={t("channels.connectInstagram")}
          onClick={() => handleOAuthConnect("instagram")}
        />
      </div>

      {/* Connected Channels List */}
      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <h2 className="font-semibold text-gray-900 mb-4">{t("channels.connectedChannels")}</h2>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="w-6 h-6 border-2 border-primary-200 border-t-primary-500 rounded-full animate-spin" />
          </div>
        ) : accounts.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-sm text-gray-400">{t("channels.noChannels")}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {accounts.map((account) => (
              <div
                key={account.id}
                className="flex items-center gap-4 p-4 rounded-xl border border-gray-100 hover:bg-gray-50 transition"
              >
                <ChannelBadge channel={account.channel} size="md" showLabel />
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm text-gray-900">{account.displayName}</p>
                  <p className="text-xs text-gray-400">{account.externalId}</p>
                  {account.lastError && account.connectionStatus === "ERROR" && (
                    <p className="text-xs text-red-500 mt-0.5">{account.lastError}</p>
                  )}
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  {account._count?.conversations > 0 && (
                    <span className="text-[10px] bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">
                      {account._count.conversations} {t("channels.activeConversations").toLowerCase()}
                    </span>
                  )}
                  <StatusBadge status={account.connectionStatus || "CONNECTED"} />

                  {/* Check Status button */}
                  {account.connectionStatus === "CONNECTED" && (
                    <button
                      onClick={() => handleCheckStatus(account.id)}
                      className="text-xs text-gray-400 hover:text-gray-600 transition p-1"
                      title={t("channels.checkStatus")}
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                    </button>
                  )}

                  {/* Disconnect / Reconnect button */}
                  {account.connectionStatus === "CONNECTED" || account.connectionStatus === "ERROR" ? (
                    <button
                      onClick={() => openDisconnectConfirm(account.id)}
                      className="text-xs text-red-500 hover:text-red-700 transition p-1"
                      title={t("channels.disconnect")}
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                      </svg>
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Bot Flow Mode */}
      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <h2 className="font-semibold text-gray-900 mb-1">{t("channels.botFlowMode")}</h2>
        <p className="text-xs text-gray-500 mb-4">{t("channels.botFlowModeDesc")}</p>
        <div className="flex gap-3">
          {[
            { value: "UNIFIED", label: t("channels.unified"), desc: t("channels.unifiedDesc") },
            { value: "PER_CHANNEL", label: t("channels.perChannel"), desc: t("channels.perChannelDesc") },
          ].map((opt) => (
            <button
              key={opt.value}
              onClick={() => handleModeChange(opt.value)}
              className={clsx(
                "flex-1 p-4 rounded-xl border-2 text-start transition",
                botFlowMode === opt.value
                  ? "border-primary-500 bg-primary-50"
                  : "border-gray-200 hover:border-gray-300"
              )}
            >
              <p className={clsx(
                "font-medium text-sm",
                botFlowMode === opt.value ? "text-primary-700" : "text-gray-700"
              )}>
                {opt.label}
              </p>
              <p className="text-xs text-gray-500 mt-0.5">{opt.desc}</p>
            </button>
          ))}
        </div>
      </div>
    </div>

    <ConfirmModal
      isOpen={disconnectConfirm.open}
      title={t("confirm.disconnectTitle")}
      message={t("confirm.disconnectChannelMsg")}
      confirmText={t("common.disconnect")}
      danger
      loading={disconnecting}
      onConfirm={confirmDisconnect}
      onCancel={() => setDisconnectConfirm({ open: false, id: "" })}
    />
    </AppLayout>
  );
}
