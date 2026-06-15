"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { useAuth } from "@/context/AuthContext";
import {
  assignUserToRole,
  createTenantRole,
  deleteTenantRole,
  deleteUserGrant,
  getAgents,
  getPermissionsFeatureRegistry,
  getTenantRoles,
  getUserGrants,
  setTenantRoleFeatures,
  setUserGrant,
  unassignUserFromRole,
  updateTenantRole,
  type FeatureMetadata,
  type TenantRole,
  type UserFeatureGrantRow,
} from "@/lib/api";

interface AgentLike {
  id: string;
  email: string;
  name: string;
  role: string;
  isActive: boolean;
}

const CATEGORY_TONE: Record<FeatureMetadata["category"], string> = {
  messaging: "bg-blue-50 text-blue-600 ring-blue-200",
  voice: "bg-purple-50 text-purple-600 ring-purple-200",
  ai: "bg-orange-50 text-orange-600 ring-orange-200",
  knowledge: "bg-amber-50 text-amber-600 ring-amber-200",
  crm: "bg-cyan-50 text-cyan-600 ring-cyan-200",
  automation: "bg-indigo-50 text-indigo-600 ring-indigo-200",
  commerce: "bg-emerald-50 text-emerald-600 ring-emerald-200",
  integrations: "bg-pink-50 text-pink-600 ring-pink-200",
  analytics: "bg-teal-50 text-teal-600 ring-teal-200",
  notifications: "bg-yellow-50 text-yellow-700 ring-yellow-200",
  admin: "bg-slate-100 text-slate-700 ring-slate-300",
};

const CATEGORY_LABEL: Record<FeatureMetadata["category"], string> = {
  messaging: "Messaging",
  voice: "Voice",
  ai: "AI",
  knowledge: "Knowledge",
  crm: "CRM",
  automation: "Automation",
  commerce: "Commerce",
  integrations: "Integrations",
  analytics: "Analytics",
  notifications: "Notifications",
  admin: "Admin",
};

export default function PermissionsPage() {
  const { token } = useAuth();

  const [tab, setTab] = useState<"roles" | "users">("roles");
  const [features, setFeatures] = useState<FeatureMetadata[]>([]);
  const [roles, setRoles] = useState<TenantRole[]>([]);
  const [agents, setAgents] = useState<AgentLike[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error">("success");

  function notify(msg: string, type: "success" | "error" = "success") {
    setMessage(msg);
    setMessageType(type);
    setTimeout(() => setMessage(""), 5000);
  }

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const [feats, rolesRes, agentList] = await Promise.all([
        getPermissionsFeatureRegistry(token),
        getTenantRoles(token),
        getAgents(token),
      ]);
      setFeatures(feats.data);
      setRoles(rolesRes.data);
      setAgents(
        (agentList as AgentLike[]).filter(
          (u) => u.role === "ADMIN" || u.role === "AGENT",
        ),
      );
    } catch (err) {
      console.error("Failed to load permissions:", err);
      notify("Failed to load permissions", "error");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (!token) return null;

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Roles &amp; Permissions</h1>
          <p className="text-xs text-gray-400 mt-1">
            Define custom roles, assign features to them, and override access per user.
            Tenant-level feature availability is controlled by the system admin.
          </p>
        </div>
        <div className="flex bg-gray-100 rounded-xl p-1 text-xs font-medium">
          <button
            onClick={() => setTab("roles")}
            className={clsx(
              "px-3 py-1.5 rounded-lg transition",
              tab === "roles" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700",
            )}
          >
            Roles
          </button>
          <button
            onClick={() => setTab("users")}
            className={clsx(
              "px-3 py-1.5 rounded-lg transition",
              tab === "users" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700",
            )}
          >
            Users
          </button>
        </div>
      </div>

      {message && (
        <div
          className={clsx(
            "rounded-xl px-4 py-2.5 text-sm ring-1",
            messageType === "success"
              ? "bg-green-50 text-green-700 ring-green-200"
              : "bg-red-50 text-red-700 ring-red-200",
          )}
        >
          {message}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="w-6 h-6 border-2 border-orange-200 border-t-orange-500 rounded-full animate-spin" />
        </div>
      ) : tab === "roles" ? (
        <RolesSection
          token={token}
          roles={roles}
          features={features}
          onChange={refresh}
          notify={notify}
        />
      ) : (
        <UsersSection
          token={token}
          users={agents}
          roles={roles}
          features={features}
          onChange={refresh}
          notify={notify}
        />
      )}
    </div>
  );
}

