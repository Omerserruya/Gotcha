"use client";

import { useState, useEffect, FormEvent } from "react";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { getAgents, createAgent, updateAgent, deleteAgent, resetAgentPassword, getDepartments, assignAgentToDepartment, removeAgentFromDepartment } from "@/lib/api";
import clsx from "clsx";
import ConfirmModal from "@/components/ConfirmModal";

type PanelMode = "create" | "edit";

export function AgentsContent() {
  const { token } = useAuth();
  const { t } = useI18n();
  const [agents, setAgents] = useState<any[]>([]);
  const [departments, setDepartments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // Side panel
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelMode, setPanelMode] = useState<PanelMode>("create");
  const [panelAgent, setPanelAgent] = useState<any>(null);

  // Form fields
  const [formName, setFormName] = useState("");
  const [formEmail, setFormEmail] = useState("");
  const [formPhone, setFormPhone] = useState("");
  const [formPassword, setFormPassword] = useState("");
  const [formDepartmentId, setFormDepartmentId] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [formLoading, setFormLoading] = useState(false);
  const [formError, setFormError] = useState("");

  // Reset password
  const [showResetPassword, setShowResetPassword] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [resetLoading, setResetLoading] = useState(false);
  const [resetSuccess, setResetSuccess] = useState(false);

  // Delete
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  useEffect(() => {
    if (!token) return;
    fetchAgents();
    getDepartments(token).then((res) => setDepartments((res as any)?.data || [])).catch(() => {});
  }, [token]);

  async function fetchAgents() {
    if (!token) return;
    try {
      const data = await getAgents(token);
      setAgents(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  function openCreate() {
    setPanelMode("create");
    setPanelAgent(null);
    setFormName("");
    setFormEmail("");
    setFormPhone("");
    setFormPassword("");
    setFormDepartmentId("");
    setFormError("");
    setShowPassword(false);
    setShowResetPassword(false);
    setResetSuccess(false);
    setPanelOpen(true);
  }

  function openEdit(agent: any) {
    setPanelMode("edit");
    setPanelAgent(agent);
    setFormName(agent.name || "");
    setFormEmail(agent.email || "");
    setFormPhone(agent.phoneNumber || "");
    setFormPassword("");
    setFormDepartmentId(agent.departmentId || "");
    setFormError("");
    setShowPassword(false);
    setShowResetPassword(false);
    setResetSuccess(false);
    setNewPassword("");
    setPanelOpen(true);
  }

  function closePanel() {
    setPanelOpen(false);
    setPanelAgent(null);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!token) return;
    setFormLoading(true);
    setFormError("");

    try {
      if (panelMode === "create") {
        if (!formName.trim() || !formEmail.trim() || !formPassword) return;
        const res = await createAgent(token, { name: formName.trim(), email: formEmail.trim(), password: formPassword });
        const newAgentId = (res as any)?.user?.id || (res as any)?.id;
        // Assign to department if selected
        if (formDepartmentId && newAgentId) {
          await assignAgentToDepartment(token, formDepartmentId, newAgentId).catch(() => {});
        }
      } else {
        if (!panelAgent || !formName.trim()) return;
        const phoneTrim = formPhone.trim();
        await updateAgent(token, panelAgent.id, {
          name: formName.trim(),
          // Empty string clears the number; otherwise pass through verbatim
          // and let the server normalize. The voice-copilot routes apply
          // E.164 normalization at TwiML build time.
          phoneNumber: phoneTrim ? phoneTrim : null,
        });
        // Handle department change
        const currentDeptId = panelAgent.departmentId || "";
        if (formDepartmentId !== currentDeptId) {
          // Remove from current department
          if (currentDeptId) {
            await removeAgentFromDepartment(token, currentDeptId, panelAgent.id).catch(() => {});
          }
          // Add to new department
          if (formDepartmentId) {
            await assignAgentToDepartment(token, formDepartmentId, panelAgent.id).catch(() => {});
          }
        }
      }
      closePanel();
      fetchAgents();
    } catch (err: any) {
      setFormError(err.message || t("common.error"));
    } finally {
      setFormLoading(false);
    }
  }

  async function handleToggleActive() {
    if (!token || !panelAgent) return;
    try {
      await updateAgent(token, panelAgent.id, { isActive: !panelAgent.isActive });
      fetchAgents();
      // Update panel agent state
      setPanelAgent({ ...panelAgent, isActive: !panelAgent.isActive });
    } catch (err) {
      console.error(err);
    }
  }

  async function handleResetPassword() {
    if (!token || !panelAgent || !newPassword || newPassword.length < 8) return;
    setResetLoading(true);
    try {
      await resetAgentPassword(token, panelAgent.id, newPassword);
      setResetSuccess(true);
      setNewPassword("");
      setTimeout(() => setResetSuccess(false), 3000);
    } catch (err: any) {
      setFormError(err.message || t("common.error"));
    } finally {
      setResetLoading(false);
    }
  }

  async function handleDelete() {
    if (!token || !deleteTarget) return;
    setDeleteLoading(true);
    try {
      await deleteAgent(token, deleteTarget.id);
      setDeleteTarget(null);
      closePanel();
      fetchAgents();
    } catch (err) {
      console.error(err);
    } finally {
      setDeleteLoading(false);
    }
  }

  return (
      <div className="p-3 md:p-6 overflow-y-auto h-full">
        {/* Header */}
        <div className="flex items-center justify-between mb-4 md:mb-6">
          <h1 className="text-xl md:text-2xl font-bold text-gray-900">{t("agents.title")}</h1>
          <button
            onClick={openCreate}
            className="bg-primary-500 hover:bg-primary-600 text-white px-3 md:px-4 py-2 rounded-xl text-sm font-medium transition shadow-sm flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 7.5v3m0 0v3m0-3h3m-3 0h-3m-2.25-4.125a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zM4 19.235v-.11a6.375 6.375 0 0112.75 0v.109A12.318 12.318 0 0110.374 21c-2.331 0-4.512-.645-6.374-1.766z" />
            </svg>
            <span className="hidden sm:inline">{t("agents.addAgent")}</span>
          </button>
        </div>

        {/* Agent List — Desktop table */}
        <div className="hidden md:block bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50/80">
              <tr>
                <th className="text-start py-3.5 px-5 font-medium text-gray-500 text-xs uppercase tracking-wide">{t("agents.name")}</th>
                <th className="text-start py-3.5 px-5 font-medium text-gray-500 text-xs uppercase tracking-wide">{t("agents.email")}</th>
                <th className="text-start py-3.5 px-5 font-medium text-gray-500 text-xs uppercase tracking-wide">{t("agents.department")}</th>
                <th className="text-start py-3.5 px-5 font-medium text-gray-500 text-xs uppercase tracking-wide">{t("agents.status")}</th>
                <th className="text-start py-3.5 px-5 font-medium text-gray-500 text-xs uppercase tracking-wide">{t("agents.activeConversations")}</th>
                <th className="text-start py-3.5 px-5 font-medium text-gray-500 text-xs uppercase tracking-wide"></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} className="py-12 text-center text-gray-400">
                  <div className="w-6 h-6 border-2 border-primary-200 border-t-primary-500 rounded-full animate-spin mx-auto" />
                </td></tr>
              ) : agents.length === 0 ? (
                <tr><td colSpan={6} className="py-12 text-center text-gray-400">{t("common.noResults")}</td></tr>
              ) : (
                agents.map((agent) => (
                  <tr
                    key={agent.id}
                    onClick={() => openEdit(agent)}
                    className="border-t border-gray-50 hover:bg-gray-50/50 transition cursor-pointer"
                  >
                    <td className="py-3.5 px-5">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 bg-gradient-to-br from-primary-100 to-primary-200 rounded-lg flex items-center justify-center">
                          <span className="text-xs font-bold text-primary-600">{agent.name?.charAt(0).toUpperCase()}</span>
                        </div>
                        <span className="font-medium text-gray-900">{agent.name}</span>
                      </div>
                    </td>
                    <td className="py-3.5 px-5 text-gray-500">{agent.email}</td>
                    <td className="py-3.5 px-5">
                      {agent.departmentName ? (
                        <span className="text-xs px-2.5 py-1 rounded-full font-medium bg-violet-50 text-violet-600 ring-1 ring-violet-200">{agent.departmentName}</span>
                      ) : (
                        <span className="text-xs text-gray-300">—</span>
                      )}
                    </td>
                    <td className="py-3.5 px-5">
                      <span className={clsx(
                        "px-2.5 py-1 rounded-full text-xs font-medium",
                        agent.isActive ? "bg-green-50 text-green-600 ring-1 ring-green-200" : "bg-gray-100 text-gray-500"
                      )}>
                        {agent.isActive ? t("agents.active") : t("agents.inactive")}
                      </span>
                    </td>
                    <td className="py-3.5 px-5">
                      <span className="bg-primary-50 text-primary-600 px-2.5 py-1 rounded-full text-xs font-medium">
                        {agent._count?.conversations ?? 0}
                      </span>
                    </td>
                    <td className="py-3.5 px-5">
                      <svg className="w-4 h-4 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                      </svg>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Mobile card list */}
        <div className="md:hidden space-y-3">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="w-6 h-6 border-2 border-primary-200 border-t-primary-500 rounded-full animate-spin" />
            </div>
          ) : agents.length === 0 ? (
            <div className="py-12 text-center text-gray-400">{t("common.noResults")}</div>
          ) : (
            agents.map((agent) => (
              <button
                key={agent.id}
                onClick={() => openEdit(agent)}
                className="w-full text-start bg-white rounded-2xl shadow-card border border-gray-100 p-4"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-gradient-to-br from-primary-100 to-primary-200 rounded-xl flex items-center justify-center shrink-0">
                    <span className="text-sm font-bold text-primary-600">{agent.name?.charAt(0).toUpperCase()}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-gray-900 text-sm">{agent.name}</p>
                    <p className="text-xs text-gray-400 truncate">{agent.email}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <span className={clsx(
                      "px-2 py-0.5 rounded-full text-[10px] font-medium",
                      agent.isActive ? "bg-green-50 text-green-600" : "bg-gray-100 text-gray-500"
                    )}>
                      {agent.isActive ? t("agents.active") : t("agents.inactive")}
                    </span>
                    {agent.departmentName && (
                      <span className="text-[10px] text-violet-500">{agent.departmentName}</span>
                    )}
                  </div>
                </div>
              </button>
            ))
          )}
        </div>

        {/* Side Panel — Create / Edit Agent */}
        {panelOpen && (
          <div className="fixed inset-0 z-50 flex">
            <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={closePanel} />
            <div className="relative ms-auto w-full max-w-[420px] bg-white h-full flex flex-col shadow-2xl animate-slide-in-right">
              {/* Header */}
              <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <h3 className="text-base font-bold text-gray-900">
                    {panelMode === "create" ? t("agents.registerAgent") : t("agents.editAgent")}
                  </h3>
                  {panelMode === "edit" && panelAgent && (
                    <p className="text-xs text-gray-400 mt-0.5">{panelAgent.email}</p>
                  )}
                </div>
                <button onClick={closePanel} className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition shrink-0">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {/* Content */}
              <div className="flex-1 overflow-y-auto px-5 py-5">
                <form onSubmit={handleSubmit} id="agent-form" className="space-y-4">
                  {formError && (
                    <div className="p-3 rounded-xl bg-red-50 text-red-600 text-sm">{formError}</div>
                  )}

                  {/* Name */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">{t("agents.name")}</label>
                    <input
                      type="text"
                      value={formName}
                      onChange={(e) => setFormName(e.target.value)}
                      required
                      className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition"
                      autoFocus
                    />
                  </div>

                  {/* Email (editable only in create) */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">{t("agents.email")}</label>
                    <input
                      type="email"
                      value={formEmail}
                      onChange={(e) => setFormEmail(e.target.value)}
                      required={panelMode === "create"}
                      disabled={panelMode === "edit"}
                      className={clsx(
                        "w-full px-4 py-2.5 border border-gray-200 rounded-xl text-sm outline-none transition",
                        panelMode === "edit" ? "bg-gray-100 text-gray-400 cursor-not-allowed" : "bg-gray-50 focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white"
                      )}
                    />
                  </div>

                  {/* Personal phone — used for FORWARD_TO_AGENT inbound mode
                      on voice channels, and for the smart-callback bridge
                      (we recognize the agent when they call the business
                      number back from their mobile). Only editable in edit
                      mode since create uses a separate registration flow. */}
                  {panelMode === "edit" && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1.5">
                        {t("agents.phoneNumber")}
                      </label>
                      <input
                        type="tel"
                        value={formPhone}
                        onChange={(e) => setFormPhone(e.target.value)}
                        placeholder="+972501234567"
                        className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition font-mono"
                      />
                      <p className="mt-1 text-[11px] text-gray-400">
                        {t("agents.phoneNumberHint")}
                      </p>
                    </div>
                  )}

                  {/* Password (create only) */}
                  {panelMode === "create" && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1.5">{t("agents.password")}</label>
                      <div className="relative">
                        <input
                          type={showPassword ? "text" : "password"}
                          value={formPassword}
                          onChange={(e) => setFormPassword(e.target.value)}
                          required
                          minLength={8}
                          className="w-full px-4 py-2.5 pe-10 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition"
                          placeholder="Min. 8 characters"
                        />
                        <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute end-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition" tabIndex={-1}>
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            {showPassword ? (
                              <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" />
                            ) : (
                              <>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                              </>
                            )}
                          </svg>
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Department */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">{t("agents.department")}</label>
                    <select
                      value={formDepartmentId}
                      onChange={(e) => setFormDepartmentId(e.target.value)}
                      className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition"
                    >
                      <option value="">{t("agents.noDepartment")}</option>
                      {departments.map((dept: any) => (
                        <option key={dept.id} value={dept.id}>{dept.name}</option>
                      ))}
                    </select>
                  </div>
                </form>

                {/* Edit-only sections */}
                {panelMode === "edit" && panelAgent && (
                  <div className="mt-6 space-y-4">
                    {/* Status toggle */}
                    <div className="flex items-center justify-between p-4 bg-gray-50 rounded-xl">
                      <div>
                        <p className="text-sm font-medium text-gray-700">{t("agents.status")}</p>
                        <p className="text-xs text-gray-400 mt-0.5">
                          {panelAgent.isActive ? t("agents.agentIsActive") : t("agents.agentIsInactive")}
                        </p>
                      </div>
                      <button
                        onClick={handleToggleActive}
                        className={clsx(
                          "relative w-11 h-6 rounded-full transition-colors",
                          panelAgent.isActive ? "bg-green-500" : "bg-gray-300"
                        )}
                      >
                        <span className={clsx(
                          "absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform",
                          panelAgent.isActive ? "translate-x-5.5 start-0.5" : "start-0.5"
                        )} style={{ transform: panelAgent.isActive ? "translateX(22px)" : "translateX(0)" }} />
                      </button>
                    </div>

                    {/* Reset password */}
                    <div className="border border-gray-200 rounded-xl overflow-hidden">
                      <button
                        onClick={() => setShowResetPassword(!showResetPassword)}
                        className="w-full flex items-center justify-between p-4 text-start hover:bg-gray-50 transition"
                      >
                        <div className="flex items-center gap-2.5">
                          <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                          </svg>
                          <span className="text-sm font-medium text-gray-700">{t("agents.resetPassword")}</span>
                        </div>
                        <svg className={clsx("w-4 h-4 text-gray-400 transition-transform", showResetPassword && "rotate-180")} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                        </svg>
                      </button>
                      {showResetPassword && (
                        <div className="px-4 pb-4 space-y-3">
                          <input
                            type="password"
                            value={newPassword}
                            onChange={(e) => setNewPassword(e.target.value)}
                            placeholder={t("agents.newPasswordPlaceholder")}
                            minLength={8}
                            className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-200 focus:bg-white outline-none transition"
                          />
                          <button
                            onClick={handleResetPassword}
                            disabled={resetLoading || newPassword.length < 8}
                            className="w-full py-2 bg-amber-500 hover:bg-amber-600 text-white text-sm font-medium rounded-xl transition disabled:opacity-50"
                          >
                            {resetLoading ? t("common.loading") : resetSuccess ? t("agents.passwordReset") : t("agents.resetPassword")}
                          </button>
                          {resetSuccess && (
                            <p className="text-xs text-green-600 text-center">{t("agents.passwordResetSuccess")}</p>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Danger zone */}
                    <div className="border border-red-200 rounded-xl p-4">
                      <p className="text-xs font-semibold text-red-500 uppercase tracking-wider mb-2">{t("agents.dangerZone")}</p>
                      <button
                        onClick={() => setDeleteTarget(panelAgent)}
                        className="w-full py-2.5 bg-red-50 text-red-600 text-sm font-medium rounded-xl hover:bg-red-100 transition flex items-center justify-center gap-2"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                        {t("agents.deleteAgent")}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="px-5 py-4 border-t border-gray-100">
                <button
                  type="submit"
                  form="agent-form"
                  disabled={formLoading}
                  className="w-full py-3 bg-primary-500 text-white text-sm font-semibold rounded-xl hover:bg-primary-600 disabled:opacity-50 transition flex items-center justify-center gap-2 shadow-sm"
                >
                  {formLoading ? (
                    <>
                      <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      {t("common.loading")}
                    </>
                  ) : panelMode === "create" ? t("agents.registerButton") : t("common.save")}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Delete Confirm */}
        <ConfirmModal
          isOpen={!!deleteTarget}
          title={t("agents.deleteAgent")}
          message={t("agents.deleteAgentMsg")}
          confirmText={t("common.delete")}
          danger
          loading={deleteLoading}
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      </div>
  );
}
