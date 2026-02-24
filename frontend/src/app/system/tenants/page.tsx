"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import { getSystemTenants, createTenant, updateTenant, resendOnboardingLink } from "@/lib/api";
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
  const [showAdminPassword, setShowAdminPassword] = useState(false);
  const [resending, setResending] = useState<string | null>(null);

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

  async function handleResendOnboarding(id: string) {
    if (!token) return;
    setResending(id);
    try {
      const res = await resendOnboardingLink(token, id);
      showMsg(`Onboarding link resent to ${res.data.sentTo}`);
    } catch (err: any) {
      showMsg(err.message || "Failed to resend onboarding link", "error");
    } finally {
      setResending(null);
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
                <div className="relative">
                  <input
                    type={showAdminPassword ? "text" : "password"} value={formAdminPassword} onChange={(e) => setFormAdminPassword(e.target.value)} required minLength={8}
                    className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 pe-10 focus:ring-2 focus:ring-orange-200 focus:border-orange-300 outline-none"
                    placeholder="Min 8 characters"
                  />
                  <button
                    type="button"
                    onClick={() => setShowAdminPassword(!showAdminPassword)}
                    className="absolute end-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition"
                    tabIndex={-1}
                  >
                    {showAdminPassword ? (
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" />
                      </svg>
                    ) : (
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                    )}
                  </button>
                </div>
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
                        t.status === "ACTIVE"
                          ? "bg-green-50 text-green-600 ring-green-200"
                          : t.status === "SUSPENDED" || !t.isActive
                          ? "bg-red-50 text-red-600 ring-red-200"
                          : "bg-amber-50 text-amber-600 ring-amber-200"
                      }`}>
                        {t.status === "ACTIVE" ? "Active" : t.status === "PENDING_ADMIN_SETUP" ? "Pending Setup" : t.status === "PENDING_ONBOARDING" ? "Onboarding" : !t.isActive ? "Disabled" : t.status}
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
                        {t.status !== "ACTIVE" && (
                          <button
                            onClick={() => handleResendOnboarding(t.id)}
                            disabled={resending === t.id}
                            className="text-xs text-blue-400 hover:text-blue-600 transition disabled:opacity-40"
                          >
                            {resending === t.id ? "Sending..." : "Resend Link"}
                          </button>
                        )}
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
