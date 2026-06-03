"use client";

import { useState, useEffect, useCallback } from "react";
import { useDynamicParam } from "@/lib/useRouteParam";
import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import { getSystemTenant, updateTenant, createTenantUser, updateTenantUser, toggleFirstTakeCare, updateBotConfig, getAIPrompt } from "@/lib/api";
import { SystemLayout } from "@/components/SystemLayout";
import { FeaturesSection } from "./FeaturesSection";
import clsx from "clsx";

export default function TenantDetailPage() {
  const { token } = useAuth();
  const tenantId = useDynamicParam();

  const [tenant, setTenant] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [showAddUser, setShowAddUser] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error">("success");

  // Add user form
  const [newUserName, setNewUserName] = useState("");
  const [newUserEmail, setNewUserEmail] = useState("");
  const [newUserPassword, setNewUserPassword] = useState("");
  const [newUserRole, setNewUserRole] = useState("AGENT");
  const [addingUser, setAddingUser] = useState(false);
  const [showUserPassword, setShowUserPassword] = useState(false);
  const [ftcEnabled, setFtcEnabled] = useState(false);
  const [ftcToggling, setFtcToggling] = useState(false);
  const [botEnabled, setBotEnabled] = useState(false);
  const [botType, setBotType] = useState<string | null>(null);
  const [botConfigSaving, setBotConfigSaving] = useState(false);
  // Voice Phase-1 flags — surfaced here so a system admin can flip them
  // per-tenant without touching the DB. The tenant's settings sidebar
  // gates /settings/voice-channels on voiceCopilotEnabled.
  const [voiceCopilotEnabled, setVoiceCopilotEnabled] = useState(false);
  const [voiceInboxUiEnabled, setVoiceInboxUiEnabled] = useState(false);
  const [voiceIncomingEnabled, setVoiceIncomingEnabled] = useState(false);
  const [voiceSaving, setVoiceSaving] = useState(false);
  const [aiPromptDeptId, setAiPromptDeptId] = useState<string | null>(null);
  const [aiPromptData, setAiPromptData] = useState<any>(null);
  const [aiPromptLoading, setAiPromptLoading] = useState(false);

  const showMsg = (msg: string, type: "success" | "error" = "success") => {
    setMessage(msg);
    setMessageType(type);
    setTimeout(() => setMessage(""), 5000);
  };

  const fetchTenant = useCallback(async () => {
    if (!token || !tenantId) return;
    try {
      const res = await getSystemTenant(token, tenantId);
      setTenant(res.data);
      setEditName(res.data.name);
      setFtcEnabled(!!res.data.firstTakeCareEnabled);
      setBotEnabled(!!res.data.botEnabled);
      setBotType(res.data.botType || null);
      setVoiceCopilotEnabled(!!res.data.voiceCopilotEnabled);
      setVoiceInboxUiEnabled(!!res.data.voiceInboxUiEnabled);
      setVoiceIncomingEnabled(!!res.data.voiceIncomingEnabled);
    } catch (err) {
      console.error("Failed to load tenant:", err);
    } finally {
      setLoading(false);
    }
  }, [token, tenantId]);

  useEffect(() => { fetchTenant(); }, [fetchTenant]);

  async function handleSaveName() {
    if (!token) return;
    try {
      await updateTenant(token, tenantId, { name: editName });
      showMsg("Tenant updated");
      setEditing(false);
      fetchTenant();
    } catch (err: any) {
      showMsg(err.message || "Failed to update", "error");
    }
  }

  async function handleToggleActive() {
    if (!token || !tenant) return;
    if (!confirm(tenant.isActive ? "Disable this tenant? Users will not be able to log in." : "Enable this tenant?")) return;
    try {
      await updateTenant(token, tenantId, { isActive: !tenant.isActive });
      showMsg(tenant.isActive ? "Tenant disabled" : "Tenant enabled");
      fetchTenant();
    } catch (err: any) {
      showMsg(err.message || "Failed to update", "error");
    }
  }

  async function handleSaveVoiceFlag(field: "voiceCopilotEnabled" | "voiceInboxUiEnabled" | "voiceIncomingEnabled", next: boolean) {
    if (!token) return;
    setVoiceSaving(true);
    try {
      await updateTenant(token, tenantId, { [field]: next });
      if (field === "voiceCopilotEnabled") setVoiceCopilotEnabled(next);
      if (field === "voiceInboxUiEnabled") setVoiceInboxUiEnabled(next);
      if (field === "voiceIncomingEnabled") setVoiceIncomingEnabled(next);
      showMsg(next ? "Enabled" : "Disabled");
    } catch (err: any) {
      showMsg(err?.message || "Failed to update voice flag", "error");
    } finally {
      setVoiceSaving(false);
    }
  }

  async function handleToggleFtc() {
    if (!token) return;
    setFtcToggling(true);
    try {
      await toggleFirstTakeCare(token, tenantId, !ftcEnabled);
      setFtcEnabled(!ftcEnabled);
      showMsg(ftcEnabled ? "First-Take-Care disabled" : "First-Take-Care enabled");
    } catch (err: any) {
      showMsg(err.message || "Failed to update First-Take-Care", "error");
    } finally {
      setFtcToggling(false);
    }
  }

  async function handleSaveBotConfig(enabled: boolean, type: string | null) {
    if (!token) return;
    setBotConfigSaving(true);
    try {
      await updateBotConfig(token, tenantId, {
        botEnabled: enabled,
        ...(type ? { botType: type } : {}),
      });
      setBotEnabled(enabled);
      if (type) setBotType(type);
      // Sync FTC enabled state
      if (type === "AUTONOMOUS_AI" && enabled) setFtcEnabled(true);
      if (type === "CHATBOT_FLOW" && enabled) setFtcEnabled(false);
      showMsg("Bot configuration updated");
    } catch (err: any) {
      showMsg(err.message || "Failed to update bot configuration", "error");
    } finally {
      setBotConfigSaving(false);
    }
  }

  async function handleAddUser(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setAddingUser(true);
    try {
      await createTenantUser(token, tenantId, {
        name: newUserName,
        email: newUserEmail,
        password: newUserPassword,
        role: newUserRole,
      });
      showMsg("User created");
      setShowAddUser(false);
      setNewUserName(""); setNewUserEmail(""); setNewUserPassword(""); setNewUserRole("AGENT");
      fetchTenant();
    } catch (err: any) {
      showMsg(err.message || "Failed to create user", "error");
    } finally {
      setAddingUser(false);
    }
  }

  async function handleViewAIPrompt(departmentId: string) {
    if (!token) return;
    if (aiPromptDeptId === departmentId) {
      setAiPromptDeptId(null);
      setAiPromptData(null);
      return;
    }
    setAiPromptDeptId(departmentId);
    setAiPromptLoading(true);
    try {
      const res = await getAIPrompt(token, departmentId);
      setAiPromptData(res.data);
    } catch (err: any) {
      setAiPromptData({ error: err.message || "Failed to load AI prompt" });
    } finally {
      setAiPromptLoading(false);
    }
  }

  async function handleToggleUser(userId: string, isActive: boolean) {
    if (!token) return;
    try {
      await updateTenantUser(token, tenantId, userId, { isActive: !isActive });
      showMsg(isActive ? "User deactivated" : "User activated");
      fetchTenant();
    } catch (err: any) {
      showMsg(err.message || "Failed to update user", "error");
    }
  }

  if (loading) {
    return (
      <SystemLayout>
        <div className="flex items-center justify-center h-full py-16">
          <div className="w-6 h-6 border-2 border-orange-200 border-t-orange-500 rounded-full animate-spin" />
        </div>
      </SystemLayout>
    );
  }

  if (!tenant) {
    return (
      <SystemLayout>
        <div className="max-w-5xl mx-auto p-6">
          <p className="text-gray-400">Tenant not found</p>
          <Link href="/system/tenants" className="text-orange-500 text-sm mt-2 inline-block">Back to tenants</Link>
        </div>
      </SystemLayout>
    );
  }

  return (
    <SystemLayout>
      <div className="max-w-5xl mx-auto p-6 space-y-6">
        {/* Breadcrumb */}
        <div className="flex items-center gap-2 text-sm">
          <Link href="/system/tenants" className="text-gray-400 hover:text-orange-500 transition">Tenants</Link>
          <span className="text-gray-300">/</span>
          <span className="text-gray-900 font-medium">{tenant.name}</span>
        </div>

        {/* Toast */}
        {message && (
          <div className={clsx(
            "text-sm px-4 py-2.5 rounded-xl border",
            messageType === "success" ? "bg-green-50 text-green-700 border-green-200" : "bg-red-50 text-red-700 border-red-200"
          )}>
            {message}
          </div>
        )}

        {/* Tenant Info */}
        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          <div className="flex items-start justify-between">
            <div className="flex-1">
              {editing ? (
                <div className="flex items-center gap-2">
                  <input
                    value={editName} onChange={(e) => setEditName(e.target.value)}
                    className="text-lg font-bold text-gray-900 border border-gray-200 rounded-lg px-3 py-1 focus:ring-2 focus:ring-orange-200 outline-none"
                  />
                  <button onClick={handleSaveName} className="text-xs text-orange-500 hover:text-orange-600 font-medium">Save</button>
                  <button onClick={() => { setEditing(false); setEditName(tenant.name); }} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <h1 className="text-lg font-bold text-gray-900">{tenant.name}</h1>
                  <button onClick={() => setEditing(true)} className="text-xs text-gray-400 hover:text-orange-500 transition">Edit</button>
                </div>
              )}
              <p className="text-sm text-gray-400 mt-0.5">Slug: <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">{tenant.slug}</code></p>
              <p className="text-xs text-gray-400 mt-1">Created: {new Date(tenant.createdAt).toLocaleString()}</p>
            </div>
            <div className="flex items-center gap-3">
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ring-1 ${
                tenant.isActive ? "bg-green-50 text-green-600 ring-green-200" : "bg-red-50 text-red-600 ring-red-200"
              }`}>
                {tenant.isActive ? "Active" : "Disabled"}
              </span>
              <button
                onClick={handleToggleActive}
                className={clsx("text-xs px-3 py-1.5 rounded-lg font-medium transition",
                  tenant.isActive ? "bg-red-50 text-red-600 hover:bg-red-100" : "bg-green-50 text-green-600 hover:bg-green-100"
                )}
              >
                {tenant.isActive ? "Disable Tenant" : "Enable Tenant"}
              </button>
            </div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mt-5 pt-5 border-t border-gray-100">
            {[
              { label: "Users", value: tenant._count?.users || 0 },
              { label: "Conversations", value: tenant._count?.conversations || 0 },
              { label: "Messages", value: tenant._count?.messages || 0 },
              { label: "Channels", value: tenant._count?.channelAccounts || 0 },
              { label: "Departments", value: tenant._count?.departments || 0 },
            ].map((s) => (
              <div key={s.label} className="text-center">
                <p className="text-lg font-bold text-gray-900">{s.value}</p>
                <p className="text-xs text-gray-400">{s.label}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Connected Channels */}
        {tenant.channels && tenant.channels.length > 0 && (
          <div className="bg-white rounded-2xl border border-gray-200 p-6">
            <h2 className="font-semibold text-gray-900 mb-3">Connected Channels</h2>
            <div className="space-y-2">
              {tenant.channels.map((ch: any) => (
                <div key={ch.id} className="flex items-center justify-between p-3 rounded-xl bg-gray-50">
                  <div className="flex items-center gap-3">
                    <span className="text-xs font-medium text-gray-600 bg-white px-2 py-1 rounded-lg border">{ch.channel}</span>
                    <span className="text-sm text-gray-900">{ch.displayName}</span>
                  </div>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ring-1 ${
                    ch.connectionStatus === "CONNECTED"
                      ? "bg-green-50 text-green-600 ring-green-200"
                      : "bg-red-50 text-red-600 ring-red-200"
                  }`}>
                    {ch.connectionStatus}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Bot Configuration */}
        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-9 h-9 rounded-xl bg-orange-100 flex items-center justify-center">
              <svg className="w-5 h-5 text-orange-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
              </svg>
            </div>
            <div>
              <h2 className="font-semibold text-gray-900">Bot Configuration</h2>
              <p className="text-xs text-gray-400 mt-0.5">Configure the bot type for this tenant</p>
            </div>
          </div>

          {/* Bot Enabled Toggle */}
          <div className="flex items-center justify-between mb-4 pb-4 border-b border-gray-100">
            <div>
              <p className="text-sm font-medium text-gray-700">Bot Enabled</p>
              <p className="text-xs text-gray-400">Master switch for bot functionality</p>
            </div>
            <div className="flex items-center gap-3">
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ring-1 ${
                botEnabled ? "bg-green-50 text-green-600 ring-green-200" : "bg-gray-100 text-gray-500 ring-gray-200"
              }`}>
                {botEnabled ? "Enabled" : "Disabled"}
              </span>
              <button
                onClick={() => handleSaveBotConfig(!botEnabled, botType)}
                disabled={botConfigSaving}
                className={clsx(
                  "relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none disabled:opacity-50",
                  botEnabled ? "bg-orange-500" : "bg-gray-200"
                )}
                role="switch"
                aria-checked={botEnabled}
              >
                <span className={clsx(
                  "pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transform ring-0 transition duration-200 ease-in-out",
                  botEnabled ? "translate-x-5" : "translate-x-0"
                )} />
              </button>
            </div>
          </div>

          {/* Bot Type Selection - only shown when enabled */}
          {botEnabled && (
            <div>
              <p className="text-sm font-medium text-gray-700 mb-3">Bot Type</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                  onClick={() => handleSaveBotConfig(true, "CHATBOT_FLOW")}
                  disabled={botConfigSaving}
                  className={clsx(
                    "p-4 rounded-xl border-2 text-start transition",
                    botType === "CHATBOT_FLOW" ? "border-orange-400 bg-orange-50" : "border-gray-200 hover:border-gray-300"
                  )}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <svg className="w-4 h-4 text-orange-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6z" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25z" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6z" />
                    </svg>
                    <p className="font-medium text-sm text-gray-900">Chatbot Flow</p>
                  </div>
                  <p className="text-xs text-gray-500">Visual flow builder with decision trees and automated responses</p>
                </button>
                <button
                  onClick={() => handleSaveBotConfig(true, "AUTONOMOUS_AI")}
                  disabled={botConfigSaving}
                  className={clsx(
                    "p-4 rounded-xl border-2 text-start transition",
                    botType === "AUTONOMOUS_AI" ? "border-orange-400 bg-orange-50" : "border-gray-200 hover:border-gray-300"
                  )}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <svg className="w-4 h-4 text-orange-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
                    </svg>
                    <p className="font-medium text-sm text-gray-900">Autonomous AI</p>
                  </div>
                  <p className="text-xs text-gray-500">AI-powered agent that autonomously handles customer conversations</p>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Voice CoPilot — Phase-1 master + sub-flags. These live on the
            Tenant model (voice_copilot_enabled, etc.), separate from the
            general FeaturesSection toggles below. */}
        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-9 h-9 rounded-xl bg-sky-100 flex items-center justify-center">
              <svg className="w-5 h-5 text-sky-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
              </svg>
            </div>
            <div>
              <h2 className="font-semibold text-gray-900">Voice CoPilot</h2>
              <p className="text-xs text-gray-400 mt-0.5">Master switches for the voice channel and call assistance features.</p>
            </div>
          </div>

          {([
            { key: "voiceCopilotEnabled" as const, value: voiceCopilotEnabled, title: "Voice CoPilot enabled", desc: "Master switch — unhides /settings/voice-channels and unlocks all voice APIs." },
            { key: "voiceInboxUiEnabled" as const, value: voiceInboxUiEnabled, title: "Voice inbox UI", desc: "Show voice sessions inside the Conversations inbox." },
            { key: "voiceIncomingEnabled" as const, value: voiceIncomingEnabled, title: "Incoming voice calls", desc: "Allow inbound voice calls to ring agents from this tenant." },
          ]).map((row) => (
            <div key={row.key} className="flex items-center justify-between py-3 border-b border-gray-100 last:border-0">
              <div className="pr-4">
                <p className="text-sm font-medium text-gray-700">{row.title}</p>
                <p className="text-xs text-gray-400 mt-0.5">{row.desc}</p>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ring-1 ${
                  row.value ? "bg-green-50 text-green-600 ring-green-200" : "bg-gray-100 text-gray-500 ring-gray-200"
                }`}>
                  {row.value ? "Enabled" : "Disabled"}
                </span>
                <button
                  onClick={() => handleSaveVoiceFlag(row.key, !row.value)}
                  disabled={voiceSaving}
                  className={clsx(
                    "relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none disabled:opacity-50",
                    row.value ? "bg-sky-500" : "bg-gray-200"
                  )}
                  role="switch"
                  aria-checked={row.value}
                >
                  <span className={clsx(
                    "pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transform ring-0 transition duration-200 ease-in-out",
                    row.value ? "translate-x-5" : "translate-x-0"
                  )} />
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Features (two-layer permission system — tenant level) */}
        <FeaturesSection tenantId={tenantId} onMessage={showMsg} />

        {/* AI Prompt Viewer */}
        {tenant.departments && tenant.departments.length > 0 && (
          <div className="bg-white rounded-2xl border border-gray-200 p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-9 h-9 rounded-xl bg-violet-100 flex items-center justify-center">
                <svg className="w-5 h-5 text-violet-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
                </svg>
              </div>
              <div>
                <h2 className="font-semibold text-gray-900">AI Prompt Viewer</h2>
                <p className="text-xs text-gray-400 mt-0.5">View assembled AI agent prompts per department</p>
              </div>
            </div>
            <div className="space-y-2">
              {tenant.departments.map((dept: any) => (
                <div key={dept.id}>
                  <button
                    onClick={() => handleViewAIPrompt(dept.id)}
                    className={clsx(
                      "w-full flex items-center justify-between p-3 rounded-xl transition text-start",
                      aiPromptDeptId === dept.id ? "bg-violet-50 border border-violet-200" : "bg-gray-50 hover:bg-gray-100"
                    )}
                  >
                    <span className="text-sm font-medium text-gray-700">{dept.name}</span>
                    <span className="text-xs text-violet-500 font-medium">
                      {aiPromptDeptId === dept.id ? "Hide" : "View Prompt"}
                    </span>
                  </button>
                  {aiPromptDeptId === dept.id && (
                    <div className="mt-2 p-4 bg-gray-900 rounded-xl overflow-auto max-h-96">
                      {aiPromptLoading ? (
                        <div className="flex items-center justify-center py-4">
                          <div className="w-5 h-5 border-2 border-violet-400 border-t-violet-200 rounded-full animate-spin" />
                        </div>
                      ) : aiPromptData?.error ? (
                        <p className="text-sm text-red-400">{aiPromptData.error}</p>
                      ) : (
                        <pre className="text-xs text-gray-300 whitespace-pre-wrap font-mono leading-relaxed">
                          {aiPromptData?.systemPrompt || JSON.stringify(aiPromptData, null, 2)}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Users */}
        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-gray-900">Users</h2>
            <button
              onClick={() => setShowAddUser(!showAddUser)}
              className="text-xs px-3 py-1.5 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition font-medium"
            >
              {showAddUser ? "Cancel" : "Add User"}
            </button>
          </div>

          {/* Add User Form */}
          {showAddUser && (
            <form onSubmit={handleAddUser} className="mb-4 p-4 rounded-xl bg-gray-50 border border-gray-200 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <input value={newUserName} onChange={(e) => setNewUserName(e.target.value)} required placeholder="Name" className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white" />
                <input type="email" value={newUserEmail} onChange={(e) => setNewUserEmail(e.target.value)} required placeholder="Email" className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white" />
                <div className="relative">
                  <input type={showUserPassword ? "text" : "password"} value={newUserPassword} onChange={(e) => setNewUserPassword(e.target.value)} required minLength={8} placeholder="Password (min 8)" className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 pe-10 bg-white" />
                  <button type="button" onClick={() => setShowUserPassword(!showUserPassword)} className="absolute end-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition" tabIndex={-1}>
                    {showUserPassword ? (
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" /></svg>
                    ) : (
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                    )}
                  </button>
                </div>
                <select value={newUserRole} onChange={(e) => setNewUserRole(e.target.value)} className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white">
                  <option value="AGENT">Agent</option>
                  <option value="ADMIN">Admin</option>
                </select>
              </div>
              <div className="flex justify-end">
                <button type="submit" disabled={addingUser} className="text-xs px-4 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition font-medium disabled:opacity-40">
                  {addingUser ? "Creating..." : "Create User"}
                </button>
              </div>
            </form>
          )}

          {/* Users List */}
          <div className="space-y-2">
            {(tenant.users || []).map((u: any) => (
              <div key={u.id} className="flex items-center justify-between p-3 rounded-xl hover:bg-gray-50 transition">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 bg-gradient-to-br from-gray-300 to-gray-400 rounded-lg flex items-center justify-center text-xs font-bold text-white">
                    {u.name?.charAt(0).toUpperCase() || "?"}
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-900">{u.name}</p>
                    <p className="text-xs text-gray-400">{u.email}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-gray-100 text-gray-600 ring-1 ring-gray-200">
                    {u.role}
                  </span>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ring-1 ${
                    u.isActive ? "bg-green-50 text-green-600 ring-green-200" : "bg-red-50 text-red-600 ring-red-200"
                  }`}>
                    {u.isActive ? "Active" : "Inactive"}
                  </span>
                  {u.role !== "SYSTEM_ADMIN" && (
                    <button
                      onClick={() => handleToggleUser(u.id, u.isActive)}
                      className={clsx("text-xs transition", u.isActive ? "text-red-400 hover:text-red-600" : "text-green-400 hover:text-green-600")}
                    >
                      {u.isActive ? "Deactivate" : "Activate"}
                    </button>
                  )}
                </div>
              </div>
            ))}
            {(!tenant.users || tenant.users.length === 0) && (
              <p className="text-sm text-gray-400 text-center py-4">No users in this tenant</p>
            )}
          </div>
        </div>
      </div>
    </SystemLayout>
  );
}