// ─── Roles tab ────────────────────────────────────────────────

function RolesSection({
  token,
  roles,
  features,
  onChange,
  notify,
}: {
  token: string;
  roles: TenantRole[];
  features: FeatureMetadata[];
  onChange: () => void;
  notify: (msg: string, type?: "success" | "error") => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      await createTenantRole(token, { name: name.trim(), description: description.trim() || undefined });
      notify(`Role "${name}" created`);
      setName("");
      setDescription("");
      setCreating(false);
      onChange();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to create role";
      notify(msg, "error");
    }
  }

  async function handleDelete(role: TenantRole) {
    if (!confirm(`Delete role "${role.name}"? Users assigned to it will lose its features.`)) return;
    try {
      await deleteTenantRole(token, role.id);
      notify(`Role "${role.name}" deleted`);
      onChange();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to delete role";
      notify(msg, "error");
    }
  }

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl border border-gray-200 p-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="font-semibold text-gray-900 text-sm">Custom Roles</h2>
            <p className="text-xs text-gray-400">
              {roles.length} role{roles.length === 1 ? "" : "s"} · Click a role to edit its features
            </p>
          </div>
          <button
            onClick={() => setCreating(!creating)}
            className="text-xs px-3 py-1.5 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition font-medium"
          >
            {creating ? "Cancel" : "+ New Role"}
          </button>
        </div>

        {creating && (
          <form onSubmit={handleCreate} className="mb-4 p-4 rounded-xl bg-gray-50 border border-gray-200 space-y-3">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={80}
              placeholder="Role name (e.g. Sales Manager)"
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white"
            />
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
              placeholder="Description (optional)"
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white"
            />
            <div className="flex justify-end">
              <button
                type="submit"
                className="text-xs px-4 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition font-medium"
              >
                Create role
              </button>
            </div>
          </form>
        )}

        <div className="space-y-2">
          {roles.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-6">
              No custom roles yet. Built-in ADMIN role gets every tenant-enabled feature automatically; AGENT users get only features explicitly granted via a role or per-user override.
            </p>
          ) : (
            roles.map((role) => (
              <RoleRow
                key={role.id}
                role={role}
                features={features}
                expanded={expandedId === role.id}
                onToggle={() => setExpandedId(expandedId === role.id ? null : role.id)}
                onDelete={() => handleDelete(role)}
                onSaved={onChange}
                token={token}
                notify={notify}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function RoleRow({
  role,
  features,
  expanded,
  onToggle,
  onDelete,
  onSaved,
  token,
  notify,
}: {
  role: TenantRole;
  features: FeatureMetadata[];
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onSaved: () => void;
  token: string;
  notify: (msg: string, type?: "success" | "error") => void;
}) {
  const initial = useMemo(() => new Set(role.features.map((f) => f.feature)), [role.features]);
  const [selected, setSelected] = useState<Set<string>>(initial);
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState(role.name);
  const [description, setDescription] = useState(role.description ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setSelected(initial);
    setName(role.name);
    setDescription(role.description ?? "");
  }, [initial, role.name, role.description]);

  const dirty = useMemo(() => {
    if (selected.size !== initial.size) return true;
    return Array.from(selected).some((f) => !initial.has(f));
  }, [selected, initial]);

  function toggle(feature: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(feature)) next.delete(feature);
      else next.add(feature);
      return next;
    });
  }

  async function handleSaveFeatures() {
    setSaving(true);
    try {
      await setTenantRoleFeatures(token, role.id, Array.from(selected));
      notify("Role features updated");
      onSaved();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to save features";
      notify(msg, "error");
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveMeta() {
    setSaving(true);
    try {
      await updateTenantRole(token, role.id, {
        name,
        description: description || null,
      });
      notify("Role updated");
      setEditingName(false);
      onSaved();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to update role";
      notify(msg, "error");
    } finally {
      setSaving(false);
    }
  }

  const grouped = useMemo(() => {
    const map = new Map<FeatureMetadata["category"], FeatureMetadata[]>();
    for (const f of features) {
      const arr = map.get(f.category) || [];
      arr.push(f);
      map.set(f.category, arr);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [features]);

  return (
    <div className="border border-gray-200 rounded-xl overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between p-3 hover:bg-gray-50 transition text-start"
      >
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-orange-100 to-orange-200 flex items-center justify-center text-xs font-bold text-orange-600">
            {role.name.charAt(0).toUpperCase()}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium text-gray-900">{role.name}</p>
              {role.isSystem && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-gray-100 text-gray-600 ring-1 ring-gray-200">
                  System
                </span>
              )}
            </div>
            <p className="text-xs text-gray-400">
              {role.features.length} feature{role.features.length === 1 ? "" : "s"} ·{" "}
              {role._count?.assignments ?? 0} user{(role._count?.assignments ?? 0) === 1 ? "" : "s"}
            </p>
          </div>
        </div>
        <svg
          className={clsx("w-4 h-4 text-gray-400 transition-transform", expanded && "rotate-180")}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {expanded && (
        <div className="p-4 border-t border-gray-100 bg-gray-50/50 space-y-4">
          {/* Meta editing */}
          <div className="space-y-2">
            {editingName ? (
              <>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={80}
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white"
                  placeholder="Role name"
                />
                <input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  maxLength={500}
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white"
                  placeholder="Description"
                />
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => {
                      setEditingName(false);
                      setName(role.name);
                      setDescription(role.description ?? "");
                    }}
                    className="text-xs px-3 py-1.5 text-gray-500 hover:text-gray-700"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSaveMeta}
                    disabled={saving || role.isSystem}
                    className="text-xs px-3 py-1.5 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition disabled:opacity-40"
                  >
                    Save
                  </button>
                </div>
              </>
            ) : (
              <div className="flex items-center justify-between">
                <p className="text-xs text-gray-500">{role.description || "No description"}</p>
                {!role.isSystem && (
                  <button
                    onClick={() => setEditingName(true)}
                    className="text-xs text-gray-400 hover:text-orange-500 transition"
                  >
                    Edit
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Feature checkboxes */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-gray-700">Features granted by this role</p>
              {dirty && (
                <div className="flex gap-2">
                  <button
                    onClick={() => setSelected(initial)}
                    className="text-xs text-gray-400 hover:text-gray-600"
                  >
                    Reset
                  </button>
                  <button
                    onClick={handleSaveFeatures}
                    disabled={saving}
                    className="text-xs px-3 py-1 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition disabled:opacity-40"
                  >
                    {saving ? "Saving…" : "Save changes"}
                  </button>
                </div>
              )}
            </div>
            <div className="space-y-3">
              {grouped.map(([category, items]) => (
                <div key={category}>
                  <span
                    className={clsx(
                      "text-[10px] px-2 py-0.5 rounded-full font-medium ring-1 inline-block mb-1.5",
                      CATEGORY_TONE[category],
                    )}
                  >
                    {CATEGORY_LABEL[category]}
                  </span>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                    {items.map((f) => (
                      <label
                        key={f.key}
                        className="flex items-start gap-2 p-2 rounded-lg bg-white border border-gray-200 hover:border-orange-300 cursor-pointer transition"
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(f.key)}
                          onChange={() => toggle(f.key)}
                          className="mt-0.5 rounded text-orange-500 focus:ring-orange-300"
                        />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium text-gray-900">{f.displayName}</p>
                          <p className="text-[11px] text-gray-500 truncate">{f.description}</p>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {!role.isSystem && (
            <div className="flex justify-end pt-2 border-t border-gray-200">
              <button
                onClick={onDelete}
                className="text-xs text-red-500 hover:text-red-700 transition"
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

// ─── Users tab ────────────────────────────────────────────────

function UsersSection({
  token,
  users,
  roles,
  features,
  onChange,
  notify,
}: {
  token: string;
  users: AgentLike[];
  roles: TenantRole[];
  features: FeatureMetadata[];
  onChange: () => void;
  notify: (msg: string, type?: "success" | "error") => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-5">
      <h2 className="font-semibold text-gray-900 text-sm mb-1">Users</h2>
      <p className="text-xs text-gray-400 mb-3">
        Assign roles or set per-user overrides. ADMIN users automatically get every tenant-enabled feature.
      </p>
      <div className="space-y-2">
        {users.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-6">No users found.</p>
        ) : (
          users.map((u) => (
            <UserRow
              key={u.id}
              user={u}
              roles={roles}
              features={features}
              expanded={expandedId === u.id}
              onToggle={() => setExpandedId(expandedId === u.id ? null : u.id)}
              onChange={onChange}
              token={token}
              notify={notify}
            />
          ))
        )}
      </div>
    </div>
  );
}

function UserRow({
  user,
  roles,
  features,
  expanded,
  onToggle,
  onChange,
  token,
  notify,
}: {
  user: AgentLike;
  roles: TenantRole[];
  features: FeatureMetadata[];
  expanded: boolean;
  onToggle: () => void;
  onChange: () => void;
  token: string;
  notify: (msg: string, type?: "success" | "error") => void;
}) {
  const [grants, setGrants] = useState<UserFeatureGrantRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  // We assume each user has at most one role assignment for now (matches
  // the UI's mental model; backend allows many). Tracked via roles array.
  const [assignedRoleIds, setAssignedRoleIds] = useState<Set<string>>(new Set());

  const fetchDetails = useCallback(async () => {
    if (!token || !expanded) return;
    setLoading(true);
    try {
      const grantsRes = await getUserGrants(token, user.id);
      setGrants(grantsRes.data);
      // Role assignments aren't returned by getUserGrants; we infer them
      // from the tenant roles list - each role row has `_count.assignments`
      // but not WHO. So we leave assignedRoleIds empty and let the user
      // click to assign - the API is idempotent.
      setAssignedRoleIds(new Set());
    } catch (err) {
      console.error("Failed to load user permissions:", err);
      notify("Failed to load user permissions", "error");
    } finally {
      setLoading(false);
    }
  }, [token, expanded, user.id, notify]);

  useEffect(() => {
    fetchDetails();
  }, [fetchDetails]);

  async function toggleRole(role: TenantRole) {
    const isAssigned = assignedRoleIds.has(role.id);
    try {
      if (isAssigned) {
        await unassignUserFromRole(token, user.id, role.id);
        setAssignedRoleIds((s) => {
          const n = new Set(s);
          n.delete(role.id);
          return n;
        });
        notify(`Unassigned "${role.name}" from ${user.name}`);
      } else {
        await assignUserToRole(token, user.id, role.id);
        setAssignedRoleIds((s) => new Set(s).add(role.id));
        notify(`Assigned "${role.name}" to ${user.name}`);
      }
      onChange();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to update role assignment";
      notify(msg, "error");
    }
  }

  async function setGrant(feature: string, granted: boolean | null) {
    try {
      if (granted === null) {
        await deleteUserGrant(token, user.id, feature);
        setGrants((prev) => (prev ? prev.filter((g) => g.feature !== feature) : prev));
        notify(`Removed override for "${feature}"`);
      } else {
        const res = await setUserGrant(token, user.id, feature, { granted });
        setGrants((prev) => {
          if (!prev) return [res.data];
          const idx = prev.findIndex((g) => g.feature === feature);
          if (idx === -1) return [...prev, res.data];
          const copy = [...prev];
          copy[idx] = res.data;
          return copy;
        });
        notify(granted ? `Granted "${feature}"` : `Revoked "${feature}"`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to update grant";
      notify(msg, "error");
    }
  }

  function grantFor(feature: string): boolean | null {
    const g = grants?.find((x) => x.feature === feature);
    return g ? g.granted : null;
  }

  return (
    <div className="border border-gray-200 rounded-xl overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between p-3 hover:bg-gray-50 transition text-start"
      >
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-gradient-to-br from-gray-300 to-gray-400 rounded-lg flex items-center justify-center text-xs font-bold text-white">
            {user.name?.charAt(0).toUpperCase() || "?"}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium text-gray-900">{user.name}</p>
              <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-gray-100 text-gray-600 ring-1 ring-gray-200">
                {user.role}
              </span>
            </div>
            <p className="text-xs text-gray-400">{user.email}</p>
          </div>
        </div>
        <svg
          className={clsx("w-4 h-4 text-gray-400 transition-transform", expanded && "rotate-180")}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {expanded && (
        <div className="p-4 border-t border-gray-100 bg-gray-50/50 space-y-4">
          {loading ? (
            <div className="flex items-center justify-center py-4">
              <div className="w-5 h-5 border-2 border-orange-200 border-t-orange-500 rounded-full animate-spin" />
            </div>
          ) : (
            <>
              {/* Role assignments */}
              <div>
                <p className="text-xs font-semibold text-gray-700 mb-2">Assigned roles</p>
                {roles.length === 0 ? (
                  <p className="text-xs text-gray-400">No custom roles defined - create one in the Roles tab.</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {roles.map((r) => {
                      const isOn = assignedRoleIds.has(r.id);
                      return (
                        <button
                          key={r.id}
                          onClick={() => toggleRole(r)}
                          className={clsx(
                            "text-xs px-3 py-1 rounded-full font-medium ring-1 transition",
                            isOn
                              ? "bg-orange-500 text-white ring-orange-500"
                              : "bg-white text-gray-600 ring-gray-200 hover:ring-orange-300",
                          )}
                        >
                          {r.name}
                        </button>
                      );
                    })}
                  </div>
                )}
                <p className="text-[10px] text-gray-400 mt-1">
                  Click to assign/unassign. Toggling is idempotent - re-click to confirm if the chip state
                  drifts from server state on first load.
                </p>
              </div>

              {/* Per-feature overrides */}
              <div>
                <p className="text-xs font-semibold text-gray-700 mb-2">Per-feature overrides</p>
                <p className="text-[11px] text-gray-400 mb-2">
                  Overrides beat role grants. Use sparingly - prefer role-based access.
                </p>
                <div className="space-y-1.5">
                  {features.map((f) => {
                    const g = grantFor(f.key);
                    return (
                      <div
                        key={f.key}
                        className="flex items-center justify-between p-2 rounded-lg bg-white border border-gray-200"
                      >
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium text-gray-900">{f.displayName}</p>
                          <p className="text-[10px] text-gray-400 truncate">{f.description}</p>
                        </div>
                        <div className="flex bg-gray-100 rounded-lg p-0.5 text-[10px] font-medium">
                          <button
                            onClick={() => setGrant(f.key, true)}
                            className={clsx(
                              "px-2 py-1 rounded-md transition",
                              g === true
                                ? "bg-green-500 text-white"
                                : "text-gray-500 hover:text-gray-700",
                            )}
                          >
                            Grant
                          </button>
                          <button
                            onClick={() => setGrant(f.key, null)}
                            className={clsx(
                              "px-2 py-1 rounded-md transition",
                              g === null
                                ? "bg-white text-gray-900 shadow-sm"
                                : "text-gray-500 hover:text-gray-700",
                            )}
                          >
                            Inherit
                          </button>
                          <button
                            onClick={() => setGrant(f.key, false)}
                            className={clsx(
                              "px-2 py-1 rounded-md transition",
                              g === false
                                ? "bg-red-500 text-white"
                                : "text-gray-500 hover:text-gray-700",
                            )}
                          >
                            Revoke
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
