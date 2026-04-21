"use client";

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import {
  getDepartmentTree, createDepartment, updateDepartment, deleteDepartment,
  getDepartmentMembers, addDepartmentMember, removeDepartmentMember, updateDepartmentMember,
  getAgents, getAIAgents, getDepartmentAIEmployee, assignDepartmentAIEmployee,
} from "@/lib/api";
import Link from "next/link";
import clsx from "clsx";
import ConfirmModal from "@/components/ConfirmModal";

interface DeptNode {
  id: string;
  name: string;
  description?: string;
  isActive: boolean;
  queueMode: string;
  parentId?: string | null;
  _count?: { members: number; conversations: number };
  members?: any[];
  children?: DeptNode[];
}

interface TreeData {
  tree: DeptNode[];
  aiAgents: any[];
}

function DepartmentNode({
  node,
  aiAgents,
  depth,
  onEdit,
  onDelete,
  onManage,
  onAssignAI,
  t,
}: {
  node: DeptNode;
  aiAgents: any[];
  depth: number;
  onEdit: (dept: DeptNode) => void;
  onDelete: (id: string, name: string) => void;
  onManage: (dept: DeptNode) => void;
  onAssignAI: (dept: DeptNode) => void;
  t: (key: string) => string;
}) {
  const [expanded, setExpanded] = useState(depth === 0);
  const [agentsExpanded, setAgentsExpanded] = useState(false);
  const hasChildren = node.children && node.children.length > 0;
  const humanAgents = node.members || [];

  return (
    <div className={clsx(depth > 0 && "ms-6 border-l-2 border-gray-200 ps-4")}>
      <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5 mb-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3 flex-1 min-w-0">
            {/* Expand toggle */}
            {hasChildren ? (
              <button
                onClick={() => setExpanded(!expanded)}
                className="mt-0.5 w-6 h-6 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition shrink-0"
                title={expanded ? t("departments.collapse") : t("departments.expand")}
              >
                <svg
                  className={clsx("w-3.5 h-3.5 transition-transform", expanded && "rotate-90")}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                </svg>
              </button>
            ) : (
              <span className="w-6 shrink-0" />
            )}

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2.5 mb-1 flex-wrap">
                <h3 className="font-semibold text-gray-900">{node.name}</h3>
                <span className={clsx(
                  "text-[10px] px-2 py-0.5 rounded-full font-medium",
                  node.isActive ? "bg-green-50 text-green-600" : "bg-gray-100 text-gray-500"
                )}>
                  {node.isActive ? t("agents.active") : t("agents.inactive")}
                </span>
                <span className={clsx(
                  "text-[10px] px-2 py-0.5 rounded-full font-medium",
                  node.queueMode === "ROUND_ROBIN" ? "bg-blue-50 text-blue-600" : "bg-amber-50 text-amber-600"
                )}>
                  {node.queueMode === "ROUND_ROBIN" ? t("departments.roundRobin") : t("departments.claim")}
                </span>
              </div>
              {node.description && <p className="text-sm text-gray-400">{node.description}</p>}
              <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
                <span>{node._count?.members || 0} {t("departments.members").toLowerCase()}</span>
                <span>{node._count?.conversations || 0} {t("departments.conversations").toLowerCase()}</span>
              </div>

              {/* Agent list (expandable) */}
              {(humanAgents.length > 0) && (
                <div className="mt-3">
                  <button
                    onClick={() => setAgentsExpanded(!agentsExpanded)}
                    className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 transition"
                  >
                    <svg
                      className={clsx("w-3 h-3 transition-transform", agentsExpanded && "rotate-90")}
                      fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                    </svg>
                    <span className="font-medium">{t("departments.humanAgents")}</span>
                    <span className="bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded-full text-[10px] font-medium">{humanAgents.length}</span>
                  </button>
                  {agentsExpanded && (
                    <div className="mt-2 space-y-1.5 ps-5">
                      {humanAgents.map((m: any) => (
                        <div key={m.id || m.userId} className="flex items-center gap-2">
                          <span className={clsx(
                            "w-1.5 h-1.5 rounded-full shrink-0",
                            m.user?.isActive !== false ? "bg-green-400" : "bg-gray-300"
                          )} />
                          <span className="text-xs text-gray-700">{m.user?.name || m.name}</span>
                          <span className={clsx(
                            "text-[10px] px-1.5 py-0.5 rounded-full font-medium",
                            m.departmentRole === "MANAGER" ? "bg-violet-50 text-violet-600" : "bg-gray-100 text-gray-500"
                          )}>
                            {m.departmentRole === "MANAGER" ? t("departments.roleManager") : t("departments.roleAgent")}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-1 shrink-0 flex-wrap justify-end">
            <button onClick={() => onManage(node)} className="text-xs px-3 py-1.5 bg-primary-50 text-primary-600 rounded-lg hover:bg-primary-100 font-medium transition min-h-[36px]">
              {t("departments.members")}
            </button>
            <button onClick={() => onAssignAI(node)} className="text-xs px-3 py-1.5 bg-violet-50 text-violet-600 rounded-lg hover:bg-violet-100 font-medium transition min-h-[36px] flex items-center gap-1.5">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
              </svg>
              {t("departments.aiEmployee")}
            </button>
            <button onClick={() => onEdit(node)} className="w-9 h-9 rounded-lg flex items-center justify-center text-gray-400 hover:text-primary-600 hover:bg-primary-50 transition">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
              </svg>
            </button>
            <button onClick={() => onDelete(node.id, node.name)} className="w-9 h-9 rounded-lg flex items-center justify-center text-gray-400 hover:text-red-500 hover:bg-red-50 transition">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Children */}
      {expanded && hasChildren && (
        <div>
          {node.children!.map((child) => (
            <DepartmentNode
              key={child.id}
              node={child}
              aiAgents={aiAgents}
              depth={depth + 1}
              onEdit={onEdit}
              onDelete={onDelete}
              onManage={onManage}
              onAssignAI={onAssignAI}
              t={t}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function DepartmentsContent() {
  const { token } = useAuth();
  const { t } = useI18n();
  const [treeData, setTreeData] = useState<TreeData>({ tree: [], aiAgents: [] });
  // Flat list of all departments for parent dropdown
  const [allDepts, setAllDepts] = useState<DeptNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editDept, setEditDept] = useState<DeptNode | null>(null);
  const [manageDept, setManageDept] = useState<DeptNode | null>(null);
  const [members, setMembers] = useState<any[]>([]);
  const [agents, setAgents] = useState<any[]>([]);
  const [showAddMember, setShowAddMember] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<{ open: boolean; id: string; name: string }>({ open: false, id: "", name: "" });
  const [deleting, setDeleting] = useState(false);
  // AI Employee assignment
  const [assignDept, setAssignDept] = useState<DeptNode | null>(null);
  const [aiEmployeeList, setAIEmployeeList] = useState<any[]>([]);
  const [currentAIEmployee, setCurrentAIEmployee] = useState<any>(null);
  const [assignLoading, setAssignLoading] = useState(false);

  // Form state
  const [formName, setFormName] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formQueueMode, setFormQueueMode] = useState("CLAIM");
  const [formParentId, setFormParentId] = useState("");

  // Flatten tree for parent dropdown
  function flattenTree(nodes: DeptNode[]): DeptNode[] {
    const result: DeptNode[] = [];
    function walk(list: DeptNode[]) {
      for (const n of list) {
        result.push(n);
        if (n.children) walk(n.children);
      }
    }
    walk(nodes);
    return result;
  }

  const fetchTree = useCallback(async () => {
    if (!token) return;
    try {
      const res = await getDepartmentTree(token);
      const data = (res as any)?.data || { tree: [], aiAgents: [] };
      setTreeData(data);
      setAllDepts(flattenTree(data.tree));
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => { fetchTree(); }, [fetchTree]);

  async function handleCreate() {
    if (!token || !formName.trim()) return;
    try {
      await createDepartment(token, {
        name: formName.trim(),
        description: formDesc.trim() || undefined,
        queueMode: formQueueMode,
        ...(formParentId ? { parentId: formParentId } : {}),
      } as any);
      setShowCreate(false);
      setFormName(""); setFormDesc(""); setFormQueueMode("CLAIM"); setFormParentId("");
      fetchTree();
    } catch (err: any) { alert(err.message); }
  }

  async function handleUpdate() {
    if (!token || !editDept) return;
    try {
      await updateDepartment(token, editDept.id, {
        name: formName.trim(),
        description: formDesc.trim(),
        queueMode: formQueueMode,
        ...(formParentId !== undefined ? { parentId: formParentId || null } : {}),
      } as any);
      setEditDept(null);
      fetchTree();
    } catch (err: any) { alert(err.message); }
  }

  function openDeleteConfirm(id: string, name: string) {
    setDeleteConfirm({ open: true, id, name });
  }

  async function confirmDelete() {
    if (!token) return;
    setDeleting(true);
    try {
      await deleteDepartment(token, deleteConfirm.id);
      setDeleteConfirm({ open: false, id: "", name: "" });
      fetchTree();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setDeleting(false);
    }
  }

  async function openManage(dept: DeptNode) {
    if (!token) return;
    setManageDept(dept);
    try {
      const [membersRes, agentsRes] = await Promise.all([
        getDepartmentMembers(token, dept.id),
        getAgents(token),
      ]);
      setMembers((membersRes as any).data || []);
      setAgents(Array.isArray(agentsRes) ? agentsRes : []);
    } catch (err) { console.error(err); }
  }

  async function handleAddMember(userId: string, role: string = "AGENT") {
    if (!token || !manageDept) return;
    try {
      await addDepartmentMember(token, manageDept.id, { userId, departmentRole: role });
      setShowAddMember(false);
      openManage(manageDept);
      fetchTree();
    } catch (err: any) { alert(err.message); }
  }

  async function handleRemoveMember(userId: string) {
    if (!token || !manageDept) return;
    try {
      await removeDepartmentMember(token, manageDept.id, userId);
      openManage(manageDept);
      fetchTree();
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

  async function openAssignAI(dept: DeptNode) {
    if (!token) return;
    setAssignDept(dept);
    setAssignLoading(true);
    try {
      const [aiRes, currentRes] = await Promise.all([
        getAIAgents(token),
        getDepartmentAIEmployee(token, dept.id),
      ]);
      setAIEmployeeList((aiRes as any).data || []);
      setCurrentAIEmployee(currentRes?.data || null);
    } catch (err) { console.error(err); }
    finally { setAssignLoading(false); }
  }

  async function handleAssignAIEmployee(aiAgentId: string | null) {
    if (!token || !assignDept) return;
    try {
      await assignDepartmentAIEmployee(token, assignDept.id, aiAgentId);
      if (aiAgentId) {
        const agent = aiEmployeeList.find((a: any) => a.id === aiAgentId);
        setCurrentAIEmployee(agent || null);
      } else {
        setCurrentAIEmployee(null);
      }
      fetchTree();
    } catch (err: any) { alert(err.message); }
  }

  function openEdit(dept: DeptNode) {
    setFormName(dept.name);
    setFormDesc(dept.description || "");
    setFormQueueMode(dept.queueMode);
    setFormParentId(dept.parentId || "");
    setEditDept(dept);
  }

  function openCreate() {
    setFormName(""); setFormDesc(""); setFormQueueMode("CLAIM"); setFormParentId("");
    setShowCreate(true);
  }

  const availableAgents = agents.filter((a: any) => !members.some((m: any) => m.userId === a.id));

  return (
    <>
      <div className="p-3 md:p-6 overflow-y-auto h-full">
        <div className="flex items-center justify-between mb-4 md:mb-6">
          <div>
            <h1 className="text-xl md:text-2xl font-bold text-gray-900">{t("departments.title")}</h1>
            <p className="text-sm text-gray-400 mt-0.5">{t("departments.subtitle")}</p>
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
          ) : treeData.tree.length === 0 ? (
            <div className="text-center py-12 bg-white rounded-2xl border border-gray-100">
              <p className="text-gray-400">{t("common.noResults")}</p>
            </div>
          ) : (
            <div>
              {treeData.tree.map((node) => (
                <DepartmentNode
                  key={node.id}
                  node={node}
                  aiAgents={treeData.aiAgents}
                  depth={0}
                  onEdit={openEdit}
                  onDelete={openDeleteConfirm}
                  onManage={openManage}
                  onAssignAI={openAssignAI}
                  t={t}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Create / Edit Side Panel */}
      {(showCreate || editDept) && (
        <div className="fixed inset-0 z-50 flex">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => { setShowCreate(false); setEditDept(null); }} />
          <div className="relative ms-auto w-full max-w-[420px] bg-white h-full flex flex-col shadow-2xl animate-slide-in-right">
            {/* Header */}
            <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <h3 className="text-base font-bold text-gray-900">
                  {editDept ? t("departments.editDepartment") : t("departments.addDepartment")}
                </h3>
                {editDept && (
                  <p className="text-xs text-gray-400 mt-0.5">{editDept.name}</p>
                )}
              </div>
              <button onClick={() => { setShowCreate(false); setEditDept(null); }} className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition shrink-0">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-5 py-5">
              <div className="space-y-4">
                {/* Name */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">{t("departments.name")}</label>
                  <input
                    type="text"
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition"
                    autoFocus
                  />
                </div>

                {/* Description */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">{t("departments.description")}</label>
                  <input
                    type="text"
                    value={formDesc}
                    onChange={(e) => setFormDesc(e.target.value)}
                    className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition"
                  />
                </div>

                {/* Queue Mode */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">{t("departments.queueMode")}</label>
                  <select
                    value={formQueueMode}
                    onChange={(e) => setFormQueueMode(e.target.value)}
                    className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition"
                  >
                    <option value="CLAIM">{t("departments.claim")}</option>
                    <option value="ROUND_ROBIN">{t("departments.roundRobin")}</option>
                  </select>
                </div>

                {/* Parent Department */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">{t("departments.parentDepartment")}</label>
                  <select
                    value={formParentId}
                    onChange={(e) => setFormParentId(e.target.value)}
                    className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition"
                  >
                    <option value="">{t("departments.noParent")}</option>
                    {allDepts
                      .filter((d) => !editDept || d.id !== editDept.id)
                      .map((d) => (
                        <option key={d.id} value={d.id}>{d.name}</option>
                      ))}
                  </select>
                </div>
              </div>

              {/* Edit-only sections */}
              {editDept && (
                <div className="mt-6 space-y-4">
                  {/* Status toggle */}
                  <div className="flex items-center justify-between p-4 bg-gray-50 rounded-xl">
                    <div>
                      <p className="text-sm font-medium text-gray-700">{t("agents.status")}</p>
                      <p className="text-xs text-gray-400 mt-0.5">
                        {editDept.isActive ? t("agents.agentIsActive") : t("agents.agentIsInactive")}
                      </p>
                    </div>
                    <button
                      onClick={async () => {
                        if (!token) return;
                        try {
                          await updateDepartment(token, editDept.id, { isActive: !editDept.isActive } as any);
                          setEditDept({ ...editDept, isActive: !editDept.isActive });
                          fetchTree();
                        } catch (err: any) { alert(err.message); }
                      }}
                      className={clsx(
                        "relative w-11 h-6 rounded-full transition-colors",
                        editDept.isActive ? "bg-green-500" : "bg-gray-300"
                      )}
                    >
                      <span
                        className={clsx(
                          "absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform",
                          editDept.isActive ? "start-0.5" : "start-0.5"
                        )}
                        style={{ transform: editDept.isActive ? "translateX(22px)" : "translateX(0)" }}
                      />
                    </button>
                  </div>

                  {/* Danger zone */}
                  <div className="border border-red-200 rounded-xl p-4">
                    <p className="text-xs font-semibold text-red-500 uppercase tracking-wider mb-2">{t("agents.dangerZone")}</p>
                    <button
                      onClick={() => {
                        setShowCreate(false);
                        setEditDept(null);
                        openDeleteConfirm(editDept.id, editDept.name);
                      }}
                      className="w-full py-2.5 bg-red-50 text-red-600 text-sm font-medium rounded-xl hover:bg-red-100 transition flex items-center justify-center gap-2"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                      {t("common.delete")}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-5 py-4 border-t border-gray-100">
              <button
                onClick={editDept ? handleUpdate : handleCreate}
                disabled={!formName.trim()}
                className="w-full py-3 bg-primary-500 text-white text-sm font-semibold rounded-xl hover:bg-primary-600 disabled:opacity-50 transition flex items-center justify-center gap-2 shadow-sm"
              >
                {editDept ? t("common.save") : t("departments.addDepartment")}
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

      {/* Delete Confirm Modal */}
      <ConfirmModal
        isOpen={deleteConfirm.open}
        title={t("confirm.deleteTitle")}
        message={t("confirm.deleteDepartmentMsg")}
        confirmText={t("common.delete")}
        danger
        loading={deleting}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteConfirm({ open: false, id: "", name: "" })}
      />

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
      {/* AI Employee Assignment Dialog */}
      {assignDept && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-md p-6 shadow-xl max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-bold text-gray-900">{assignDept.name} - {t("departments.aiEmployee")}</h3>
                <p className="text-xs text-gray-400 mt-0.5">{t("departments.aiEmployeeDesc")}</p>
              </div>
            </div>

            {assignLoading ? (
              <div className="flex items-center justify-center py-8">
                <div className="w-6 h-6 border-2 border-violet-200 border-t-violet-500 rounded-full animate-spin" />
              </div>
            ) : (
              <>
                {/* Current assignment */}
                {currentAIEmployee && (
                  <div className="mb-4 p-3 rounded-xl border border-violet-200 bg-violet-50/50">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-violet-400 to-violet-600 flex items-center justify-center text-white font-bold text-sm shrink-0">
                        {currentAIEmployee.name?.charAt(0).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm text-gray-900">{currentAIEmployee.name}</p>
                        <p className="text-xs text-gray-500">{t("departments.currentAIEmployee")}</p>
                      </div>
                      <Link href={`/ai-studio/agents/${currentAIEmployee.id}`} className="text-xs px-2.5 py-1 bg-violet-100 text-violet-600 rounded-lg hover:bg-violet-200 font-medium transition">
                        {t("common.edit")}
                      </Link>
                      <button
                        onClick={() => handleAssignAIEmployee(null)}
                        className="text-xs px-2.5 py-1 bg-red-50 text-red-500 rounded-lg hover:bg-red-100 font-medium transition"
                      >
                        {t("departments.unassign")}
                      </button>
                    </div>
                  </div>
                )}

                {/* Available AI Employees */}
                <p className="text-sm font-medium text-gray-700 mb-2">
                  {currentAIEmployee ? t("departments.changeAIEmployee") : t("departments.assignAIEmployee")}
                </p>
                <div className="space-y-2 max-h-60 overflow-y-auto">
                  {aiEmployeeList
                    .filter((a: any) => a.id !== currentAIEmployee?.id)
                    .map((agent: any) => (
                    <button
                      key={agent.id}
                      onClick={() => handleAssignAIEmployee(agent.id)}
                      className="w-full text-start p-3 rounded-xl border border-gray-100 hover:bg-violet-50 hover:border-violet-200 transition"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-violet-400 to-violet-600 flex items-center justify-center text-white font-bold text-xs shrink-0">
                          {agent.name?.charAt(0).toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm text-gray-900">{agent.name}</p>
                          <p className="text-xs text-gray-400">{agent.role} &middot; {agent.mode?.toLowerCase()}</p>
                        </div>
                        <span className={clsx(
                          "text-[10px] px-2 py-0.5 rounded-full font-medium",
                          agent.status === "ACTIVE" ? "bg-green-50 text-green-600" : "bg-gray-100 text-gray-500"
                        )}>
                          {agent.status?.toLowerCase()}
                        </span>
                      </div>
                    </button>
                  ))}
                  {aiEmployeeList.filter((a: any) => a.id !== currentAIEmployee?.id).length === 0 && (
                    <div className="text-center py-4">
                      <p className="text-sm text-gray-400 mb-2">{t("departments.noAIEmployees")}</p>
                      <Link href="/ai-studio/agents/new" className="text-sm text-violet-600 hover:text-violet-700 font-medium">
                        {t("departments.createAIEmployee")}
                      </Link>
                    </div>
                  )}
                </div>
              </>
            )}

            <button
              onClick={() => { setAssignDept(null); setCurrentAIEmployee(null); setAIEmployeeList([]); }}
              className="w-full mt-4 py-2.5 text-sm text-gray-500 hover:text-gray-700 bg-gray-50 hover:bg-gray-100 rounded-xl transition"
            >
              {t("common.back")}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
