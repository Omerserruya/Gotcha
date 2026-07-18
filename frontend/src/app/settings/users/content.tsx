"use client";

import { useState, useEffect, useCallback, useMemo, FormEvent } from "react";
import clsx from "clsx";
import { useAuth } from "@/context/AuthContext";
import { usePermissions } from "@/context/PermissionsContext";
import {
  getAgents,
  getTenantMembers,
  getMembersLoginStatus,
  type MemberLoginStatus,
  createAgent,
  updateAgent,
  deleteAgent,
  resetAgentPassword,
  getDepartments,
  assignAgentToDepartment,
  removeAgentFromDepartment,
  getTenantRoles,
  createTenantRole,
  updateTenantRole,
  deleteTenantRole,
  setTenantRoleFeatures,
  getPermissionCatalog,
  getUserAccess,
  setUserPrimaryRole,
  setUserGrant,
  deleteUserGrant,
  type TenantRole,
  type PermissionDef,
  type PermissionCatalog,
  type UserAccessView,
} from "@/lib/api";
import ConfirmModal from "@/components/ConfirmModal";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface AgentRow {
  id: string;
  name: string;
  email: string;
  isActive: boolean;
  phoneNumber?: string | null;
  /** Legacy enum (ADMIN/AGENT) - fallback only. */
  legacyRole?: string;
  departmentId?: string | null;
  departmentRole?: string | null;
  departmentName?: string | null;
  /** Assigned built-in/custom role (new model). */
  roleId?: string | null;
  roleName?: string | null;
  roleBuiltinKey?: string | null;
  scope?: ScopeValue | null;
}

type ScopeValue = "OWN" | "TEAM" | "DEPARTMENT" | "WORKSPACE";
type PanelMode = "create" | "edit";
type MainTab = "members" | "roles";

// ─── Shared helpers ─────────────────────────────────────────────────────────────

/** Expand a single permission pattern against the catalog key universe. */
function expandPattern(pattern: string, allKeys: string[]): string[] {
  if (pattern === "*") return allKeys;
  if (pattern.endsWith(":*")) {
    const prefix = pattern.slice(0, -1);
    return allKeys.filter((k) => k.startsWith(prefix));
  }
  return allKeys.includes(pattern) ? [pattern] : [];
}

function expandPatterns(patterns: string[], allKeys: string[]): Set<string> {
  const result = new Set<string>();
  for (const p of patterns) {
    for (const k of expandPattern(p, allKeys)) result.add(k);
  }
  return result;
}

const SCOPE_LABELS: Record<ScopeValue, string> = {
  OWN: "Own",
  TEAM: "Team",
  DEPARTMENT: "Department",
  WORKSPACE: "Workspace",
};
const SCOPE_ORDER: ScopeValue[] = ["OWN", "TEAM", "DEPARTMENT", "WORKSPACE"];

type PermSource = "inherited" | "additional" | "revoked" | "none";

function SourceBadge({ source }: { source: PermSource }) {
  if (source === "inherited")
    return (
      <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-blue-50 text-blue-600 ring-1 ring-blue-200 whitespace-nowrap">
        Inherited from Role
      </span>
    );
  if (source === "additional")
    return (
      <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-green-50 text-green-600 ring-1 ring-green-200 whitespace-nowrap">
        Additional
      </span>
    );
  if (source === "revoked")
    return (
      <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-red-50 text-red-600 ring-1 ring-red-200 whitespace-nowrap">
        Revoked
      </span>
    );
  return null;
}

function KindBadge({ kind }: { kind: "runtime" | "configuration" }) {
  return kind === "configuration" ? (
    <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-slate-100 text-slate-500">
      Config
    </span>
  ) : (
    <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-orange-50 text-orange-500">
      Runtime
    </span>
  );
}

function roleBadgeColor(role?: string | null): string {
  const r = (role ?? "").toUpperCase();
  if (r === "ADMIN" || r === "OWNER") return "bg-primary-50 text-primary-600 ring-primary-200";
  if (r === "AGENT") return "bg-blue-50 text-blue-600 ring-blue-200";
  if (r === "DEPARTMENT_MANAGER" || r === "MANAGER") return "bg-violet-50 text-violet-600 ring-violet-200";
  return "bg-gray-100 text-gray-500 ring-gray-200";
}

