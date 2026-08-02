"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import { getSystemTenants, createTenant, updateTenant, resendOnboardingLink } from "@/lib/api";
import {
  BillingSection, EMPTY_BILLING, tenantBillingUiState, BillingStatusBadge, TenantBillingActions,
  PlanAccessBadge, billingSelectionComplete,
  type BillingSelection,
} from "@/components/system/TenantBilling";
import {
  getProvisioningStatus, repairBillingProvisioning, resendPaymentLink,
  type ProvisioningQuote, type ProvisioningStatus,
} from "@/lib/api-system-billing";
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
  const [formAdminName, setFormAdminName] = useState("");
  const [creating, setCreating] = useState(false);
  const [resending, setResending] = useState<string | null>(null);
  const [billing, setBilling] = useState<BillingSelection>(EMPTY_BILLING);
  const [quote, setQuote] = useState<ProvisioningQuote | null>(null);
  // Provisioning state per tenant. Absent means "not loaded yet"; a
  // PENDING_PAYMENT tenant with no COMPLETED request is treated as incomplete
  // rather than assumed ready, because guessing wrong offers the wrong action.
  const [provisioning, setProvisioning] = useState<Record<string, ProvisioningStatus | null>>({});
  const [billingBusy, setBillingBusy] = useState<string | null>(null);
  const [createResult, setCreateResult] = useState<null | {
    kind: "ready" | "setup_incomplete" | "email_failed";
    tenantName: string;
    detail?: string;
  }>(null);

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

  // Only PENDING_PAYMENT tenants need it, and only their own request decides
  // whether the operator should see Resend or Repair.
  useEffect(() => {
    if (!token) return;
    const pending = tenants.filter((t) => t.status === "PENDING_PAYMENT");
    if (!pending.length) return;
    let cancelled = false;
    Promise.all(
      pending.map((t) =>
        getProvisioningStatus(token, t.id)
          .then((st) => [t.id, st] as const)
          .catch(() => [t.id, null] as const),
      ),
    ).then((entries) => {
      if (cancelled) return;
      setProvisioning((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
    });
    return () => { cancelled = true; };
  }, [tenants, token]);

  async function handleRepairBilling(id: string) {
    if (!token) return;
    setBillingBusy(id);
    try {
      await repairBillingProvisioning(token, id);
      showMsg("Billing setup completed. The customer has been emailed a payment link.");
      const st = await getProvisioningStatus(token, id).catch(() => null);
      setProvisioning((p) => ({ ...p, [id]: st }));
      fetchTenants();
    } catch (err: any) {
      showMsg(friendlyBillingError(err), "error");
      const st = await getProvisioningStatus(token, id).catch(() => null);
      setProvisioning((p) => ({ ...p, [id]: st }));
    } finally {
      setBillingBusy(null);
    }
  }

  async function handleResendPaymentLink(id: string) {
    if (!token) return;
    setBillingBusy(id);
    try {
      await resendPaymentLink(token, id);
      showMsg("A new payment link has been sent. The previous link no longer works.");
    } catch (err: any) {
      showMsg(friendlyBillingError(err), "error");
    } finally {
      setBillingBusy(null);
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setCreating(true);
    try {
      const res: any = await createTenant(token, {
        name: formName,
        slug: formSlug,
        adminEmail: formAdminEmail,
        adminName: formAdminName,
        // Option KEYS only for the paid path. No price, credits or currency is
        // ever submitted - the backend recomputes and rejects any smuggled
        // commercial value. The POC credit budget is not a price; it is the
        // allowance being given away, so it is sent, bounded and audited.
        billing:
          billing.mode === "PAID_PLAN"
            ? {
                mode: "PAID_PLAN",
                planVersionId: billing.planVersionId,
                chatVolumeOptionKey: billing.chatVolumeOptionKey,
                voiceVolumeOptionKey: billing.voiceVolumeOptionKey,
                paymentRequiredBeforeAccess: true,
                ...(billing.commercialNote ? { commercialNote: billing.commercialNote } : {}),
              }
            : {
                mode: "POC",
                pocCredits: Number(billing.pocCredits),
                // End of the chosen day, so "expires on the 30th" means the
                // whole of the 30th rather than midnight at its start.
                pocExpiresAt: new Date(`${billing.pocExpiresAt}T23:59:59.000Z`).toISOString(),
                pocFeatureAreas: billing.pocFeatureAreas,
                ...(billing.commercialNote ? { commercialNote: billing.commercialNote } : {}),
              },
      });

      if (billing.mode === "PAID_PLAN") {
        const emailSent = res?.data?.billing?.emailSent !== false;
        setCreateResult({
          kind: emailSent ? "ready" : "email_failed",
          tenantName: formName,
          detail: res?.data?.billing?.linkExpiresAt,
        });
      } else {
        showMsg(
          `${formName} created on a POC: ${Number(billing.pocCredits).toLocaleString()} credits, no charge and no renewal.`,
        );
      }
      setShowCreate(false);
      setFormName(""); setFormSlug(""); setFormAdminEmail(""); setFormAdminName("");
      setBilling(EMPTY_BILLING); setQuote(null);
      fetchTenants();
    } catch (err: any) {
      // Tenant created but billing setup did not complete: NOT a generic
      // failure, and never "create the tenant again".
      if (err?.status === 502 && err?.body?.data?.billing) {
        setCreateResult({ kind: "setup_incomplete", tenantName: formName, detail: err?.body?.code });
        setShowCreate(false);
        setFormName(""); setFormSlug(""); setFormAdminEmail(""); setFormAdminName("");
        setBilling(EMPTY_BILLING); setQuote(null);
        fetchTenants();
      } else {
        showMsg(err.message || "Failed to create tenant", "error");
      }
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
        {createResult && (
          <div
            className={`mb-4 rounded-xl border p-4 ${
              createResult.kind === "setup_incomplete"
                ? "border-red-200 bg-red-50"
                : createResult.kind === "email_failed"
                  ? "border-amber-200 bg-amber-50"
                  : "border-green-200 bg-green-50"
            }`}
          >
            <p className="text-[13px] font-semibold text-gray-900">
              {createResult.kind === "setup_incomplete"
                ? `${createResult.tenantName} was created, but billing setup did not complete`
                : createResult.kind === "email_failed"
                  ? `${createResult.tenantName} was created and billing setup is ready, but the email did not send`
                  : `${createResult.tenantName} was created`}
            </p>
            <ul className="mt-2 space-y-0.5 text-[12.5px] text-gray-700">
              {createResult.kind === "setup_incomplete" ? (
                <>
                  <li>No payment link was sent.</li>
                  <li>No subscription is active and no credits were granted.</li>
                  <li>Use Repair billing setup on the tenant row. Do not create the tenant again.</li>
                </>
              ) : createResult.kind === "email_failed" ? (
                <>
                  <li>The checkout and payment attempt already exist and were not duplicated.</li>
                  <li>Use Resend payment link on the tenant row.</li>
                </>
              ) : (
                <>
                  <li>Status: Pending payment. The plan activates only after payment is confirmed.</li>
                  <li>No subscription is active and no credits were granted yet.</li>
                </>
              )}
            </ul>
            <button
              onClick={() => setCreateResult(null)}
              className="mt-2 text-[12px] font-medium text-gray-500 hover:text-gray-800"
            >
              Dismiss
            </button>
          </div>
        )}

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
            </div>
            {token && (
              <BillingSection token={token} value={billing} onChange={setBilling} onQuote={setQuote} />
            )}

            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-gray-500">
                {billing.mode === "PAID_PLAN"
                  ? "The admin receives an email with a secure setup link. The plan activates only after payment is confirmed."
                  : "The admin receives an invitation email with a secure setup link. POC access starts immediately and is never charged."}
              </p>
              <button
                type="submit" disabled={creating || !billingSelectionComplete(billing, !!quote)}
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
                  <th className="text-start text-xs font-medium text-gray-500 uppercase tracking-wider px-5 py-3">Plan</th>
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
                    {/* Never blank. A tenant with no plan says so, in red. */}
                    <td className="px-5 py-3"><PlanAccessBadge access={t.planAccess} /></td>
                    <td className="px-5 py-3">
                      {t.status === "PENDING_PAYMENT" ? (
                        // Two different operator problems, never one badge.
                        <BillingStatusBadge state={tenantBillingUiState(t.status, provisioning[t.id])} />
                      ) : (
                        <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ring-1 ${
                          t.status === "ACTIVE"
                            ? "bg-green-50 text-green-600 ring-green-200"
                            : t.status === "SUSPENDED" || !t.isActive
                            ? "bg-red-50 text-red-600 ring-red-200"
                            : "bg-amber-50 text-amber-600 ring-amber-200"
                        }`}>
                          {t.status === "ACTIVE" ? "Active" : t.status === "PENDING_ADMIN_SETUP" ? "Pending Setup" : t.status === "PENDING_ONBOARDING" ? "Onboarding" : !t.isActive ? "Disabled" : t.status}
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2">
                        {t.status === "PENDING_PAYMENT" && (
                          <TenantBillingActions
                            state={tenantBillingUiState(t.status, provisioning[t.id])}
                            provisioning={provisioning[t.id]}
                            busy={billingBusy === t.id}
                            onResend={() => handleResendPaymentLink(t.id)}
                            onRepair={() => handleRepairBilling(t.id)}
                          />
                        )}
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

/** Structured backend codes turned into something an operator can act on. */
function friendlyBillingError(err: any): string {
  switch (err?.code) {
    case "BILLING_PROVISIONING_INCOMPLETE":
      return "Billing setup was never completed for this tenant. Repair the setup first.";
    case "BILLING_PROVISIONING_ALREADY_COMPLETE":
      return "Billing setup is already complete. Use Resend payment link instead.";
    case "PAYMENT_LINK_RATE_LIMITED":
      return `Too many sends. Try again in ${err?.body?.retryAfterSeconds ?? 60} seconds.`;
    case "PAYMENT_LINK_NOT_AVAILABLE":
      return "This checkout can no longer be resumed. Provision the tenant again with a new plan.";
    case "TENANT_NOT_PENDING_PAYMENT":
      return "This tenant is not awaiting payment.";
    default:
      return err?.message || "The action could not be completed.";
  }
}
