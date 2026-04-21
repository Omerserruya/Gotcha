"use client";

import { useState, useEffect, useCallback, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import {
  getChannels,
  connectWhatsApp,
  disconnectChannel,
  deleteChannelAccount,
  getChannelStatus,
  getWebchatSettings,
  updateWebchatSettings,
} from "@/lib/api";
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

export function ChannelsContent() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-full"><div className="w-6 h-6 border-2 border-primary-200 border-t-primary-500 rounded-full animate-spin" /></div>}>
      <ChannelsPageContent />
    </Suspense>
  );
}

function ChannelsPageContent() {
  const { token, user } = useAuth();
  const { t } = useI18n();
  const searchParams = useSearchParams();

  const [accounts, setAccounts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error">("success");
  const [disconnectConfirm, setDisconnectConfirm] = useState<{ open: boolean; id: string }>({ open: false, id: "" });
  const [disconnecting, setDisconnecting] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<{ open: boolean; id: string; name: string }>({ open: false, id: "", name: "" });
  const [deleting, setDeleting] = useState(false);
  const [embedModal, setEmbedModal] = useState<{ open: boolean; widgetId: string; code: string; apiUrl: string; accountId: string }>({ open: false, widgetId: "", code: "", apiUrl: "", accountId: "" });
  const [embedTab, setEmbedTab] = useState<"html" | "nextjs" | "react" | "vue" | "php">("html");
  const [widgetColor, setWidgetColor] = useState("#7c3aed");
  const [widgetIconUrl, setWidgetIconUrl] = useState("");
  const [widgetTitle, setWidgetTitle] = useState("Chat with us");
  const [widgetPosition, setWidgetPosition] = useState<"right" | "left">("right");
  const [savingWidget, setSavingWidget] = useState(false);
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
      const channelsRes = await getChannels(token);
      setAccounts(channelsRes.data || []);
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
          version: "v3",
        },
      }
    );
  }

  // ─── OAuth Redirect (Messenger / Instagram) ─────────────

  function handleOAuthConnect(platform: "messenger" | "instagram" | "gmail" | "outlook" | "slack") {
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

  // ─── Create Webchat Widget ───────────────────────────────

  async function handleCreateWebchat() {
    if (!token) return;
    setConnecting(true);
    try {
      const { createWebchatWidget } = await import("@/lib/api");
      const res = await createWebchatWidget(token);
      const widget = res.data;
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || window.location.origin;
      const embedCode = `<!-- ChatCenter Widget -->
<script>
(function(){
  var w=window,d=document;
  w.__chatcenter={widgetId:"${widget.externalId}",apiUrl:"${apiUrl}"};
  var s=d.createElement("script");
  s.src="${apiUrl}/widget/chatcenter-widget.js";
  s.async=true;
  d.head.appendChild(s);
})();
</script>`;
      setEmbedModal({ open: true, widgetId: widget.externalId, code: embedCode, apiUrl, accountId: widget.id });
      setEmbedTab("html");
      setWidgetColor("#7c3aed");
      setWidgetIconUrl("");
      setWidgetTitle("Chat with us");
      setWidgetPosition("right");
      showMessage(t("channels.connected"), "success");
      fetchData();
    } catch (err: any) {
      showMessage(err.message || t("channels.connectionFailed"), "error");
    } finally {
      setConnecting(false);
    }
  }

  // ─── Delete Channel ─────────────────────────────────────

  async function confirmDelete() {
    if (!token) return;
    setDeleting(true);
    try {
      await deleteChannelAccount(token, deleteConfirm.id);
      setDeleteConfirm({ open: false, id: "", name: "" });
      showMessage(t("channels.deleted"), "success");
      fetchData();
    } catch (err: any) {
      showMessage(err.message || t("common.error"), "error");
    } finally {
      setDeleting(false);
    }
  }

  if (user?.role !== "ADMIN") {
    return (
        <div className="flex items-center justify-center h-full">
          <p className="text-gray-400">Admin access required</p>
        </div>
    );
  }

  return (
    <>
    <div className="max-w-4xl mx-auto p-3 md:p-6 space-y-8">
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
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
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

        <ConnectCard
          icon={
            <svg className="w-6 h-6 text-red-500" viewBox="0 0 24 24" fill="currentColor">
              <path d="M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73l-6.546 4.91-6.546-4.91v9.273H1.636A1.636 1.636 0 010 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z"/>
            </svg>
          }
          title={t("channels.gmail")}
          description={t("channels.gmailDesc")}
          buttonLabel={t("channels.connectGmail")}
          onClick={() => handleOAuthConnect("gmail")}
        />

        <ConnectCard
          icon={
            <svg className="w-6 h-6 text-blue-600" viewBox="0 0 24 24" fill="currentColor">
              <path d="M24 7.387v10.478c0 .23-.08.424-.238.576a.806.806 0 01-.587.234h-8.327v-6.408l1.674 1.258a.39.39 0 00.494 0l.005-.004 6.98-5.282V7.387zm-11.5 7.863L.493 5.534a.39.39 0 01.005-.648l.086-.058A1.91 1.91 0 011.636 4.5h20.728c.38 0 .726.113 1.052.328l.086.058a.39.39 0 01.005.648L12.5 15.25a.78.78 0 01-.996 0zM0 7.387v11.478c0 .23.08.424.238.576a.806.806 0 00.587.234h8.327v-6.408L7.478 14.525a.39.39 0 01-.494 0l-.005-.004L0 9.24V7.387z"/>
            </svg>
          }
          title={t("channels.outlook")}
          description={t("channels.outlookDesc")}
          buttonLabel={t("channels.connectOutlook")}
          onClick={() => handleOAuthConnect("outlook")}
        />

        <ConnectCard
          icon={
            <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
              <path d="M5.042 15.165a2.528 2.528 0 01-2.52 2.523A2.528 2.528 0 010 15.165a2.527 2.527 0 012.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 012.521-2.52 2.527 2.527 0 012.521 2.52v6.313A2.528 2.528 0 018.834 24a2.528 2.528 0 01-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 01-2.521-2.52A2.528 2.528 0 018.834 0a2.528 2.528 0 012.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 012.521 2.521 2.528 2.528 0 01-2.521 2.521H2.522A2.528 2.528 0 010 8.834a2.528 2.528 0 012.522-2.521h6.312zm10.124 2.521a2.528 2.528 0 012.52-2.521A2.528 2.528 0 0124 8.834a2.528 2.528 0 01-2.522 2.521h-2.52V8.834zm-1.268 0a2.528 2.528 0 01-2.524 2.521 2.528 2.528 0 01-2.52-2.521V2.522A2.528 2.528 0 0115.165 0a2.528 2.528 0 012.524 2.522v6.312zm-2.524 10.124a2.528 2.528 0 012.524 2.52A2.528 2.528 0 0115.165 24a2.528 2.528 0 01-2.52-2.522v-2.52h2.52zm0-1.268a2.528 2.528 0 01-2.52-2.524 2.528 2.528 0 012.52-2.52h6.313A2.528 2.528 0 0124 15.165a2.528 2.528 0 01-2.522 2.524h-6.313z" fill="#E01E5A"/>
            </svg>
          }
          title={t("channels.slack")}
          description={t("channels.slackDesc")}
          buttonLabel={t("channels.connectSlack")}
          onClick={() => handleOAuthConnect("slack")}
        />

        <ConnectCard
          icon={
            <svg className="w-6 h-6 text-violet-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
            </svg>
          }
          title="Embedded Chat"
          description="Add a chat widget to your website"
          buttonLabel="Create Widget"
          onClick={handleCreateWebchat}
          disabled={connecting}
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
                className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 p-4 rounded-xl border border-gray-100 hover:bg-gray-50 transition"
              >
                <ChannelBadge channel={account.channel} size="md" showLabel />
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm text-gray-900">{account.displayName}</p>
                  <p className="text-xs text-gray-400">{account.externalId}</p>
                  {account.lastError && account.connectionStatus === "ERROR" && (
                    <p className="text-xs text-red-500 mt-0.5">{account.lastError}</p>
                  )}
                </div>
                <div className="flex items-center gap-3 shrink-0 self-end sm:self-auto">
                  {account._count?.conversations > 0 && (
                    <span className="text-[10px] bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">
                      {account._count.conversations} {t("channels.activeConversations").toLowerCase()}
                    </span>
                  )}
                  <StatusBadge status={account.connectionStatus || "CONNECTED"} />

                  {/* Widget Settings button (WEBCHAT only) */}
                  {account.channel === "WEBCHAT" && account.connectionStatus === "CONNECTED" && (
                    <button
                      onClick={async () => {
                        const apiUrl = process.env.NEXT_PUBLIC_API_URL || window.location.origin;
                        setEmbedModal({ open: true, widgetId: account.externalId, code: "", apiUrl, accountId: account.id });
                        setEmbedTab("html");
                        if (token) {
                          try {
                            const res = await getWebchatSettings(token, account.id);
                            const s = res.data || {};
                            setWidgetColor(s.color || "#7c3aed");
                            setWidgetIconUrl(s.iconUrl || "");
                            setWidgetTitle(s.title || "Chat with us");
                            setWidgetPosition(s.position || "right");
                          } catch { /* use defaults */ }
                        }
                      }}
                      className="text-xs text-violet-500 hover:text-violet-700 transition p-1"
                      title="Widget Settings"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
                      </svg>
                    </button>
                  )}

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

                  {/* Disconnect button */}
                  {(account.connectionStatus === "CONNECTED" || account.connectionStatus === "ERROR") && (
                    <button
                      onClick={() => openDisconnectConfirm(account.id)}
                      className="text-xs text-red-500 hover:text-red-700 transition p-1"
                      title={t("channels.disconnect")}
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                      </svg>
                    </button>
                  )}

                  {/* Delete button (only for disconnected channels) */}
                  {account.connectionStatus === "DISCONNECTED" && (
                    <button
                      onClick={() => setDeleteConfirm({ open: true, id: account.id, name: account.displayName || account.externalId })}
                      className="text-xs text-red-400 hover:text-red-600 transition p-1"
                      title={t("common.delete")}
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
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

    <ConfirmModal
      isOpen={deleteConfirm.open}
      title={t("channels.deleteChannel")}
      message={t("channels.deleteChannelMsg", { name: deleteConfirm.name })}
      confirmText={t("common.delete")}
      danger
      loading={deleting}
      onConfirm={confirmDelete}
      onCancel={() => setDeleteConfirm({ open: false, id: "", name: "" })}
    />
    {embedModal.open && (
      <div className="fixed inset-0 z-50 flex items-center justify-center">
        <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setEmbedModal({ open: false, widgetId: "", code: "", apiUrl: "", accountId: "" })} />
        <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-2xl p-6 space-y-4 max-h-[90vh] overflow-y-auto">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-bold text-gray-900">Embed Chat Widget</h3>
            <button onClick={() => setEmbedModal({ open: false, widgetId: "", code: "", apiUrl: "", accountId: "" })} className="text-gray-400 hover:text-gray-600">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Customization */}
          <div className="bg-gray-50 rounded-xl p-4 space-y-3">
            <h4 className="text-sm font-semibold text-gray-700">Customize</h4>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Brand Color</label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={widgetColor}
                    onChange={(e) => setWidgetColor(e.target.value)}
                    className="w-8 h-8 rounded-lg border border-gray-200 cursor-pointer p-0"
                  />
                  <input
                    type="text"
                    value={widgetColor}
                    onChange={(e) => setWidgetColor(e.target.value)}
                    className="flex-1 text-xs border border-gray-200 rounded-lg px-2 py-1.5 font-mono"
                  />
                </div>
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Position</label>
                <div className="flex gap-1">
                  <button
                    onClick={() => setWidgetPosition("left")}
                    className={clsx("flex-1 py-1.5 text-xs font-medium rounded-lg border transition", widgetPosition === "left" ? "border-violet-300 bg-violet-50 text-violet-700" : "border-gray-200 text-gray-500 hover:bg-gray-100")}
                  >
                    Left
                  </button>
                  <button
                    onClick={() => setWidgetPosition("right")}
                    className={clsx("flex-1 py-1.5 text-xs font-medium rounded-lg border transition", widgetPosition === "right" ? "border-violet-300 bg-violet-50 text-violet-700" : "border-gray-200 text-gray-500 hover:bg-gray-100")}
                  >
                    Right
                  </button>
                </div>
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Header Title</label>
                <input
                  type="text"
                  value={widgetTitle}
                  onChange={(e) => setWidgetTitle(e.target.value)}
                  className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Icon URL (optional)</label>
                <input
                  type="text"
                  value={widgetIconUrl}
                  onChange={(e) => setWidgetIconUrl(e.target.value)}
                  placeholder="https://example.com/icon.png"
                  className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5"
                />
              </div>
            </div>
            {/* Preview */}
            <div className="flex items-center gap-3 pt-2">
              <div
                className="w-12 h-12 rounded-full flex items-center justify-center shadow-lg"
                style={{ background: `linear-gradient(135deg, ${widgetColor}, ${widgetColor}dd)` }}
              >
                {widgetIconUrl ? (
                  <img src={widgetIconUrl} alt="" className="w-8 h-8 rounded-full object-cover" />
                ) : (
                  <svg className="w-6 h-6" fill="white" viewBox="0 0 24 24"><path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"/></svg>
                )}
              </div>
              <div className="text-xs text-gray-400">Widget preview</div>
            </div>
          </div>

          {/* Framework Tabs */}
          <div>
            <h4 className="text-sm font-semibold text-gray-700 mb-2">Install</h4>
            <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
              {(["html", "nextjs", "react", "vue", "php"] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setEmbedTab(tab)}
                  className={clsx(
                    "flex-1 py-1.5 text-xs font-medium rounded-md transition",
                    embedTab === tab ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
                  )}
                >
                  {tab === "html" ? "HTML" : tab === "nextjs" ? "Next.js" : tab === "react" ? "React" : tab === "vue" ? "Vue" : "PHP"}
                </button>
              ))}
            </div>
          </div>
          {/* Code snippet */}
          {(() => {
            const wId = embedModal.widgetId;
            const api = embedModal.apiUrl;
            const configLines = [
              `  widgetId: "${wId}",`,
              `  apiUrl: "${api}",`,
              widgetColor !== "#7c3aed" ? `  color: "${widgetColor}",` : "",
              widgetIconUrl ? `  iconUrl: "${widgetIconUrl}",` : "",
              widgetTitle !== "Chat with us" ? `  title: "${widgetTitle}",` : "",
              widgetPosition !== "right" ? `  position: "${widgetPosition}",` : "",
            ].filter(Boolean).join("\n");
            const configBlock = `{\n${configLines}\n}`;

            const snippets: Record<string, { imports?: string; code: string; hint: string }> = {
              html: {
                hint: "Paste before the closing </body> tag",
                code: `<!-- ChatCenter Widget -->\n<script>\n(function(){\n  window.__chatcenter = ${configBlock};\n  var s = document.createElement("script");\n  s.src = "${api}/widget/chatcenter-widget.js";\n  s.async = true;\n  document.head.appendChild(s);\n})();\n</script>`,
              },
              nextjs: {
                hint: "Add to app/layout.tsx or any page",
                imports: `import Script from "next/script";`,
                code: `<Script\n  id="chatcenter-widget"\n  strategy="afterInteractive"\n  dangerouslySetInnerHTML={{\n    __html: \`\n      window.__chatcenter = ${configBlock};\n      var s = document.createElement("script");\n      s.src = "${api}/widget/chatcenter-widget.js";\n      s.async = true;\n      document.head.appendChild(s);\n    \`,\n  }}\n/>`,
              },
              react: {
                hint: "Add component to your App",
                imports: `import { useEffect } from "react";`,
                code: `function ChatCenterWidget() {\n  useEffect(() => {\n    window.__chatcenter = ${configBlock};\n    const s = document.createElement("script");\n    s.src = "${api}/widget/chatcenter-widget.js";\n    s.async = true;\n    document.head.appendChild(s);\n    return () => s.remove();\n  }, []);\n  return null;\n}\n\n// Render <ChatCenterWidget /> in your app`,
              },
              vue: {
                hint: "Add to App.vue or main layout",
                imports: `import { onMounted } from "vue";`,
                code: `<script setup>\nimport { onMounted } from "vue";\n\nonMounted(() => {\n  window.__chatcenter = ${configBlock};\n  const s = document.createElement("script");\n  s.src = "${api}/widget/chatcenter-widget.js";\n  s.async = true;\n  document.head.appendChild(s);\n});\n</script>`,
              },
              php: {
                hint: "Paste before closing </body> in your PHP template",
                code: `<!-- ChatCenter Widget -->\n<script>\n(function(){\n  window.__chatcenter = ${configBlock};\n  var s = document.createElement("script");\n  s.src = "${api}/widget/chatcenter-widget.js";\n  s.async = true;\n  document.head.appendChild(s);\n})();\n</script>`,
              },
            };
            const snippet = snippets[embedTab] || snippets.html;
            return (
              <div className="space-y-2">
                <p className="text-xs text-gray-400">{snippet.hint}</p>
                {snippet.imports && (
                  <div className="relative">
                    <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wide mb-1">Import</p>
                    <pre className="bg-gray-900 text-blue-300 text-xs p-3 rounded-lg overflow-x-auto whitespace-pre-wrap">{snippet.imports}</pre>
                    <button
                      onClick={() => { navigator.clipboard.writeText(snippet.imports!); showMessage("Import copied!", "success"); }}
                      className="absolute top-6 right-2 px-2 py-0.5 bg-white/10 hover:bg-white/20 text-white text-[10px] rounded-md transition"
                    >
                      Copy
                    </button>
                  </div>
                )}
                <div className="relative">
                  {snippet.imports && <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wide mb-1">Code</p>}
                  <pre className="bg-gray-900 text-green-400 text-xs p-3 rounded-lg overflow-x-auto whitespace-pre-wrap max-h-48">{snippet.code}</pre>
                  <button
                    onClick={() => { navigator.clipboard.writeText(snippet.code); showMessage("Copied to clipboard!", "success"); }}
                    className="absolute top-6 right-2 px-2 py-0.5 bg-white/10 hover:bg-white/20 text-white text-[10px] rounded-md transition"
                  >
                    Copy
                  </button>
                </div>
              </div>
            );
          })()}
          <div className="flex items-center justify-between pt-2 border-t border-gray-100">
            <p className="text-xs text-gray-400">Widget ID: <code className="bg-gray-100 px-1.5 py-0.5 rounded">{embedModal.widgetId}</code></p>
            {embedModal.accountId && (
              <button
                disabled={savingWidget}
                onClick={async () => {
                  if (!token || !embedModal.accountId) return;
                  setSavingWidget(true);
                  try {
                    await updateWebchatSettings(token, embedModal.accountId, {
                      color: widgetColor !== "#7c3aed" ? widgetColor : undefined,
                      iconUrl: widgetIconUrl || undefined,
                      title: widgetTitle !== "Chat with us" ? widgetTitle : undefined,
                      position: widgetPosition !== "right" ? widgetPosition : undefined,
                    });
                    showMessage("Widget settings saved!", "success");
                  } catch {
                    showMessage("Failed to save settings", "error");
                  } finally {
                    setSavingWidget(false);
                  }
                }}
                className="px-4 py-1.5 bg-violet-600 text-white text-xs font-medium rounded-lg hover:bg-violet-700 transition disabled:opacity-50"
              >
                {savingWidget ? "Saving..." : "Save Settings"}
              </button>
            )}
          </div>
        </div>
      </div>
    )}
    </>
  );
}
