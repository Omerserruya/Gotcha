"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import { getSystemTenants, createTenant, updateTenant } from "@/lib/api";
import { SystemLayout } from "@/components/SystemLayout";
import clsx from "clsx";

export default function TenantsPage() {
  const { token } = useAuth();
  const [tenants, setTenants] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error">("success");

  // Create form
  const [formName, setFormName] = useState("");
  const [formSlug, setFormSlug] = useState("");
  const [formAdminEmail, setFormAdminEmail] = useState("");
  const [formAdminPassword, setFormAdminPassword] = useState("");
  const [formAdminName, setFormAdminName] = useState("");
  const [creating, setCreating] = useState(false);

  const showMsg = (msg: string, type: "success" | "error" = "success") => {
    setMessage(msg);
    setMessageType(type);
    setTimeout(() => setMessage(""), 5000);
  };

  const fetchTenants = useCallback(async () => {
    if (!token) return;
    try {
      const res = await getSystemTenants(token, search ? { search } : undefined);
      setTenants(res.data || []);
    } catch (err) {
      console.error("Failed to load tenants:", err);
    } finally {
      setLoading(false);
    }
  }, [token, search]);

  useEffect(() => { fetchTenants(); }, [fetchTenants]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setCreating(true);
    try {
      await createTenant(token, {
        name: formName,
        slug: formSlug,
        adminEmail: formAdminEmail,
        adminPassword: formAdminPassword,
        adminName: formAdminName,
      });
      showMsg("Tenant created successfully");
      setShowCreate(false);
      setFormName(""); setFormSlug(""); setFormAdminEmail(""); setFormAdminPassword(""); setFormAdminName("");
      fetchTenants();
    } catch (err: any) {
      showMsg(err.message || "Failed to create tenant", "error");
    } finally {
      setCreating(false);
    }
  }

  async function handleToggleActive(id: string, currentActive: boolean) {
    if (!token) return;
    try {
      await updateTenant(token, id, { isActive: !currentActive });
      showMsg(currentActive ? "Tenant disabled" : "Tenant enabled");
      fetchTenants();
    } catch (err: any) {
      showMsg(err.message || "Failed to update tenant", "error");
    }
  }

  // Auto-generate slug from name
  function handleNameChange(name: string) {
    setFormName(name);
    if (!formSlug || formSlug === slugify(formName)) {
      setFormSlug(slugify(name));
    }
  }

  function slugify(str: string) {
    return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }

  return (
    <SystemLayout>
      <div className="max-w-5xl mx-auto p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Tenants</h1>
            <p className="text-sm text-gray-500 mt-1">Manage organizations on the platform</p>
          </div>
          <button
            onClick={() => setShowCreate(!showCreate)}
            className="px-4 py-2 bg-orange-500 text-white rounded-xl hover:bg-orange-600 transition font-medium text-sm"
          >
            {showCreate ? "Cancel" : "New Tenant"}
          </button>
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

        {/* Create Form */}
        {showCreate && (
          <form onSubmit={handleCreate} className="bg-white rounded-2xl border border-gray-200 p-6 space-y-4">
            <h2 className="font-semibold text-gray-900">Create New Tenant</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1">Organization Name</label>
                <input
                  value={formName} onChange={(e) => handleNameChange(e.target.value)} required
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:ring-2 focus:ring-orange-200 focus:border-orange-300 outline-none"
                  placeholder="Acme Corp"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1">Slug (URL identifier)</label>
                <input
                  value={formSlug} onChange={(e) => setFormSlug(e.target.value)} required pattern="^[a-z0-9-]+$"
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:ring-2 focus:ring-orange-200 focus:border-orange-300 outline-none"
                  placeholder="acme-corp"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1">Admin Name</label>
                <input
                  value={formAdminName} onChange={(e) => setFormAdminName(e.target.value)} required
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:ring-2 focus:ring-orange-200 focus:border-orange-300 outline-none"
                  placeholder="John Doe"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1">Admin Email</label>
                <input
                  type="email" value={formAdminEmail} onChange={(e) => setFormAdminEmail(e.target.value)} required
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:ring-2 focus:ring-orange-200 focus:border-orange-300 outline-none"
                  placeholder="admin@acme.com"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="text-xs font-medium text-gray-600 block mb-1">Admin Password</label>
                <input
                  type="password" value={formAdminPassword} onChange={(e) => setFormAdminPassword(e.target.value)} required minLength={8}
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:ring-2 focus:ring-orange-200 focus:border-orange-300 outline-none"
                  placeholder="Min 8 characters"
                />
              </div>
            </div>
            <div className="flex justify-end">
              <button
                type="submit" disabled={creating}
                className="px-5 py-2 bg-orange-500 text-white rounded-xl hover:bg-orange-600 transition font-medium text-sm disabled:opacity-40"
              >
                {creating ? "Creating..." : "Create Tenant"}
              </button>
            </div>
          </form>
        )}

        {/* Search */}
        <div>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tenants..."
            className="w-full max-w-sm text-sm border border-gray-200 rounded-xl px-4 py-2.5 bg-white focus:ring-2 focus:ring-orange-200 focus:border-orange-300 outline-none"
          />
        </div>

        {/* Tenants List */}
        <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="w-6 h-6 border-2 border-orange-200 border-t-orange-500 rounded-full animate-spin" />
            </div>
          ) : tenants.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-sm text-gray-400">No tenants found</p>
            </div>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="text-start text-xs font-medium text-gray-500 uppercase tracking-wider px-5 py-3">Organization</th>
                  <th className="text-start text-xs font-medium text-gray-500 uppercase tracking-wider px-5 py-3">Users</th>
                  <th className="text-start text-xs font-medium text-gray-500 uppercase tracking-wider px-5 py-3">Active Chats</th>
                  <th className="text-start text-xs font-medium text-gray-500 uppercase tracking-wider px-5 py-3">Channels</th>
                  <th className="text-start text-xs font-medium text-gray-500 uppercase tracking-wider px-5 py-3">Status</th>
                  <th className="text-start text-xs font-medium text-gray-500 uppercase tracking-wider px-5 py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {tenants.map((t) => (
                  <tr key={t.id} className="border-b border-gray-50 hover:bg-gray-50/50 transition">
                    <td className="px-5 py-3">
                      <Link href={`/system/tenants/${t.id}`} className="hover:text-orange-600 transition">
                        <p className="text-sm font-medium text-gray-900">{t.name}</p>
                        <p className="text-xs text-gray-400">{t.slug}</p>
                      </Link>
                    </td>
                    <td className="px-5 py-3 text-sm text-gray-600">{t._count?.users || 0}</td>
                    <td className="px-5 py-3 text-sm text-gray-600">{t._count?.conversations || 0}</td>
                    <td className="px-5 py-3 text-sm text-gray-600">{t._count?.channelAccounts || 0}</td>
                    <td className="px-5 py-3">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ring-1 ${
                        t.isActive
                          ? "bg-green-50 text-green-600 ring-green-200"
                          : "bg-red-50 text-red-600 ring-red-200"
                      }`}>
                        {t.isActive ? "Active" : "Disabled"}
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/system/tenants/${t.id}`}
                          className="text-xs text-gray-400 hover:text-orange-500 transition"
                        >
                          View
                        </Link>
                        <button
                          onClick={() => handleToggleActive(t.id, t.isActive)}
                          className={clsx(
                            "text-xs transition",
                            t.isActive ? "text-red-400 hover:text-red-600" : "text-green-400 hover:text-green-600"
                          )}
                        >
                          {t.isActive ? "Disable" : "Enable"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </SystemLayout>
  );
}
