"use client";

import { useState, useEffect, useCallback } from "react";
import { AppLayout } from "@/components/AppLayout";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import {
  getDepartments, createDepartment, updateDepartment, deleteDepartment,
  getDepartmentMembers, addDepartmentMember, removeDepartmentMember, updateDepartmentMember,
  getAgents,
} from "@/lib/api";
import Link from "next/link";
import clsx from "clsx";

export default function DepartmentsPage() {
  const { token } = useAuth();
  const { t } = useI18n();
  const [departments, setDepartments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editDept, setEditDept] = useState<any>(null);
  const [manageDept, setManageDept] = useState<any>(null);
  const [members, setMembers] = useState<any[]>([]);
  const [agents, setAgents] = useState<any[]>([]);
  const [showAddMember, setShowAddMember] = useState(false);

  // Form state
  const [formName, setFormName] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formQueueMode, setFormQueueMode] = useState("CLAIM");

  const fetchDepartments = useCallback(async () => {
    if (!token) return;
    try {
      const res = await getDepartments(token);
      setDepartments(res.data);
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => { fetchDepartments(); }, [fetchDepartments]);

  async function handleCreate() {
    if (!token || !formName.trim()) return;
    try {
      await createDepartment(token, { name: formName.trim(), description: formDesc.trim() || undefined, queueMode: formQueueMode });
      setShowCreate(false);
      setFormName(""); setFormDesc(""); setFormQueueMode("CLAIM");
      fetchDepartments();
    } catch (err: any) { alert(err.message); }
  }

  async function handleUpdate() {
    if (!token || !editDept) return;
    try {
      await updateDepartment(token, editDept.id, { name: formName.trim(), description: formDesc.trim(), queueMode: formQueueMode });
      setEditDept(null);
      fetchDepartments();
    } catch (err: any) { alert(err.message); }
  }

  async function handleDelete(id: string) {
    if (!token || !confirm(t("departments.confirmDelete"))) return;
    try {
      await deleteDepartment(token, id);
      fetchDepartments();
    } catch (err: any) { alert(err.message); }
  }

  async function openManage(dept: any) {
    if (!token) return;
    setManageDept(dept);
    try {
      const [membersRes, agentsRes] = await Promise.all([
        getDepartmentMembers(token, dept.id),
        getAgents(token),
      ]);
      setMembers(membersRes.data);
      setAgents(Array.isArray(agentsRes) ? agentsRes : []);
    } catch (err) { console.error(err); }
  }

  async function handleAddMember(userId: string, role: string = "AGENT") {
    if (!token || !manageDept) return;
    try {
      await addDepartmentMember(token, manageDept.id, { userId, departmentRole: role });
      setShowAddMember(false);
      openManage(manageDept);
      fetchDepartments();
    } catch (err: any) { alert(err.message); }
  }

  async function handleRemoveMember(userId: string) {
    if (!token || !manageDept) return;
    try {
      await removeDepartmentMember(token, manageDept.id, userId);
      openManage(manageDept);
      fetchDepartments();
    } catch (err: any) { alert(err.message); }
  }

  async function handleToggleRole(userId: string, currentRole: string) {
    if (!token || !manageDept) return;
    const newRole = currentRole === "MANAGER" ? "AGENT" : "MANAGER";
    try {
      await updateDepartmentMember(token, manageDept.id, userId, { departmentRole: newRole });
      openManage(manageDept);
    } catch (err: any) { alert(err.message); }
  }

  function openEdit(dept: any) {
    setFormName(dept.name);
    setFormDesc(dept.description || "");
    setFormQueueMode(dept.queueMode);
    setEditDept(dept);
  }

  function openCreate() {
    setFormName(""); setFormDesc(""); setFormQueueMode("CLAIM");
    setShowCreate(true);
  }

  const availableAgents = agents.filter((a: any) => !members.some((m: any) => m.userId === a.id));

  return (
    <AppLayout>
      <div className="p-3 md:p-6 overflow-y-auto h-screen">
        <div className="flex items-center justify-between mb-4 md:mb-6">
          <div>
            <h1 className="text-xl md:text-2xl font-bold text-gray-900 ">{t("departments.title")}</h1>
            <p className="text-sm text-gray-400 mt-0.5 ">{t("departments.subtitle")}</p>
          </div>
          <button onClick={openCreate} className="bg-primary-500 hover:bg-primary-600 text-white px-4 py-2 rounded-xl text-sm font-medium transition shadow-sm flex items-center gap-2">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            {t("departments.addDepartment")}
          </button>
        </div>

        <div className="max-w-4xl">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="w-6 h-6 border-2 border-primary-200 border-t-primary-500 rounded-full animate-spin" />
            </div>
          ) : departments.length === 0 ? (
            <div className="text-center py-12 bg-white rounded-2xl border border-gray-100">
              <p className="text-gray-400">{t("common.noResults")}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {departments.map((dept) => (
                <div key={dept.id} className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2.5 mb-1">
                        <h3 className="font-semibold text-gray-900">{dept.name}</h3>
                        <span className={clsx(
                          "text-[10px] px-2 py-0.5 rounded-full font-medium",
                          dept.isActive ? "bg-green-50 text-green-600" : "bg-gray-100 text-gray-500"
                        )}>
                          {dept.isActive ? t("agents.active") : t("agents.inactive")}
                        </span>
                        <span className={clsx(
                          "text-[10px] px-2 py-0.5 rounded-full font-medium",
                          dept.queueMode === "ROUND_ROBIN" ? "bg-blue-50 text-blue-600" : "bg-amber-50 text-amber-600"
                        )}>
                          {dept.queueMode === "ROUND_ROBIN" ? t("departments.roundRobin") : t("departments.claim")}
                        </span>
                      </div>
                      {dept.description && <p className="text-sm text-gray-400">{dept.description}</p>}
                      <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
                        <span>{dept._count?.members || 0} {t("departments.members").toLowerCase()}</span>
                        <span>{dept._count?.conversations || 0} {t("departments.conversations").toLowerCase()}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button onClick={() => openManage(dept)} className="text-xs px-3 py-1.5 bg-primary-50 text-primary-600 rounded-lg hover:bg-primary-100 font-medium transition">
                        {t("departments.members")}
                      </button>
                      <Link href={`/departments/${dept.id}/copilot`} className="text-xs px-3 py-1.5 bg-violet-50 text-violet-600 rounded-lg hover:bg-violet-100 font-medium transition">
                        {t("departments.copilotConfig")}
                      </Link>
                      <button onClick={() => openEdit(dept)} className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-primary-600 hover:bg-primary-50 transition">
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
                        </svg>
                      </button>
                      <button onClick={() => handleDelete(dept.id)} className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-red-500 hover:bg-red-50 transition">
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Create / Edit Dialog */}
      {(showCreate || editDept) && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-md p-6 shadow-xl">
            <h3 className="font-bold text-gray-900 mb-4">{editDept ? t("departments.editDepartment") : t("departments.addDepartment")}</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t("departments.name")}</label>
                <input type="text" value={formName} onChange={(e) => setFormName(e.target.value)} className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t("departments.description")}</label>
                <input type="text" value={formDesc} onChange={(e) => setFormDesc(e.target.value)} className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t("departments.queueMode")}</label>
                <select value={formQueueMode} onChange={(e) => setFormQueueMode(e.target.value)} className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition">
                  <option value="CLAIM">{t("departments.claim")}</option>
                  <option value="ROUND_ROBIN">{t("departments.roundRobin")}</option>
                </select>
              </div>
            </div>
            <div className="flex gap-2 mt-6">
              <button onClick={editDept ? handleUpdate : handleCreate} className="flex-1 bg-primary-500 hover:bg-primary-600 text-white py-2.5 rounded-xl text-sm font-medium transition">
                {editDept ? t("common.save") : t("departments.addDepartment")}
              </button>
              <button onClick={() => { setShowCreate(false); setEditDept(null); }} className="flex-1 bg-gray-100 text-gray-600 py-2.5 rounded-xl text-sm font-medium hover:bg-gray-200 transition">
                {t("common.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Members Management Dialog */}
      {manageDept && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-lg p-6 shadow-xl max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-bold text-gray-900">{manageDept.name} - {t("departments.members")}</h3>
                <p className="text-xs text-gray-400 mt-0.5">{t("departments.subtitle")}</p>
              </div>
              <button onClick={() => setShowAddMember(true)} className="text-xs px-3 py-1.5 bg-primary-500 text-white rounded-lg hover:bg-primary-600 font-medium transition flex items-center gap-1">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
                {t("departments.addMember")}
              </button>
            </div>

            {members.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-6">{t("departments.noMembers")}</p>
            ) : (
              <div className="space-y-2">
                {members.map((m: any) => (
                  <div key={m.id} className="flex items-center gap-3 p-3 rounded-xl border border-gray-100 hover:bg-gray-50 transition">
                    <div className="w-8 h-8 bg-gradient-to-br from-primary-100 to-primary-200 rounded-lg flex items-center justify-center">
                      <span className="text-xs font-bold text-primary-600">{m.user?.name?.charAt(0).toUpperCase()}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm text-gray-900">{m.user?.name}</p>
                      <p className="text-xs text-gray-400">{m.user?.email}</p>
                    </div>
                    <button
                      onClick={() => handleToggleRole(m.userId, m.departmentRole)}
                      className={clsx("text-[10px] px-2.5 py-1 rounded-full font-medium cursor-pointer transition",
                        m.departmentRole === "MANAGER" ? "bg-violet-50 text-violet-600 hover:bg-violet-100" : "bg-gray-100 text-gray-500 hover:bg-gray-200"
                      )}
                    >
                      {m.departmentRole === "MANAGER" ? t("departments.roleManager") : t("departments.roleAgent")}
                    </button>
                    <button onClick={() => handleRemoveMember(m.userId)} className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-300 hover:text-red-500 hover:bg-red-50 transition">
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}

            <button onClick={() => { setManageDept(null); setMembers([]); }} className="w-full mt-4 py-2.5 text-sm text-gray-500 hover:text-gray-700 bg-gray-50 hover:bg-gray-100 rounded-xl transition">
              {t("common.back")}
            </button>
          </div>
        </div>
      )}

      {/* Add Member Dialog */}
      {showAddMember && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-sm p-6 shadow-xl">
            <h3 className="font-bold text-gray-900 mb-1">{t("departments.addMember")}</h3>
            <p className="text-xs text-gray-400 mb-4">{t("departments.selectAgent")}</p>
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {availableAgents.map((agent: any) => (
                <button key={agent.id} onClick={() => handleAddMember(agent.id)} disabled={!agent.isActive} className="w-full text-start p-3 rounded-xl border border-gray-100 hover:bg-primary-50 hover:border-primary-200 transition disabled:opacity-40">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 bg-gradient-to-br from-primary-100 to-primary-200 rounded-lg flex items-center justify-center">
                      <span className="text-xs font-bold text-primary-600">{agent.name?.charAt(0).toUpperCase()}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm text-gray-900">{agent.name}</p>
                      <p className="text-xs text-gray-400">{agent.email}</p>
                    </div>
                    {agent.departmentName && (
                      <span className="text-[10px] bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">{agent.departmentName}</span>
                    )}
                  </div>
                </button>
              ))}
              {availableAgents.length === 0 && (
                <p className="text-sm text-gray-400 text-center py-4">{t("common.noResults")}</p>
              )}
            </div>
            <button onClick={() => setShowAddMember(false)} className="w-full mt-4 py-2.5 text-sm text-gray-500 hover:text-gray-700 bg-gray-50 hover:bg-gray-100 rounded-xl transition">
              {t("common.cancel")}
            </button>
          </div>
        </div>
      )}
    </AppLayout>
  );
}
