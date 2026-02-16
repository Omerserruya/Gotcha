"use client";

import { useState, useEffect, FormEvent } from "react";
import { AppLayout } from "@/components/AppLayout";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { getAgents, createAgent, updateAgent, getAutoGreeting, updateAutoGreeting } from "@/lib/api";
import clsx from "clsx";

export default function AgentsPage() {
  const { token } = useAuth();
  const { t } = useI18n();
  const [agents, setAgents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showRegister, setShowRegister] = useState(false);
  const [activeTab, setActiveTab] = useState<"agents" | "settings">("agents");

  // Register form
  const [regName, setRegName] = useState("");
  const [regEmail, setRegEmail] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [regLoading, setRegLoading] = useState(false);
  const [regError, setRegError] = useState("");
  const [regSuccess, setRegSuccess] = useState(false);

  // Auto-greeting
  const [greetingTemplate, setGreetingTemplate] = useState("");
  const [greetingLoading, setGreetingLoading] = useState(false);
  const [greetingSaved, setGreetingSaved] = useState(false);

  useEffect(() => {
    if (!token) return;
    fetchAgents();
    fetchGreeting();
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

  async function fetchGreeting() {
    if (!token) return;
    try {
      const data = await getAutoGreeting(token);
      setGreetingTemplate(data.template || "");
    } catch (err) {
      console.error(err);
    }
  }

  async function handleRegister(e: FormEvent) {
    e.preventDefault();
    if (!token) return;
    setRegLoading(true);
    setRegError("");
    setRegSuccess(false);
    try {
      await createAgent(token, { name: regName, email: regEmail, password: regPassword });
      setRegSuccess(true);
      setRegName("");
      setRegEmail("");
      setRegPassword("");
      setShowRegister(false);
      fetchAgents();
    } catch (err: any) {
      setRegError(err.message || t("common.error"));
    } finally {
      setRegLoading(false);
    }
  }

  async function handleToggleActive(agentId: string, isActive: boolean) {
    if (!token) return;
    try {
      await updateAgent(token, agentId, { isActive: !isActive });
      fetchAgents();
    } catch (err) {
      console.error(err);
    }
  }

  async function handleSaveGreeting() {
    if (!token) return;
    setGreetingLoading(true);
    try {
      await updateAutoGreeting(token, greetingTemplate);
      setGreetingSaved(true);
      setTimeout(() => setGreetingSaved(false), 3000);
    } catch (err) {
      console.error(err);
    } finally {
      setGreetingLoading(false);
    }
  }

  return (
    <AppLayout>
      <div className="p-3 md:p-6 overflow-y-auto h-screen">
        {/* Header */}
        <div className="flex items-center justify-between mb-4 md:mb-6">
          <h1 className="text-xl md:text-2xl font-bold text-gray-900 ps-10 md:ps-0">{t("agents.title")}</h1>
          <button
            onClick={() => setShowRegister(true)}
            className="bg-primary-500 hover:bg-primary-600 text-white px-3 md:px-4 py-2 rounded-xl text-sm font-medium transition shadow-sm flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 7.5v3m0 0v3m0-3h3m-3 0h-3m-2.25-4.125a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zM4 19.235v-.11a6.375 6.375 0 0112.75 0v.109A12.318 12.318 0 0110.374 21c-2.331 0-4.512-.645-6.374-1.766z" />
            </svg>
            <span className="hidden sm:inline">{t("agents.addAgent")}</span>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mb-6 bg-gray-100 rounded-xl p-1 w-fit">
          <button
            onClick={() => setActiveTab("agents")}
            className={clsx(
              "px-4 py-2 text-sm rounded-lg font-medium transition",
              activeTab === "agents" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
            )}
          >
            {t("agents.title")}
          </button>
          <button
            onClick={() => setActiveTab("settings")}
            className={clsx(
              "px-4 py-2 text-sm rounded-lg font-medium transition",
              activeTab === "settings" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
            )}
          >
            {t("agents.settings")}
          </button>
        </div>

        {activeTab === "agents" ? (
          /* Agent List */
          <>
            {/* Desktop table */}
            <div className="hidden md:block bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50/80">
                  <tr>
                    <th className="text-start py-3.5 px-5 font-medium text-gray-500 text-xs uppercase tracking-wide">{t("agents.name")}</th>
                    <th className="text-start py-3.5 px-5 font-medium text-gray-500 text-xs uppercase tracking-wide">{t("agents.email")}</th>
                    <th className="text-start py-3.5 px-5 font-medium text-gray-500 text-xs uppercase tracking-wide">{t("agents.status")}</th>
                    <th className="text-start py-3.5 px-5 font-medium text-gray-500 text-xs uppercase tracking-wide">{t("agents.activeConversations")}</th>
                    <th className="text-start py-3.5 px-5 font-medium text-gray-500 text-xs uppercase tracking-wide"></th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan={5} className="py-12 text-center text-gray-400">
                      <div className="w-6 h-6 border-2 border-primary-200 border-t-primary-500 rounded-full animate-spin mx-auto" />
                    </td></tr>
                  ) : agents.length === 0 ? (
                    <tr><td colSpan={5} className="py-12 text-center text-gray-400">{t("common.noResults")}</td></tr>
                  ) : (
                    agents.map((agent) => (
                      <tr key={agent.id} className="border-t border-gray-50 hover:bg-gray-50/50 transition">
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
                          <span className={clsx(
                            "px-2.5 py-1 rounded-full text-xs font-medium",
                            agent.isActive
                              ? "bg-green-50 text-green-600 ring-1 ring-green-200"
                              : "bg-gray-100 text-gray-500"
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
                          <button
                            onClick={() => handleToggleActive(agent.id, agent.isActive)}
                            className={clsx(
                              "text-xs px-3 py-1.5 rounded-lg font-medium transition",
                              agent.isActive
                                ? "bg-red-50 text-red-500 hover:bg-red-100"
                                : "bg-green-50 text-green-600 hover:bg-green-100"
                            )}
                          >
                            {agent.isActive ? t("chatbot.deactivate") : t("chatbot.activate")}
                          </button>
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
                  <div key={agent.id} className="bg-white rounded-2xl shadow-card border border-gray-100 p-4">
                    <div className="flex items-center gap-3 mb-3">
                      <div className="w-10 h-10 bg-gradient-to-br from-primary-100 to-primary-200 rounded-xl flex items-center justify-center">
                        <span className="text-sm font-bold text-primary-600">{agent.name?.charAt(0).toUpperCase()}</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-gray-900 text-sm">{agent.name}</p>
                        <p className="text-xs text-gray-400 truncate">{agent.email}</p>
                      </div>
                      <span className={clsx(
                        "px-2.5 py-1 rounded-full text-xs font-medium shrink-0",
                        agent.isActive
                          ? "bg-green-50 text-green-600 ring-1 ring-green-200"
                          : "bg-gray-100 text-gray-500"
                      )}>
                        {agent.isActive ? t("agents.active") : t("agents.inactive")}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="bg-primary-50 text-primary-600 px-2.5 py-1 rounded-full text-xs font-medium">
                        {agent._count?.conversations ?? 0} chats
                      </span>
                      <button
                        onClick={() => handleToggleActive(agent.id, agent.isActive)}
                        className={clsx(
                          "text-xs px-3 py-1.5 rounded-lg font-medium transition",
                          agent.isActive
                            ? "bg-red-50 text-red-500 hover:bg-red-100"
                            : "bg-green-50 text-green-600 hover:bg-green-100"
                        )}
                      >
                        {agent.isActive ? t("chatbot.deactivate") : t("chatbot.activate")}
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </>
        ) : (
          /* Settings Tab - Auto Greeting */
          <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-4 md:p-6 max-w-2xl">
            <h3 className="font-bold text-gray-900 mb-1">{t("agents.autoGreeting")}</h3>
            <p className="text-sm text-gray-400 mb-4">{t("agents.autoGreetingDesc")}</p>

            <textarea
              value={greetingTemplate}
              onChange={(e) => setGreetingTemplate(e.target.value)}
              placeholder={t("agents.autoGreetingPlaceholder")}
              rows={4}
              className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition resize-none"
            />

            <div className="flex items-center gap-3 mt-4">
              <button
                onClick={handleSaveGreeting}
                disabled={greetingLoading}
                className="bg-primary-500 hover:bg-primary-600 text-white px-5 py-2.5 rounded-xl text-sm font-medium transition shadow-sm disabled:opacity-50"
              >
                {greetingLoading ? t("common.loading") : t("agents.saveGreeting")}
              </button>
              {greetingSaved && (
                <span className="text-sm text-green-600 flex items-center gap-1">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  {t("agents.greetingSaved")}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Register Agent Modal */}
        {showRegister && (
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-2xl w-full max-w-md p-6 shadow-xl">
              <h3 className="font-bold text-gray-900 text-lg mb-4">{t("agents.registerAgent")}</h3>

              {regError && (
                <div className="mb-4 p-3 rounded-xl bg-red-50 text-red-600 text-sm">{regError}</div>
              )}

              <form onSubmit={handleRegister} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{t("agents.name")}</label>
                  <input
                    type="text"
                    value={regName}
                    onChange={(e) => setRegName(e.target.value)}
                    required
                    className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{t("agents.email")}</label>
                  <input
                    type="email"
                    value={regEmail}
                    onChange={(e) => setRegEmail(e.target.value)}
                    required
                    className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{t("agents.password")}</label>
                  <input
                    type="password"
                    value={regPassword}
                    onChange={(e) => setRegPassword(e.target.value)}
                    required
                    minLength={8}
                    className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition"
                  />
                </div>

                <div className="flex gap-3 pt-2">
                  <button
                    type="submit"
                    disabled={regLoading}
                    className="flex-1 bg-primary-500 hover:bg-primary-600 text-white py-2.5 rounded-xl text-sm font-medium transition shadow-sm disabled:opacity-50"
                  >
                    {regLoading ? t("common.loading") : t("agents.registerButton")}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setShowRegister(false); setRegError(""); }}
                    className="flex-1 bg-gray-50 hover:bg-gray-100 text-gray-600 py-2.5 rounded-xl text-sm font-medium transition"
                  >
                    {t("common.cancel")}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
