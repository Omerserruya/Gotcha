"use client";

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import {
  getChannelAccounts,
  createChannelAccount,
  deleteChannelAccount,
  getChannelConfig,
  updateChannelConfig,
} from "@/lib/api";
import { AppLayout } from "@/components/AppLayout";
import { ChannelBadge } from "@/components/conversations/ChannelBadge";
import clsx from "clsx";

export default function ChannelsPage() {
  const { token, user } = useAuth();
  const { t } = useI18n();
  const [accounts, setAccounts] = useState<any[]>([]);
  const [botFlowMode, setBotFlowMode] = useState<string>("UNIFIED");
  const [showAdd, setShowAdd] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  // New channel form
  const [newChannel, setNewChannel] = useState("WHATSAPP");
  const [newExternalId, setNewExternalId] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newAccessToken, setNewAccessToken] = useState("");

  const fetchData = useCallback(async () => {
    if (!token) return;
    try {
      const [accountsRes, configRes] = await Promise.all([
        getChannelAccounts(token),
        getChannelConfig(token),
      ]);
      setAccounts(accountsRes.data || []);
      setBotFlowMode(configRes.data?.botFlowMode || "UNIFIED");
    } catch (err) {
      console.error("Failed to load channel data:", err);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { fetchData(); }, [fetchData]);

  async function handleAddChannel() {
    if (!token || !newExternalId || !newDisplayName || !newAccessToken) return;
    setSaving(true);
    try {
      await createChannelAccount(token, {
        channel: newChannel,
        externalId: newExternalId,
        displayName: newDisplayName,
        credentials: { accessToken: newAccessToken },
      });
      setShowAdd(false);
      setNewExternalId("");
      setNewDisplayName("");
      setNewAccessToken("");
      setMessage(t("channels.created"));
      fetchData();
    } catch (err: any) {
      setMessage(err.message || "Error");
    } finally {
      setSaving(false);
      setTimeout(() => setMessage(""), 3000);
    }
  }

  async function handleDelete(id: string) {
    if (!token || !confirm(t("channels.confirmDelete"))) return;
    try {
      await deleteChannelAccount(token, id);
      setMessage(t("channels.deleted"));
      fetchData();
    } catch (err: any) {
      setMessage(err.message || "Error");
    }
    setTimeout(() => setMessage(""), 3000);
  }

  async function handleModeChange(mode: string) {
    if (!token) return;
    setBotFlowMode(mode);
    try {
      await updateChannelConfig(token, { botFlowMode: mode });
      setMessage(t("channels.saved"));
    } catch (err: any) {
      setMessage(err.message || "Error");
    }
    setTimeout(() => setMessage(""), 3000);
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
        <div className="bg-green-50 text-green-700 text-sm px-4 py-2.5 rounded-xl border border-green-200">
          {message}
        </div>
      )}

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

      {/* Channel Accounts */}
      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-gray-900">Connected Channels</h2>
          <button
            onClick={() => setShowAdd(!showAdd)}
            className="text-xs px-3 py-1.5 bg-primary-500 text-white rounded-lg hover:bg-primary-600 transition font-medium"
          >
            {t("channels.addChannel")}
          </button>
        </div>

        {/* Add channel form */}
        {showAdd && (
          <div className="bg-gray-50 rounded-xl p-4 mb-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1">{t("channels.platform")}</label>
                <select
                  value={newChannel}
                  onChange={(e) => setNewChannel(e.target.value)}
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white"
                >
                  <option value="WHATSAPP">WhatsApp</option>
                  <option value="MESSENGER">Messenger</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1">{t("channels.displayName")}</label>
                <input
                  value={newDisplayName}
                  onChange={(e) => setNewDisplayName(e.target.value)}
                  placeholder="Main WhatsApp Line"
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2"
                />
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600 block mb-1">
                {t("channels.accountId")} ({newChannel === "WHATSAPP" ? "Phone Number ID" : "Page ID"})
              </label>
              <input
                value={newExternalId}
                onChange={(e) => setNewExternalId(e.target.value)}
                placeholder={newChannel === "WHATSAPP" ? "123456789012345" : "109876543210"}
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600 block mb-1">{t("channels.accessToken")}</label>
              <input
                type="password"
                value={newAccessToken}
                onChange={(e) => setNewAccessToken(e.target.value)}
                placeholder="EAAxxxxxxx..."
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2"
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleAddChannel}
                disabled={saving || !newExternalId || !newDisplayName || !newAccessToken}
                className="text-xs px-4 py-2 bg-primary-500 text-white rounded-lg hover:bg-primary-600 transition font-medium disabled:opacity-40"
              >
                {saving ? t("common.loading") : t("common.save")}
              </button>
              <button
                onClick={() => setShowAdd(false)}
                className="text-xs px-4 py-2 bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200 transition"
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        )}

        {/* Channel list */}
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="w-6 h-6 border-2 border-primary-200 border-t-primary-500 rounded-full animate-spin" />
          </div>
        ) : accounts.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-sm text-gray-400">No channels connected yet</p>
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
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  {account._count?.conversations > 0 && (
                    <span className="text-[10px] bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">
                      {account._count.conversations} {t("channels.activeConversations").toLowerCase()}
                    </span>
                  )}
                  <span className={clsx(
                    "text-[10px] px-2 py-0.5 rounded-full font-medium",
                    account.isActive
                      ? "bg-green-50 text-green-600 ring-1 ring-green-200"
                      : "bg-gray-100 text-gray-500"
                  )}>
                    {account.isActive ? t("channels.active") : t("channels.inactive")}
                  </span>
                  <button
                    onClick={() => handleDelete(account.id)}
                    className="text-xs text-red-500 hover:text-red-700 transition p-1"
                    title={t("common.delete")}
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
    </AppLayout>
  );
}