function roleDisplayName(role?: string | null): string {
  const raw = (role ?? "").replace(/_/g, " ").trim();
  if (!raw) return "-";
  return raw
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

// ─── Top-level spinner / empty ─────────────────────────────────────────────────

function Spinner({ size = 6 }: { size?: number }) {
  return (
    <div
      className={`w-${size} h-${size} border-2 border-primary-200 border-t-primary-500 rounded-full animate-spin`}
    />
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// Main export
// ════════════════════════════════════════════════════════════════════════════════

export function UsersContent() {
  const { token, user: currentUser } = useAuth();
  const { refresh: refreshPermissions } = usePermissions();

  // ── Shared data ─────────────────────────────────────────────────────────────
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [departments, setDepartments] = useState<any[]>([]);
  const [tenantRoles, setTenantRoles] = useState<TenantRole[]>([]);
  const [catalog, setCatalog] = useState<PermissionCatalog | null>(null);
  const [loading, setLoading] = useState(true);

  // ── Tab ─────────────────────────────────────────────────────────────────────
  const [mainTab, setMainTab] = useState<MainTab>("members");

  // ── Toast ───────────────────────────────────────────────────────────────────
  const [toast, setToast] = useState("");
  const [toastType, setToastType] = useState<"success" | "error">("success");

  function notify(msg: string, type: "success" | "error" = "success") {
    setToast(msg);
    setToastType(type);
    setTimeout(() => setToast(""), 4000);
  }

  // ── Initial load ────────────────────────────────────────────────────────────
  const fetchAll = useCallback(async () => {
    if (!token) return;
    try {
      const [membersRes, deptsRes, rolesRes, catalogRes] = await Promise.all([
        getTenantMembers(token),
        getDepartments(token),
        getTenantRoles(token),
        getPermissionCatalog(token),
      ]);
      setAgents(membersRes.data as AgentRow[]);
      setDepartments((deptsRes as any)?.data ?? []);
      setTenantRoles(rolesRes.data);
      setCatalog(catalogRes.data);
    } catch (err) {
      console.error("Failed to load data:", err);
      notify("Failed to load data", "error");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="p-3 md:p-6 overflow-y-auto h-full">
      {/* Toast */}
      {toast && (
        <div
          className={clsx(
            "fixed top-4 end-4 z-[60] px-4 py-2.5 rounded-xl text-sm font-medium shadow-lg ring-1 transition-all",
            toastType === "success"
              ? "bg-green-50 text-green-700 ring-green-200"
              : "bg-red-50 text-red-700 ring-red-200",
          )}
        >
          {toast}
        </div>
      )}

      {/* Page header + tab switcher */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-5">
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-gray-900">
            Users &amp; Roles
          </h1>
          <p className="text-xs text-gray-400 mt-0.5">
            Manage workspace members, roles, and permission overrides.
          </p>
        </div>
        <div className="flex bg-gray-100 rounded-xl p-1 text-xs font-medium self-start sm:self-auto">
          <button
            onClick={() => setMainTab("members")}
            className={clsx(
              "px-4 py-2 rounded-lg transition",
              mainTab === "members"
                ? "bg-white text-gray-900 shadow-sm"
                : "text-gray-500 hover:text-gray-700",
            )}
          >
            Members
            {!loading && (
              <span className="ms-1.5 text-[10px] text-gray-400 font-normal">
                {agents.length}
              </span>
            )}
          </button>
          <button
            onClick={() => setMainTab("roles")}
            className={clsx(
              "px-4 py-2 rounded-lg transition",
              mainTab === "roles"
                ? "bg-white text-gray-900 shadow-sm"
                : "text-gray-500 hover:text-gray-700",
            )}
          >
            Roles
            {!loading && (
              <span className="ms-1.5 text-[10px] text-gray-400 font-normal">
                {tenantRoles.length}
              </span>
            )}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Spinner size={7} />
        </div>
      ) : mainTab === "members" ? (
        <MembersTab
          token={token!}
          currentUserId={currentUser?.id}
          agents={agents}
          departments={departments}
          tenantRoles={tenantRoles}
          catalog={catalog}
          onRefresh={fetchAll}
          onRefreshPermissions={refreshPermissions}
          notify={notify}
        />
      ) : (
        <RolesTab
          token={token!}
          currentUserId={currentUser?.id}
          tenantRoles={tenantRoles}
          catalog={catalog}
          onRefresh={fetchAll}
          onRefreshPermissions={refreshPermissions}
          notify={notify}
        />
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// TAB 1 - Members
// ════════════════════════════════════════════════════════════════════════════════

interface MembersTabProps {
  token: string;
  currentUserId?: string;
  agents: AgentRow[];
  departments: any[];
  tenantRoles: TenantRole[];
  catalog: PermissionCatalog | null;
  onRefresh: () => Promise<void>;
  onRefreshPermissions: () => void;
  notify: (msg: string, type?: "success" | "error") => void;
}

/** Member status pill: Invited (never signed in) / Active / Inactive, with a
 *  last-login hint sourced from Authentik. Falls back to the plain active flag
 *  until the lazy login-status load resolves. */
function MemberStatusBadge({ agent, status }: { agent: AgentRow; status?: MemberLoginStatus }) {
  if (!agent.isActive || status?.status === "disabled") {
    return <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-500">Inactive</span>;
  }
  if (status?.status === "invited") {
    return <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-amber-50 text-amber-600 ring-1 ring-amber-200" title="Invite sent - hasn't signed in yet">Invited</span>;
  }
  const title = status?.lastLogin ? `Last sign-in: ${new Date(status.lastLogin).toLocaleString()}` : undefined;
  return <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-green-50 text-green-600 ring-1 ring-green-200" title={title}>Active</span>;
}

function MembersTab({
  token,
  currentUserId,
  agents,
  departments,
  tenantRoles,
  catalog,
  onRefresh,
  onRefreshPermissions,
  notify,
}: MembersTabProps) {
  const [search, setSearch] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelMode, setPanelMode] = useState<PanelMode>("create");
  const [panelAgent, setPanelAgent] = useState<AgentRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AgentRow | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  // Lazy-loaded invitation/login status (from Authentik) - keeps the main list
  // fast while surfacing "Invited / never signed in" and last-login per member.
  const [loginStatus, setLoginStatus] = useState<Record<string, MemberLoginStatus>>({});
  useEffect(() => {
    let live = true;
    getMembersLoginStatus(token).then((m) => { if (live) setLoginStatus(m); }).catch(() => {});
    return () => { live = false; };
  }, [token, agents.length]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter(
      (a) => a.name.toLowerCase().includes(q) || a.email.toLowerCase().includes(q),
    );
  }, [agents, search]);

  function openCreate() {
    setPanelMode("create");
    setPanelAgent(null);
    setPanelOpen(true);
  }

  function openEdit(agent: AgentRow) {
    setPanelMode("edit");
    setPanelAgent(agent);
    setPanelOpen(true);
  }

  function closePanel() {
    setPanelOpen(false);
    setPanelAgent(null);
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      await deleteAgent(token, deleteTarget.id);
      notify(`${deleteTarget.name} removed`);
      setDeleteTarget(null);
      closePanel();
      await onRefresh();
    } catch (err: unknown) {
      notify(err instanceof Error ? err.message : "Failed to delete user", "error");
    } finally {
      setDeleteLoading(false);
    }
  }

  return (
    <>
      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-sm">
          <svg
            className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none"
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or email…"
            className="w-full ps-9 pe-4 py-2 bg-white border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 outline-none transition"
          />
        </div>
        <button
          onClick={openCreate}
          data-tour="invite-teammate"
          className="bg-primary-500 hover:bg-primary-600 text-white px-3 md:px-4 py-2 rounded-xl text-sm font-medium transition shadow-sm flex items-center gap-2 shrink-0"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 7.5v3m0 0v3m0-3h3m-3 0h-3m-2.25-4.125a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zM4 19.235v-.11a6.375 6.375 0 0112.75 0v.109A12.318 12.318 0 0110.374 21c-2.331 0-4.512-.645-6.374-1.766z" />
          </svg>
          <span className="hidden sm:inline">Add user</span>
        </button>
      </div>

      {/* Desktop table */}
      <div className="hidden md:block bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50/80">
            <tr>
              <th className="text-start py-3.5 px-5 font-medium text-gray-500 text-xs uppercase tracking-wide">Name</th>
              <th className="text-start py-3.5 px-5 font-medium text-gray-500 text-xs uppercase tracking-wide">Email</th>
              <th className="text-start py-3.5 px-5 font-medium text-gray-500 text-xs uppercase tracking-wide">Department</th>
              <th className="text-start py-3.5 px-5 font-medium text-gray-500 text-xs uppercase tracking-wide">Status</th>
              <th className="text-start py-3.5 px-5 font-medium text-gray-500 text-xs uppercase tracking-wide">Role</th>
              <th className="py-3.5 px-5" />
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-12 text-center text-gray-400 text-sm">
                  {search ? "No users match your search." : "No users found."}
                </td>
              </tr>
            ) : (
              filtered.map((agent) => (
                <tr
                  key={agent.id}
                  onClick={() => openEdit(agent)}
                  className="border-t border-gray-50 hover:bg-gray-50/50 transition cursor-pointer"
                >
                  <td className="py-3.5 px-5">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 bg-gradient-to-br from-primary-100 to-primary-200 rounded-lg flex items-center justify-center shrink-0">
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
                      <span className="text-xs text-gray-300">-</span>
                    )}
                  </td>
                  <td className="py-3.5 px-5">
                    <MemberStatusBadge agent={agent} status={loginStatus[agent.id]} />
                  </td>
                  <td className="py-3.5 px-5">
                    <span className={clsx("px-2.5 py-1 rounded-full text-xs font-medium ring-1", roleBadgeColor(agent.roleBuiltinKey ?? agent.legacyRole))}>
                      {agent.roleName ?? roleDisplayName(agent.legacyRole)}
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

      {/* Mobile cards */}
      <div className="md:hidden space-y-3">
        {filtered.length === 0 ? (
          <div className="py-12 text-center text-gray-400 text-sm">
            {search ? "No users match your search." : "No users found."}
          </div>
        ) : (
          filtered.map((agent) => (
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
                  <span className={clsx("px-2 py-0.5 rounded-full text-[10px] font-medium", agent.isActive ? "bg-green-50 text-green-600" : "bg-gray-100 text-gray-500")}>
                    {agent.isActive ? "Active" : "Inactive"}
                  </span>
                  <span className={clsx("px-2 py-0.5 rounded-full text-[10px] font-medium ring-1", roleBadgeColor(agent.roleBuiltinKey ?? agent.legacyRole))}>
                    {agent.roleName ?? roleDisplayName(agent.legacyRole)}
                  </span>
                </div>
              </div>
            </button>
          ))
        )}
      </div>

      {/* Side panel */}
      {panelOpen && (
        <MemberPanel
          token={token}
          currentUserId={currentUserId}
          mode={panelMode}
          agent={panelAgent}
          departments={departments}
          tenantRoles={tenantRoles}
          catalog={catalog}
          onClose={closePanel}
          onRefresh={onRefresh}
          onRefreshPermissions={onRefreshPermissions}
          onDeleteRequest={(a) => setDeleteTarget(a)}
          notify={notify}
        />
      )}

      {/* Delete confirm */}
      <ConfirmModal
        isOpen={!!deleteTarget}
        title="Remove user"
        message={`Remove ${deleteTarget?.name ?? "this user"} from the workspace? This cannot be undone.`}
        confirmText="Remove"
        danger
        loading={deleteLoading}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  );
}

// ────────────────────────────────────────────────────────────────────────────────
// Member side panel (create + edit)
// ────────────────────────────────────────────────────────────────────────────────

interface MemberPanelProps {
  token: string;
  currentUserId?: string;
  mode: PanelMode;
  agent: AgentRow | null;
  departments: any[];
  tenantRoles: TenantRole[];
  catalog: PermissionCatalog | null;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onRefreshPermissions: () => void;
  onDeleteRequest: (a: AgentRow) => void;
  notify: (msg: string, type?: "success" | "error") => void;
}

function MemberPanel({
  token,
  currentUserId,
  mode,
  agent,
  departments,
  tenantRoles,
  catalog,
  onClose,
  onRefresh,
  onRefreshPermissions,
  onDeleteRequest,
  notify,
}: MemberPanelProps) {
  // ── Profile form fields ──────────────────────────────────────────────────────
  const [formName, setFormName] = useState(agent?.name ?? "");
  const [formEmail, setFormEmail] = useState(agent?.email ?? "");
  const [formPhone, setFormPhone] = useState(agent?.phoneNumber ?? "");
  const [formDeptId, setFormDeptId] = useState(agent?.departmentId ?? "");
  const [formRoleId, setFormRoleId] = useState<string>("");
  const [formScope, setFormScope] = useState<ScopeValue | null>(null);
  const [formLoading, setFormLoading] = useState(false);
  const [formError, setFormError] = useState("");

  // Reset password (edit only)
  const [showReset, setShowReset] = useState(false);
  const [setupLink, setSetupLink] = useState("");
  const [resetLoading, setResetLoading] = useState(false);
  const [resetSuccess, setResetSuccess] = useState(false);

  // Access data (edit only)
  const [userAccess, setUserAccess] = useState<UserAccessView | null>(null);
  const [accessLoading, setAccessLoading] = useState(false);
  const [roleSaving, setRoleSaving] = useState(false);
  const [roleError, setRoleError] = useState("");
  const [permSaving, setPermSaving] = useState<Record<string, boolean>>({});

  // ── Load access for existing user ───────────────────────────────────────────
  const fetchAccess = useCallback(async (userId: string) => {
    setAccessLoading(true);
    try {
      const res = await getUserAccess(token, userId);
      const access = res.data;
      setUserAccess(access);
      // Seed scope/role from loaded access
      setFormRoleId(access.roles?.[0]?.roleId ?? "");
      setFormScope(access.roles?.[0]?.scope ?? null);
    } catch {
      notify("Failed to load user access", "error");
    } finally {
      setAccessLoading(false);
    }
  }, [token, notify]);

  useEffect(() => {
    if (mode === "edit" && agent) fetchAccess(agent.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Computed inherited perms ────────────────────────────────────────────────
  const currentRoleId = userAccess?.roles?.[0]?.roleId ?? null;
  const currentScopeOverride = userAccess?.roles?.[0]?.scope ?? null;

  const inheritedPerms = useMemo((): Set<string> => {
    if (!catalog || !userAccess) return new Set();
    const allKeys = catalog.permissions.map((p) => p.key);
    const roleId = userAccess.roles?.[0]?.roleId;
    const tenantRole = tenantRoles.find((r) => r.id === roleId);
    if (tenantRole?.builtinKey) {
      const builtinDef = catalog.builtinRoles.find((b) => b.key === tenantRole.builtinKey);
      if (builtinDef) return expandPatterns(builtinDef.permissions, allKeys);
    }
    if (tenantRole) return expandPatterns(tenantRole.features.map((f) => f.feature), allKeys);
    return new Set();
  }, [catalog, userAccess, tenantRoles]);

  function grantFor(key: string) {
    return userAccess?.grants.find((g) => g.feature === key) ?? null;
  }

  function permSource(key: string): PermSource {
    const grant = grantFor(key);
    if (grant !== null) return grant.granted ? "additional" : "revoked";
    return inheritedPerms.has(key) ? "inherited" : "none";
  }

  // ── Handlers ────────────────────────────────────────────────────────────────

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!formName.trim()) return;
    setFormLoading(true);
    setFormError("");
    try {
      if (mode === "create") {
        if (!formEmail.trim()) { setFormError("Name and email are required."); return; }
        const res = await createAgent(token, { name: formName.trim(), email: formEmail.trim() });
        const newId = (res as any)?.user?.id ?? (res as any)?.id;
        if (formDeptId && newId) {
          await assignAgentToDepartment(token, formDeptId, newId).catch(() => {});
        }
        if (formRoleId && newId) {
          await setUserPrimaryRole(token, newId, { roleId: formRoleId, scope: formScope }).catch(() => {});
        }
        notify(`${formName.trim()} added`);
      } else {
        if (!agent) return;
        await updateAgent(token, agent.id, {
          name: formName.trim(),
          phoneNumber: formPhone.trim() || null,
        });
        const prevDeptId = agent.departmentId ?? "";
        if (formDeptId !== prevDeptId) {
          if (prevDeptId) await removeAgentFromDepartment(token, prevDeptId, agent.id).catch(() => {});
          if (formDeptId) await assignAgentToDepartment(token, formDeptId, agent.id).catch(() => {});
        }
        notify("Profile updated");
      }
      await onRefresh();
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "An error occurred";
      setFormError(msg);
    } finally {
      setFormLoading(false);
    }
  }

  async function handleToggleActive() {
    if (!agent) return;
    try {
      await updateAgent(token, agent.id, { isActive: !agent.isActive });
      await onRefresh();
      notify(agent.isActive ? "User deactivated" : "User activated");
    } catch (err: unknown) {
      notify(err instanceof Error ? err.message : "Failed to update status", "error");
    }
  }

  async function handleResetPassword() {
    if (!agent) return;
    setResetLoading(true);
    try {
      const res = await resetAgentPassword(token, agent.id);
      setSetupLink(res.setupLink);
      setResetSuccess(true);
    } catch (err: unknown) {
      notify(err instanceof Error ? err.message : "Failed to reset password", "error");
    } finally {
      setResetLoading(false);
    }
  }

  async function handleSetRole(roleId: string) {
    if (!agent) return;
    setRoleSaving(true);
    setRoleError("");
    try {
      await setUserPrimaryRole(token, agent.id, { roleId, scope: currentScopeOverride ?? null });
      await fetchAccess(agent.id);
      if (currentUserId === agent.id) onRefreshPermissions();
      notify("Role updated");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to update role";
      setRoleError(msg);
    } finally {
      setRoleSaving(false);
    }
  }

  async function handleSetScope(scope: ScopeValue | null) {
    if (!agent || !currentRoleId) return;
    setRoleSaving(true);
    setRoleError("");
    try {
      await setUserPrimaryRole(token, agent.id, { roleId: currentRoleId, scope });
      await fetchAccess(agent.id);
      if (currentUserId === agent.id) onRefreshPermissions();
      notify("Scope updated");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to update scope";
      setRoleError(msg);
    } finally {
      setRoleSaving(false);
    }
  }

  async function handlePermClick(key: string) {
    if (!agent) return;
    const source = permSource(key);
    setPermSaving((s) => ({ ...s, [key]: true }));
    try {
      if (source === "inherited") {
        await setUserGrant(token, agent.id, key, { granted: false, reason: "Manually revoked" });
      } else if (source === "none") {
        await setUserGrant(token, agent.id, key, { granted: true, reason: "Manually granted" });
      } else {
        await deleteUserGrant(token, agent.id, key);
      }
      await fetchAccess(agent.id);
      if (currentUserId === agent.id) onRefreshPermissions();
    } catch (err: unknown) {
      notify(err instanceof Error ? err.message : "Failed to update permission", "error");
    } finally {
      setPermSaving((s) => ({ ...s, [key]: false }));
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────────
  const isCreate = mode === "create";

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <div className="relative ms-auto w-full max-w-[480px] bg-white h-full flex flex-col shadow-2xl animate-slide-in-right">

        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-3 shrink-0">
          {!isCreate && (
            <div className="w-10 h-10 bg-gradient-to-br from-primary-100 to-primary-200 rounded-xl flex items-center justify-center shrink-0">
              <span className="text-sm font-bold text-primary-600">
                {(agent?.name ?? "?").charAt(0).toUpperCase()}
              </span>
            </div>
          )}
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-bold text-gray-900 truncate">
              {isCreate ? "Add user" : agent?.name}
            </h3>
            {!isCreate && <p className="text-xs text-gray-400 truncate">{agent?.email}</p>}
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition shrink-0"
            aria-label="Close panel"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-6">

          {/* ── Profile form ─────────────────────────────────────────────────── */}
          <section>
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
              {isCreate ? "User details" : "Profile"}
            </h4>
            <form id="member-form" onSubmit={handleSubmit} className="space-y-3.5">
              {formError && (
                <div className="p-3 rounded-xl bg-red-50 text-red-600 text-sm">{formError}</div>
              )}

              {/* Name */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Name</label>
                <input
                  type="text"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  required
                  autoFocus
                  className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition"
                />
              </div>

              {/* Email */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Email</label>
                <input
                  type="email"
                  value={formEmail}
                  onChange={(e) => setFormEmail(e.target.value)}
                  required={isCreate}
                  disabled={!isCreate}
                  className={clsx(
                    "w-full px-4 py-2.5 border border-gray-200 rounded-xl text-sm outline-none transition",
                    !isCreate ? "bg-gray-100 text-gray-400 cursor-not-allowed" : "bg-gray-50 focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white",
                  )}
                />
              </div>

              {/* Phone (edit only) */}
              {!isCreate && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Phone number</label>
                  <input
                    type="tel"
                    value={formPhone}
                    onChange={(e) => setFormPhone(e.target.value)}
                    placeholder="+972501234567"
                    className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition font-mono"
                  />
                  <p className="mt-1 text-[11px] text-gray-400">Used for voice channel routing and smart callbacks.</p>
                </div>
              )}

              {isCreate && (
                <p className="text-xs text-gray-500">
                  They will set their own password on our secure sign-in service.
                  You will get a one-time setup link to share with them.
                </p>
              )}

              {/* Department */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Department</label>
                <select
                  value={formDeptId}
                  onChange={(e) => setFormDeptId(e.target.value)}
                  className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition"
                >
                  <option value="">No department</option>
                  {departments.map((d: any) => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </div>

              {/* Role select (create only - edit uses the rich role section below) */}
              {isCreate && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Role</label>
                  <select
                    value={formRoleId}
                    onChange={(e) => setFormRoleId(e.target.value)}
                    className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition"
                  >
                    <option value="">Select a role…</option>
                    {tenantRoles.map((r) => (
                      <option key={r.id} value={r.id}>{r.name}</option>
                    ))}
                  </select>
                </div>
              )}
            </form>
          </section>

          {/* ── Edit-only sections ───────────────────────────────────────────── */}
          {!isCreate && agent && (
            <>
              {/* Status toggle */}
              <section>
                <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Status</h4>
                <div className="flex items-center justify-between p-4 bg-gray-50 rounded-xl">
                  <div>
                    <p className="text-sm font-medium text-gray-700">{agent.isActive ? "Active" : "Inactive"}</p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {agent.isActive ? "User can sign in and receive conversations." : "User is suspended and cannot sign in."}
                    </p>
                  </div>
                  <button
                    onClick={handleToggleActive}
                    className={clsx("relative w-11 h-6 rounded-full transition-colors", agent.isActive ? "bg-green-500" : "bg-gray-300")}
                    aria-label="Toggle active"
                  >
                    <span
                      className="absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform"
                      style={{ transform: agent.isActive ? "translateX(22px)" : "translateX(2px)" }}
                    />
                  </button>
                </div>
              </section>

              {/* Reset password */}
              <section>
                <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Security</h4>
                <div className="border border-gray-200 rounded-xl overflow-hidden">
                  <button
                    onClick={() => setShowReset(!showReset)}
                    className="w-full flex items-center justify-between p-4 text-start hover:bg-gray-50 transition"
                  >
                    <div className="flex items-center gap-2.5">
                      <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                      </svg>
                      <span className="text-sm font-medium text-gray-700">Reset password</span>
                    </div>
                    <svg className={clsx("w-4 h-4 text-gray-400 transition-transform", showReset && "rotate-180")} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                    </svg>
                  </button>
                  {showReset && (
                    <div className="px-4 pb-4 space-y-3">
                      <p className="text-xs text-gray-500">
                        Generate a one-time link this person can use to set a new
                        password. You never see or choose their password.
                      </p>
                      <button
                        onClick={handleResetPassword}
                        disabled={resetLoading}
                        className="w-full py-2 bg-amber-500 hover:bg-amber-600 text-white text-sm font-medium rounded-xl transition disabled:opacity-50"
                      >
                        {resetLoading ? "Creating link…" : "Generate password setup link"}
                      </button>
                      {resetSuccess && setupLink && (
                        <div className="space-y-1.5">
                          <p className="text-xs text-green-600">Link created. It can be used once.</p>
                          <input
                            readOnly
                            value={setupLink}
                            onFocus={(e) => e.currentTarget.select()}
                            className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-xs font-mono"
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </section>

              {/* Role section */}
              {accessLoading ? (
                <div className="flex items-center justify-center py-8"><Spinner /></div>
              ) : (
                <>
                  <section>
                    <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Role</h4>
                    {roleError && <div className="mb-2 p-3 rounded-xl bg-red-50 text-red-600 text-sm">{roleError}</div>}
                    <div className="space-y-2">
                      {catalog?.builtinRoles.map((br) => {
                        const matched = tenantRoles.find((tr) => tr.builtinKey === br.key);
                        const isSelected = matched?.id === currentRoleId;
                        return (
                          <button
                            key={br.key}
                            onClick={() => matched && handleSetRole(matched.id)}
                            disabled={roleSaving || !matched}
                            className={clsx(
                              "w-full text-start p-3.5 rounded-xl border transition",
                              isSelected ? "border-primary-300 bg-primary-50/60 ring-1 ring-primary-200" : "border-gray-200 bg-white hover:border-primary-200 hover:bg-primary-50/30",
                              "disabled:opacity-50 disabled:cursor-not-allowed",
                            )}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <p className="text-sm font-semibold text-gray-900">{br.name}</p>
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 font-medium">{br.defaultScope}</span>
                                </div>
                                <p className="text-xs text-gray-500 mt-0.5">{br.description}</p>
                              </div>
                              <div className={clsx("w-4 h-4 rounded-full border-2 shrink-0 mt-0.5 transition", isSelected ? "border-primary-500 bg-primary-500" : "border-gray-300")}>
                                {isSelected && (
                                  <svg className="w-2.5 h-2.5 text-white m-auto mt-[1px]" viewBox="0 0 10 10">
                                    <path d="M8.5 2.5L4 7 1.5 4.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                                  </svg>
                                )}
                              </div>
                            </div>
                          </button>
                        );
                      })}
                      {tenantRoles.filter((tr) => !tr.builtinKey).map((tr) => {
                        const isSelected = tr.id === currentRoleId;
                        return (
                          <button
                            key={tr.id}
                            onClick={() => handleSetRole(tr.id)}
                            disabled={roleSaving}
                            className={clsx(
                              "w-full text-start p-3.5 rounded-xl border transition",
                              isSelected ? "border-primary-300 bg-primary-50/60 ring-1 ring-primary-200" : "border-gray-200 bg-white hover:border-primary-200 hover:bg-primary-50/30",
                              "disabled:opacity-50 disabled:cursor-not-allowed",
                            )}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <p className="text-sm font-semibold text-gray-900">{tr.name}</p>
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 font-medium">Custom</span>
                                </div>
                                {tr.description && <p className="text-xs text-gray-500 mt-0.5">{tr.description}</p>}
                              </div>
                              <div className={clsx("w-4 h-4 rounded-full border-2 shrink-0 mt-0.5 transition", isSelected ? "border-primary-500 bg-primary-500" : "border-gray-300")} />
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </section>

                  {/* Scope */}
                  <section>
                    <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Scope Override</h4>
                    <p className="text-xs text-gray-400 mb-3">"Inherit" uses the role's default scope.</p>
                    <div className="flex bg-gray-100 rounded-xl p-1 text-xs font-medium gap-0.5">
                      <button
                        onClick={() => handleSetScope(null)}
                        disabled={roleSaving || !currentRoleId}
                        className={clsx("flex-1 py-1.5 px-1 rounded-lg transition text-center truncate", currentScopeOverride === null ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700", "disabled:opacity-40")}
                      >Inherit</button>
                      {SCOPE_ORDER.map((s) => (
                        <button
                          key={s}
                          onClick={() => handleSetScope(s)}
                          disabled={roleSaving || !currentRoleId}
                          className={clsx("flex-1 py-1.5 px-1 rounded-lg transition text-center truncate", currentScopeOverride === s ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700", "disabled:opacity-40")}
                        >{SCOPE_LABELS[s]}</button>
                      ))}
                    </div>
                  </section>

                  {/* Additional Permissions */}
                  <section>
                    <div className="flex items-baseline justify-between mb-1">
                      <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Additional Permissions</h4>
                      {userAccess && <span className="text-xs text-gray-400">Effective: {userAccess.permissions.length}</span>}
                    </div>
                    <p className="text-xs text-gray-400 mb-4">
                      Click to cycle state. Inherited → Revoked → (clear) or None → Granted → (clear).
                    </p>
                    {catalog ? (
                      <div className="space-y-5">
                        {Object.entries(catalog.byDomain).sort(([a], [b]) => a.localeCompare(b)).map(([domain, perms]) => (
                          <div key={domain}>
                            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-2">{domain}</p>
                            <div className="space-y-1.5">
                              {(perms as PermissionDef[]).map((perm) => {
                                const source = permSource(perm.key);
                                const saving = permSaving[perm.key] ?? false;
                                return (
                                  <button
                                    key={perm.key}
                                    onClick={() => handlePermClick(perm.key)}
                                    disabled={saving}
                                    className={clsx(
                                      "w-full text-start flex items-start gap-3 p-3 rounded-xl border transition",
                                      source === "additional" ? "border-green-200 bg-green-50/40" :
                                        source === "revoked" ? "border-red-200 bg-red-50/30" :
                                          source === "inherited" ? "border-blue-100 bg-blue-50/20" :
                                            "border-gray-100 bg-white hover:border-gray-200",
                                      "disabled:opacity-60 disabled:cursor-not-allowed",
                                    )}
                                  >
                                    <div className={clsx("w-2 h-2 rounded-full shrink-0 mt-1.5",
                                      source === "additional" ? "bg-green-500" :
                                        source === "revoked" ? "bg-red-400" :
                                          source === "inherited" ? "bg-blue-400" : "bg-gray-200")} />
                                    <div className="flex-1 min-w-0">
                                      <div className="flex items-center gap-1.5 flex-wrap">
                                        <span className="text-xs font-medium text-gray-900">{perm.displayName}</span>
                                        <KindBadge kind={perm.kind} />
                                      </div>
                                      <p className="text-[11px] text-gray-400 mt-0.5 leading-relaxed">{perm.description}</p>
                                    </div>
                                    <div className="shrink-0 pt-0.5">
                                      {saving ? <div className="w-3 h-3 border border-gray-300 border-t-gray-600 rounded-full animate-spin" /> : <SourceBadge source={source} />}
                                    </div>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="flex items-center justify-center py-8"><Spinner /></div>
                    )}
                  </section>

                  {/* Danger zone */}
                  <section>
                    <div className="border border-red-200 rounded-xl p-4">
                      <p className="text-xs font-semibold text-red-500 uppercase tracking-wider mb-2">Danger zone</p>
                      <button
                        onClick={() => onDeleteRequest(agent)}
                        className="w-full py-2.5 bg-red-50 text-red-600 text-sm font-medium rounded-xl hover:bg-red-100 transition flex items-center justify-center gap-2"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                        Remove user
                      </button>
                    </div>
                  </section>
                </>
              )}
            </>
          )}
        </div>

        {/* Footer: save profile */}
        <div className="px-5 py-4 border-t border-gray-100 shrink-0">
          <button
            type="submit"
            form="member-form"
            disabled={formLoading}
            className="w-full py-3 bg-primary-500 text-white text-sm font-semibold rounded-xl hover:bg-primary-600 disabled:opacity-50 transition flex items-center justify-center gap-2 shadow-sm"
          >
            {formLoading ? (
              <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Saving…</>
            ) : isCreate ? "Add user" : "Save profile"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// TAB 2 - Roles
// ════════════════════════════════════════════════════════════════════════════════

interface RolesTabProps {
  token: string;
  currentUserId?: string;
  tenantRoles: TenantRole[];
  catalog: PermissionCatalog | null;
  onRefresh: () => Promise<void>;
  onRefreshPermissions: () => void;
  notify: (msg: string, type?: "success" | "error") => void;
}

function RolesTab({ token, tenantRoles, catalog, onRefresh, notify }: RolesTabProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [createLoading, setCreateLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<TenantRole | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Separate built-ins (have builtinKey) from custom
  const builtinRoles = tenantRoles.filter((r) => r.builtinKey);
  const customRoles = tenantRoles.filter((r) => !r.builtinKey);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreateLoading(true);
    try {
      await createTenantRole(token, { name: newName.trim(), description: newDesc.trim() || undefined });
      notify(`Role "${newName}" created`);
      setNewName("");
      setNewDesc("");
      setCreating(false);
      await onRefresh();
    } catch (err: unknown) {
      notify(err instanceof Error ? err.message : "Failed to create role", "error");
    } finally {
      setCreateLoading(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      await deleteTenantRole(token, deleteTarget.id);
      notify(`Role "${deleteTarget.name}" deleted`);
      setDeleteTarget(null);
      if (expandedId === deleteTarget.id) setExpandedId(null);
      await onRefresh();
    } catch (err: unknown) {
      notify(err instanceof Error ? err.message : "Failed to delete role", "error");
    } finally {
      setDeleteLoading(false);
    }
  }

  if (!catalog) return <div className="flex items-center justify-center py-20"><Spinner size={7} /></div>;

  return (
    <>
      <div className="space-y-3">
        {/* Built-in roles */}
        <div>
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-2 ps-1">System roles</p>
          <div className="space-y-2">
            {builtinRoles.map((role) => (
              <RoleRow
                key={role.id}
                token={token}
                role={role}
                catalog={catalog}
                expanded={expandedId === role.id}
                onToggle={() => setExpandedId(expandedId === role.id ? null : role.id)}
                onDeleteRequest={null}
                onSaved={onRefresh}
                notify={notify}
              />
            ))}
          </div>
        </div>

        {/* Custom roles */}
        <div>
          <div className="flex items-center justify-between mb-2 ps-1">
            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Custom roles</p>
            <button
              onClick={() => setCreating(!creating)}
              className="text-xs px-3 py-1.5 bg-primary-500 text-white rounded-lg hover:bg-primary-600 transition font-medium"
            >
              {creating ? "Cancel" : "+ New role"}
            </button>
          </div>

          {creating && (
            <form onSubmit={handleCreate} className="mb-3 p-4 rounded-xl bg-white border border-gray-200 shadow-sm space-y-3">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                required maxLength={80}
                placeholder="Role name (e.g. Sales Manager)"
                className="w-full text-sm border border-gray-200 rounded-xl px-4 py-2.5 bg-gray-50 focus:ring-2 focus:ring-primary-200 focus:bg-white outline-none transition"
                autoFocus
              />
              <input
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                maxLength={500}
                placeholder="Description (optional)"
                className="w-full text-sm border border-gray-200 rounded-xl px-4 py-2.5 bg-gray-50 focus:ring-2 focus:ring-primary-200 focus:bg-white outline-none transition"
              />
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={createLoading || !newName.trim()}
                  className="text-sm px-4 py-2 bg-primary-500 text-white rounded-xl hover:bg-primary-600 transition font-medium disabled:opacity-50"
                >
                  {createLoading ? "Creating…" : "Create role"}
                </button>
              </div>
            </form>
          )}

          {customRoles.length === 0 && !creating ? (
            <div className="bg-white rounded-2xl border border-gray-100 p-8 text-center text-sm text-gray-400">
              No custom roles yet. Built-in roles cover most use cases; create a custom role for unique permission sets.
            </div>
          ) : (
            <div className="space-y-2">
              {customRoles.map((role) => (
                <RoleRow
                  key={role.id}
                  token={token}
                  role={role}
                  catalog={catalog}
                  expanded={expandedId === role.id}
                  onToggle={() => setExpandedId(expandedId === role.id ? null : role.id)}
                  onDeleteRequest={() => setDeleteTarget(role)}
                  onSaved={onRefresh}
                  notify={notify}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <ConfirmModal
        isOpen={!!deleteTarget}
        title="Delete role"
        message={`Delete "${deleteTarget?.name}"? Users assigned to it will lose its permissions.`}
        confirmText="Delete"
        danger
        loading={deleteLoading}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  );
}

// ────────────────────────────────────────────────────────────────────────────────
// Role row (expandable)
// ────────────────────────────────────────────────────────────────────────────────

interface RoleRowProps {
  token: string;
  role: TenantRole;
  catalog: PermissionCatalog;
  expanded: boolean;
  onToggle: () => void;
  onDeleteRequest: (() => void) | null;
  onSaved: () => Promise<void>;
  notify: (msg: string, type?: "success" | "error") => void;
}

function RoleRow({ token, role, catalog, expanded, onToggle, onDeleteRequest, onSaved, notify }: RoleRowProps) {
  const isSystem = !!role.builtinKey;

  // Selected permissions (keys)
  const allKeys = useMemo(() => catalog.permissions.map((p) => p.key), [catalog]);

  const initial = useMemo(
    () => new Set(role.features.map((f) => f.feature)),
    [role.features],
  );
  const [selected, setSelected] = useState<Set<string>>(initial);
  const [editingMeta, setEditingMeta] = useState(false);
  const [metaName, setMetaName] = useState(role.name);
  const [metaDesc, setMetaDesc] = useState(role.description ?? "");
  const [saving, setSaving] = useState(false);

  // Sync when role data changes (after refresh)
  useEffect(() => {
    setSelected(new Set(role.features.map((f) => f.feature)));
    setMetaName(role.name);
    setMetaDesc(role.description ?? "");
  }, [role]);

  const dirty = useMemo(() => {
    if (selected.size !== initial.size) return true;
    return Array.from(selected).some((k) => !initial.has(k));
  }, [selected, initial]);

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  async function handleSaveFeatures() {
    setSaving(true);
    try {
      await setTenantRoleFeatures(token, role.id, Array.from(selected));
      notify(`"${role.name}" permissions saved`);
      await onSaved();
    } catch (err: unknown) {
      notify(err instanceof Error ? err.message : "Failed to save permissions", "error");
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveMeta(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await updateTenantRole(token, role.id, { name: metaName.trim(), description: metaDesc.trim() || null });
      notify("Role updated");
      setEditingMeta(false);
      await onSaved();
    } catch (err: unknown) {
      notify(err instanceof Error ? err.message : "Failed to update role", "error");
    } finally {
      setSaving(false);
    }
  }

  // Group permissions by domain
  const grouped = useMemo(() => {
    return Object.entries(catalog.byDomain).sort(([a], [b]) => a.localeCompare(b));
  }, [catalog]);

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      {/* Row header */}
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between p-4 hover:bg-gray-50/60 transition text-start"
      >
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-primary-100 to-primary-200 flex items-center justify-center text-xs font-bold text-primary-600 shrink-0">
            {role.name.charAt(0).toUpperCase()}
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-sm font-semibold text-gray-900">{role.name}</p>
              {isSystem && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-gray-100 text-gray-500 ring-1 ring-gray-200">
                  System
                </span>
              )}
              <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-blue-50 text-blue-500 ring-1 ring-blue-200">
                {role.defaultScope}
              </span>
            </div>
            <p className="text-xs text-gray-400 mt-0.5">
              {role.features.length} permission{role.features.length !== 1 ? "s" : ""} ·{" "}
              {role._count?.assignments ?? 0} member{(role._count?.assignments ?? 0) !== 1 ? "s" : ""}
            </p>
          </div>
        </div>
        <svg className={clsx("w-4 h-4 text-gray-400 transition-transform shrink-0", expanded && "rotate-180")} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {/* Expanded body */}
      {expanded && (
        <div className="border-t border-gray-100 p-4 bg-gray-50/40 space-y-5">

          {/* Meta edit (custom only) */}
          {!isSystem && (
            <div>
              {editingMeta ? (
                <form onSubmit={handleSaveMeta} className="space-y-2">
                  <input
                    value={metaName}
                    onChange={(e) => setMetaName(e.target.value)}
                    maxLength={80}
                    required
                    className="w-full text-sm border border-gray-200 rounded-xl px-4 py-2 bg-white focus:ring-2 focus:ring-primary-200 outline-none"
                    placeholder="Role name"
                  />
                  <input
                    value={metaDesc}
                    onChange={(e) => setMetaDesc(e.target.value)}
                    maxLength={500}
                    className="w-full text-sm border border-gray-200 rounded-xl px-4 py-2 bg-white focus:ring-2 focus:ring-primary-200 outline-none"
                    placeholder="Description (optional)"
                  />
                  <div className="flex justify-end gap-2">
                    <button type="button" onClick={() => { setEditingMeta(false); setMetaName(role.name); setMetaDesc(role.description ?? ""); }} className="text-xs text-gray-500 hover:text-gray-700 px-3 py-1.5">Cancel</button>
                    <button type="submit" disabled={saving} className="text-xs px-4 py-1.5 bg-primary-500 text-white rounded-lg hover:bg-primary-600 disabled:opacity-40 transition font-medium">Save</button>
                  </div>
                </form>
              ) : (
                <div className="flex items-start justify-between gap-2">
                  <p className="text-xs text-gray-500">{role.description || "No description"}</p>
                  <button onClick={() => setEditingMeta(true)} className="text-xs text-gray-400 hover:text-primary-500 transition shrink-0">Edit name</button>
                </div>
              )}
            </div>
          )}
          {isSystem && role.description && (
            <p className="text-xs text-gray-400">{role.description}</p>
          )}

          {/* Permissions grid */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs font-semibold text-gray-700">Permissions</p>
              {dirty && (
                <div className="flex gap-2">
                  <button onClick={() => setSelected(new Set(initial))} className="text-xs text-gray-400 hover:text-gray-600">Reset</button>
                  <button
                    onClick={handleSaveFeatures}
                    disabled={saving}
                    className="text-xs px-3 py-1 bg-primary-500 text-white rounded-lg hover:bg-primary-600 disabled:opacity-40 transition font-medium"
                  >
                    {saving ? "Saving…" : "Save changes"}
                  </button>
                </div>
              )}
            </div>

            <div className="space-y-4">
              {grouped.map(([domain, perms]) => (
                <div key={domain}>
                  <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">{domain}</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                    {(perms as PermissionDef[]).map((p) => (
                      <label
                        key={p.key}
                        className="flex items-start gap-2.5 p-2.5 rounded-xl bg-white border border-gray-100 hover:border-primary-200 cursor-pointer transition"
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(p.key)}
                          onChange={() => toggle(p.key)}
                          className="mt-0.5 rounded text-primary-500 focus:ring-primary-300"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1 flex-wrap">
                            <span className="text-xs font-medium text-gray-900">{p.displayName}</span>
                            <KindBadge kind={p.kind} />
                          </div>
                          <p className="text-[10px] text-gray-400 mt-0.5 leading-relaxed">{p.description}</p>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Delete (custom only) */}
          {!isSystem && onDeleteRequest && (
            <div className="flex justify-end pt-2 border-t border-gray-200">
              <button
                onClick={onDeleteRequest}
                className="text-xs text-red-500 hover:text-red-700 transition font-medium"
              >
                Delete role
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
