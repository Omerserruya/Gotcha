"use client";

// Sysadmin: Plans & Pricing - the commercial CONFIGURATION surface.
//
// This is layer B and the catalog. The internal COST view (real tokens, real
// provider spend) lives on Unit Economics and Conversation Cost; the two are
// deliberately separate screens because they answer different questions and
// only one of them may ever influence what a customer is charged.
//
// The safety model the UI has to make visible:
//   • An ACTIVE version is immutable. Changing a price means creating a DRAFT
//     and publishing it, so the current one keeps describing what existing
//     customers are on.
//   • Publish shows its blast radius first: what changed, how many
//     organizations are on the previous version, and what happens to them.
//   • Editing the public estimation ratio previews the new numbers before
//     anything is published, and states plainly that it cannot touch the
//     ledger, invoices or existing subscriptions.

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { SystemLayout } from "@/components/SystemLayout";
import { useAuth } from "@/context/AuthContext";
import clsx from "clsx";
import {
  listAdminPlans,
  listAdminFeatures,
  listEstimationConfigs,
  listAdminPackages,
  savePackage,
  deletePackage,
  deleteDraftPlan,
  createPlan,
  getCurrencyAdmin,
  listEvaluationTemplates,
  createPlanVersion,
  publishPlan,
  previewPublish,
  previewEstimation,
  publishEstimation,
  refreshFx,
  setRecommendedPlan,
  type AdminPlan,
  type AdminFeature,
  type EstimationConfig,
  type AdminPackage,
  type CurrencyAdmin,
  type EvaluationTemplate,
  type PublishPreview,
  type EstimationPreview,
} from "@/lib/api-pricing-admin";

type Tab = "plans" | "estimation" | "packages" | "currency" | "evaluation";

/** The default chat tier a visitor lands on, or null when none is offered. */
function defaultChatTier(p: AdminPlan) {
  if (!p.chatVolumeEnabled) return null;
  const offered = p.volumeOptions.filter((o) => o.channel === "CHAT" && o.enabled);
  return offered.find((o) => o.isDefault) ?? offered[0] ?? null;
}

/**
 * Credits per conversation the plan's own numbers imply: the chat allowance
 * divided by the volume the default tier advertises.
 *
 * This is the reconciliation an operator cannot do in their head. A plan that
 * includes 750 credits while advertising 250 conversations a month is implicitly
 * promising 3 credits per conversation - and if the configured assumption says
 * 8, one of the two numbers is wrong.
 */
function impliedRatioFor(p: AdminPlan): number | null {
  const tier = defaultChatTier(p);
  const monthly = tier?.monthlyVolume ?? 0;
  const chatCredits = Math.max(0, p.includedCredits - p.voiceCredits);
  if (!(monthly > 0) || !(chatCredits > 0)) return null;
  return Math.round((chatCredits / monthly) * 10) / 10;
}

const STATUS_STYLE: Record<string, string> = {
  DRAFT: "bg-amber-50 text-amber-700 border-amber-200",
  ACTIVE: "bg-emerald-50 text-emerald-700 border-emerald-200",
  RETIRED: "bg-gray-100 text-gray-600 border-gray-200",
  ARCHIVED: "bg-gray-50 text-gray-400 border-gray-200",
};

const KIND_STYLE: Record<string, string> = {
  PUBLIC: "bg-blue-50 text-blue-700",
  CUSTOM: "bg-violet-50 text-violet-700",
  POC: "bg-teal-50 text-teal-700",
  TRIAL: "bg-teal-50 text-teal-700",
  LEGACY: "bg-gray-100 text-gray-500",
};

export default function SystemPlansPage() {
  const { token } = useAuth();
  const [tab, setTab] = useState<Tab>("plans");
  const [plans, setPlans] = useState<AdminPlan[]>([]);
  const [features, setFeatures] = useState<AdminFeature[]>([]);
  const [estimations, setEstimations] = useState<EstimationConfig[]>([]);
  const [packages, setPackages] = useState<AdminPackage[]>([]);
  const [currency, setCurrency] = useState<CurrencyAdmin | null>(null);
  const [templates, setTemplates] = useState<EvaluationTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [preview, setPreview] = useState<PublishPreview | null>(null);

  const reload = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [p, f, e, pk, c, tm] = await Promise.all([
        listAdminPlans(token),
        listAdminFeatures(token),
        listEstimationConfigs(token),
        listAdminPackages(token),
        getCurrencyAdmin(token),
        listEvaluationTemplates(token).catch(() => ({ templates: [] as EvaluationTemplate[] })),
      ]);
      setPlans(p.plans);
      setFeatures(f.features);
      setEstimations(e.configs);
      setPackages(pk.packages);
      setCurrency(c);
      setTemplates(tm.templates);
    } catch (err: any) {
      setMsg({ kind: "err", text: err?.message ?? "Failed to load pricing configuration" });
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    reload();
  }, [reload]);

  const doDiscardDraft = async (id: string, key: string, version: number) => {
    if (!token) return;
    // A draft has never been sold, so discarding it destroys nothing anyone
    // agreed to. The confirmation names which one.
    if (!confirm(`Discard draft ${key} v${version}? It has never been published.`)) return;
    try {
      await deleteDraftPlan(token, id);
      setMsg({ kind: "ok", text: `Draft ${key} v${version} discarded.` });
      reload();
    } catch (e: any) {
      setMsg({
        kind: "err",
        text:
          e?.message === "plan_version_immutable"
            ? "Only a draft can be discarded. A published version defines what paying organizations agreed to."
            : e?.message ?? "Could not discard that draft.",
      });
    }
  };

  const doCreatePlan = async (key: string, kind: string, name: string) => {
    if (!token) return;
    try {
      const r = await createPlan(token, { key, kind, name });
      setMsg({ kind: "ok", text: `${kind} plan ${r.plan.key} created as a draft. Edit it, preview, then publish.` });
      reload();
    } catch (e: any) {
      setMsg({
        kind: "err",
        text:
          e?.message === "plan_key_exists"
            ? "A plan with that key already exists. Create a new version of it instead."
            : e?.message ?? "Could not create that plan.",
      });
    }
  };

  const doCreateVersion = async (key: string) => {
    if (!token) return;
    try {
      const r = await createPlanVersion(token, key);
      setMsg({ kind: "ok", text: `Draft ${key} v${r.plan.version} created. Edit it, preview, then publish.` });
      reload();
    } catch (e: any) {
      setMsg({ kind: "err", text: e?.message ?? "Failed" });
    }
  };

  const doSetRecommended = async (key: string | null) => {
    if (!token) return;
    try {
      await setRecommendedPlan(token, key);
      setMsg({
        kind: "ok",
        text: key
          ? `${key} is now the recommended plan on the pricing page.`
          : "No plan is marked as recommended any more.",
      });
      reload();
    } catch (e: any) {
      setMsg({
        kind: "err",
        text:
          e?.message === "unknown_recommendable_plan"
            ? "Only a published public plan can be the recommended one."
            : e?.message ?? "Could not change the recommendation.",
      });
    }
  };

  const doPreview = async (id: string) => {
    if (!token) return;
    try {
      setPreview(await previewPublish(token, id));
    } catch (e: any) {
      setMsg({ kind: "err", text: e?.message ?? "Failed" });
    }
  };

  const doPublish = async (id: string) => {
    if (!token) return;
    try {
      const r = await publishPlan(token, id);
      setPreview(null);
      setMsg({
        kind: "ok",
        text: `Published ${r.published.key} v${r.published.version}${
          r.retired ? `. v${r.retired} retired - organizations on it keep their terms.` : "."
        }`,
      });
      reload();
    } catch (e: any) {
      setMsg({ kind: "err", text: e?.message ?? "Failed" });
    }
  };

  return (
    <SystemLayout>
      <div className="h-screen overflow-y-auto p-6">
        <header className="mb-5">
          <h1 className="text-2xl font-bold text-gray-900">Plans &amp; Pricing</h1>
          <p className="mt-0.5 text-sm text-gray-400">
            The commercial catalog customers see. Internal cost lives on Unit Economics and Conversation Cost.
          </p>
        </header>

        <nav className="mb-6 flex flex-wrap gap-1 border-b border-gray-200">
          {(
            [
              ["plans", "Plans"],
              ["estimation", "Public estimate"],
              ["packages", "Credit packages"],
              ["currency", "Currency"],
              ["evaluation", "POC / Trial"],
            ] as Array<[Tab, string]>
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={clsx(
                "-mb-px border-b-2 px-3.5 py-2 text-sm font-medium transition",
                tab === k ? "border-gray-900 text-gray-900" : "border-transparent text-gray-400 hover:text-gray-700",
              )}
            >
              {label}
            </button>
          ))}
        </nav>

        {msg && (
          <div
            className={clsx(
              "mb-5 rounded-xl border px-4 py-2.5 text-sm",
              msg.kind === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-red-200 bg-red-50 text-red-700",
            )}
          >
            {msg.text}
          </div>
        )}

        {loading ? (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-24 animate-pulse rounded-2xl bg-gray-50" />
            ))}
          </div>
        ) : (
          <>
            {tab === "plans" && (
              <PlansTab
                plans={plans}
                features={features}
                globalChatRatio={
                  estimations.find((c) => c.scope === "GLOBAL" && c.active)?.chatCreditsPerEstimatedConversation ?? null
                }
                onCreateVersion={doCreateVersion}
                onPreview={doPreview}
                onDiscard={doDiscardDraft}
                onCreatePlan={doCreatePlan}
                onSetRecommended={doSetRecommended}
              />
            )}
            {tab === "estimation" && (
              <EstimationTab
                token={token!}
                configs={estimations}
                plans={plans}
                onPublished={() => { setMsg({ kind: "ok", text: "New estimation version published. Existing subscriptions keep their snapshot." }); reload(); }}
              />
            )}
            {tab === "packages" && (
              <PackagesTab
                packages={packages}
                token={token!}
                onChanged={(text) => { setMsg({ kind: "ok", text }); reload(); }}
                onError={(text) => setMsg({ kind: "err", text })}
              />
            )}
            {tab === "currency" && (
              <CurrencyTab
                data={currency}
                onRefresh={async () => {
                  if (!token) return;
                  const r = await refreshFx(token);
                  setMsg({ kind: "ok", text: `Rate ${r.fx.rate} (${r.fx.source}${r.fx.isFallback ? ", fallback" : ""})` });
                  reload();
                }}
              />
            )}
            {tab === "evaluation" && <EvaluationTab templates={templates} />}
          </>
        )}

        {preview && (
          <PublishDialog preview={preview} onCancel={() => setPreview(null)} onConfirm={() => doPublish(preview.draft.id)} />
        )}
      </div>
    </SystemLayout>
  );
}

// ─── Plans ──────────────────────────────────────────────────────────────────

/**
 * Which versions the list is showing.
 *
 * Every version of every plan in one flat list was unreadable the moment a
 * second version existed: a retired v1 and a half-finished draft v3 sat between
 * two live plans, all looking equally real. These are the three questions
 * anyone actually has - what is live, what am I working on, what did we sell
 * before - so the list answers one at a time.
 */
type PlanScope = "live" | "drafts" | "history";

const SCOPE_OF: Record<string, PlanScope> = {
  ACTIVE: "live",
  DRAFT: "drafts",
  RETIRED: "history",
  ARCHIVED: "history",
};

const SCOPE_EMPTY: Record<PlanScope, string> = {
  live: "No published plan versions. A draft becomes live when it is published.",
  drafts: "No drafts in progress. Every plan here is exactly what customers can buy.",
  history: "Nothing retired yet. Superseded versions land here and keep their subscribers.",
};

function PlansTab({
  plans, features, globalChatRatio, onCreateVersion, onPreview, onDiscard, onCreatePlan, onSetRecommended,
}: {
  plans: AdminPlan[];
  features: AdminFeature[];
  /** The assumption a plan follows when it has no ratio of its own. */
  globalChatRatio: number | null;
  onCreateVersion: (key: string) => void;
  onPreview: (id: string) => void;
  onDiscard: (id: string, key: string, version: number) => void;
  onCreatePlan: (key: string, kind: string, name: string) => void;
  onSetRecommended: (key: string | null) => void;
}) {
  const unbuilt = features.filter((f) => !f.implemented);
  const [creating, setCreating] = useState(false);
  const [scope, setScope] = useState<PlanScope>("live");
  const [nk, setNk] = useState({ key: "", name: "", kind: "PUBLIC" });

  const counts: Record<PlanScope, number> = { live: 0, drafts: 0, history: 0 };
  for (const p of plans) counts[SCOPE_OF[p.status] ?? "history"] += 1;
  const visible = plans.filter((p) => (SCOPE_OF[p.status] ?? "history") === scope);
  // How many other versions of the same plan exist, so a live card can say what
  // the filter is hiding instead of pretending it is the only one.
  const versionsOf = (key: string) => plans.filter((p) => p.key === key).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 rounded-xl bg-gray-100 p-1">
          {(
            [
              ["live", "Live"],
              ["drafts", "Drafts"],
              ["history", "History"],
            ] as Array<[PlanScope, string]>
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setScope(k)}
              aria-pressed={scope === k}
              className={clsx(
                "rounded-lg px-3 py-1.5 text-xs font-medium transition",
                scope === k ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-900",
              )}
            >
              {label}
              <span className={clsx("ml-1.5 tabular-nums", scope === k ? "text-gray-400" : "text-gray-400")}>
                {counts[k]}
              </span>
            </button>
          ))}
        </div>
        <button
          onClick={() => setCreating((v) => !v)}
          className="rounded-lg bg-gray-900 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-gray-800"
        >
          {creating ? "Cancel" : "New plan"}
        </button>
      </div>

      {creating && (
        <div className="rounded-2xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-900">New plan</h3>
          <p className="mt-1 text-[13px] leading-relaxed text-gray-500">
            Created as a draft, so it is reviewed before anyone can be put on it. A proof of
            concept or trial is time-boxed and never appears on the public pricing page.
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-medium text-gray-700">Key</span>
              <input
                value={nk.key}
                onChange={(e) => setNk({ ...nk, key: e.target.value })}
                placeholder="pilot_q3"
                className={PKG_INPUT}
              />
              <span className="mt-1 block text-[11.5px] text-gray-500">Permanent. Subscriptions reference it.</span>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-medium text-gray-700">Name</span>
              <input value={nk.name} onChange={(e) => setNk({ ...nk, name: e.target.value })} className={PKG_INPUT} />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-medium text-gray-700">Kind</span>
              <select value={nk.kind} onChange={(e) => setNk({ ...nk, kind: e.target.value })} className={PKG_INPUT}>
                <option value="PUBLIC">Public - sold on the pricing page</option>
                <option value="POC">Proof of concept - time-boxed</option>
                <option value="TRIAL">Trial - time-boxed</option>
              </select>
            </label>
          </div>
          <button
            disabled={!nk.key.trim()}
            onClick={() => { onCreatePlan(nk.key.trim(), nk.kind, nk.name.trim() || nk.key.trim()); setCreating(false); setNk({ key: "", name: "", kind: "PUBLIC" }); }}
            className="mt-4 rounded-xl bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
          >
            Create draft
          </button>
        </div>
      )}

      {unbuilt.length > 0 && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-medium text-amber-900">
            {unbuilt.length} catalogued {unbuilt.length === 1 ? "capability is" : "capabilities are"} not built yet
          </p>
          <p className="mt-1 text-xs leading-relaxed text-amber-800">
            These cannot be attached to a plan and never render on a pricing page. The API refuses them:{" "}
            <span className="font-mono">{unbuilt.map((f) => f.key).join(", ")}</span>
          </p>
        </div>
      )}

      {visible.length === 0 && (
        <p className="rounded-2xl border border-dashed border-gray-200 px-5 py-8 text-center text-[13px] text-gray-500">
          {SCOPE_EMPTY[scope]}
        </p>
      )}

      <div className="space-y-3">
        {visible.map((p) => (
          <div key={p.id} className="rounded-2xl border border-gray-200 bg-white p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-semibold text-gray-900">{p.name}</h3>
                  <span className="font-mono text-xs text-gray-400">
                    {p.key} v{p.version}
                  </span>
                  <span className={clsx("rounded-full border px-2 py-0.5 text-[11px] font-medium", STATUS_STYLE[p.status])}>
                    {p.status}
                  </span>
                  <span className={clsx("rounded-full px-2 py-0.5 text-[11px] font-medium", KIND_STYLE[p.kind])}>{p.kind}</span>
                  {p.recommended && (
                    <span className="rounded-full bg-gray-900 px-2 py-0.5 text-[11px] font-medium text-white">Recommended</span>
                  )}
                </div>
                {p.descriptionEn && <p className="mt-1 text-sm text-gray-500">{p.descriptionEn}</p>}
                <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm text-gray-600">
                  <span>
                    <span className="text-gray-400">Price</span>{" "}
                    <span className="font-medium" dir="ltr">
                      {p.basePrice ? `${p.currency} ${p.basePrice}` : "sales-only"}
                    </span>
                  </span>
                  <span>
                    <span className="text-gray-400">Credits</span>{" "}
                    <span className="font-medium" dir="ltr">
                      {p.includedCredits.toLocaleString()}
                      {p.voiceCredits > 0 && (
                        <span className="font-normal text-gray-400">
                          {" "}
                          ({(p.includedCredits - p.voiceCredits).toLocaleString()} chat ·{" "}
                          {p.voiceCredits.toLocaleString()} voice)
                        </span>
                      )}
                    </span>
                  </span>
                  <span>
                    <span className="text-gray-400">Volume</span>{" "}
                    <span className="font-medium">
                      {p.chatVolumeEnabled ? "chat" : ""}
                      {p.chatVolumeEnabled && p.voiceVolumeEnabled ? " + " : ""}
                      {p.voiceVolumeEnabled ? "voice" : ""}
                      {!p.chatVolumeEnabled && !p.voiceVolumeEnabled ? "fixed" : ""}
                    </span>
                  </span>
                  <span>
                    <span className="text-gray-400">Support</span> <span className="font-medium">{p.supportLevel ?? "-"}</span>
                  </span>
                  {/* The number that makes publishing safe or reckless. */}
                  <span>
                    <span className="text-gray-400">Organizations</span>{" "}
                    <span className="font-medium tabular-nums">{p.subscriberCount}</span>
                  </span>
                </div>
              </div>

              <div className="flex shrink-0 flex-col items-end gap-2">
                {p.status === "DRAFT" ? (
                  <div className="flex gap-2">
                    {/* The action the success message has always promised and
                        the UI never offered: a draft could only be published
                        exactly as it was seeded. */}
                    <Link
                      href={`/system/plans/${p.id}`}
                      className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                    >
                      Edit
                    </Link>
                    <button
                      onClick={() => onPreview(p.id)}
                      className="rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-gray-800"
                    >
                      Preview &amp; publish
                    </button>
                    <button
                      onClick={() => onDiscard(p.id, p.key, p.version)}
                      className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-700 hover:border-red-400"
                    >
                      Discard
                    </button>
                  </div>
                ) : p.status === "ACTIVE" ? (
                  <div className="flex gap-2">
                    {/* Which plan the pricing page badges is presentation, not
                        commercial terms - no subscription snapshots it - so it
                        is set here rather than costing a whole new version. */}
                    {p.kind === "PUBLIC" && (
                      <button
                        onClick={() => onSetRecommended(p.recommended ? null : p.key)}
                        aria-pressed={p.recommended}
                        title={
                          p.recommended
                            ? "Remove the recommended badge from the pricing page"
                            : "Badge this plan as recommended on the pricing page"
                        }
                        className={clsx(
                          "rounded-lg border px-3 py-1.5 text-xs font-medium",
                          p.recommended
                            ? "border-gray-900 bg-gray-900 text-white hover:bg-gray-800"
                            : "border-gray-300 text-gray-700 hover:bg-gray-50",
                        )}
                      >
                        {p.recommended ? "★ Recommended" : "☆ Recommend"}
                      </button>
                    )}
                    <button
                      onClick={() => onCreateVersion(p.key)}
                      className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                    >
                      New draft version
                    </button>
                  </div>
                ) : null}
                {p.status === "ACTIVE" && (
                  <span className="text-[11px] text-gray-400">
                    Published versions are immutable
                    {versionsOf(p.key) > 1 && ` · ${versionsOf(p.key) - 1} other version${versionsOf(p.key) > 2 ? "s" : ""}`}
                  </span>
                )}
              </div>
            </div>

            {p.volumeOptions.length > 0 && (
              <div className="mt-4 border-t border-gray-100 pt-3">
                {/* Options are seeded for every plan; whether a customer can
                    PICK one is the plan's selector toggle. Saying so stops this
                    list reading as "Foundation offers five chat tiers". */}
                {(!p.chatVolumeEnabled || !p.voiceVolumeEnabled) && (
                  <p className="mb-1.5 text-[11px] text-gray-400">
                    {!p.chatVolumeEnabled && !p.voiceVolumeEnabled
                      ? "Configured but not offered - both selectors are off for this plan."
                      : !p.voiceVolumeEnabled
                        ? "Voice options are configured but not offered on this plan."
                        : "Chat options are configured but not offered on this plan."}
                  </p>
                )}
                <div className="flex flex-wrap gap-1.5">
                  {p.volumeOptions.map((o) => (
                    <span
                      key={o.id}
                      className={clsx(
                        "rounded-lg border px-2 py-1 text-[11px]",
                        !o.enabled
                          ? "border-gray-100 text-gray-300 line-through"
                          : (o.channel === "CHAT" && !p.chatVolumeEnabled) || (o.channel === "VOICE" && !p.voiceVolumeEnabled)
                            ? "border-dashed border-gray-200 text-gray-400"
                            : "border-gray-200 text-gray-600",
                      )}
                      dir="ltr"
                    >
                      {o.channel.toLowerCase()} {o.dailyVolume}/day · +{o.additionalCredits.toLocaleString()} cr · +
                      {o.currency} {o.additionalPrice}
                      {o.isDefault ? " · default" : ""}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {p.estimation && (
              <p className="mt-3 text-[11px] text-gray-400">
                Public estimate: {p.estimation.chatCreditsPerEstimatedConversation} credits/chat ·{" "}
                {p.estimation.voiceCreditsPerEstimatedCall} credits/call · {p.estimation.businessDaysPerMonth} business days
                <span className="ms-1 text-gray-300">(plan-scoped v{p.estimation.version})</span>
              </p>
            )}

            {/* What the plan's own numbers imply, next to what is configured.
                The pricing page shows the advertised volume, so a divergence
                here is a margin decision, not a display bug - and it has to be
                visible to be decided. */}
            {(() => {
              const implied = impliedRatioFor(p);
              if (implied == null) return null;
              const configured = p.estimation?.chatCreditsPerEstimatedConversation ?? globalChatRatio;
              const diverges = configured != null && Math.abs(configured - implied) > 0.05;
              return (
                <p className={clsx("mt-1 text-[11px]", diverges ? "text-amber-700" : "text-gray-400")}>
                  Advertised {defaultChatTier(p)!.dailyVolume}/day implies{" "}
                  <span className="font-medium tabular-nums" dir="ltr">
                    {implied}
                  </span>{" "}
                  credits per conversation
                  {diverges && (
                    <>
                      {" "}
                      - the configured assumption says{" "}
                      <span className="font-medium tabular-nums" dir="ltr">
                        {configured}
                      </span>
                      . Give this plan its own ratio, or change its allowance.
                    </>
                  )}
                </p>
              );
            })()}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Publish dialog ─────────────────────────────────────────────────────────

function PublishDialog({
  preview, onCancel, onConfirm,
}: { preview: PublishPreview; onCancel: () => void; onConfirm: () => void }) {
  const c = preview.changes;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl">
        <h4 className="text-base font-semibold text-gray-900">
          Publish {preview.draft.key} v{preview.draft.version}
        </h4>
        <p className="mt-1 text-sm text-gray-500">
          {preview.currentVersion != null ? `Replaces v${preview.currentVersion} for NEW subscribers.` : "First published version."}
        </p>

        <dl className="mt-4 space-y-2 rounded-xl bg-gray-50 p-4 text-sm">
          <Row label="Price" from={c.price.from ? `${c.currency.from} ${c.price.from}` : "-"} to={c.price.to ? `${c.currency.to} ${c.price.to}` : "-"} />
          <Row label="Included credits" from={c.includedCredits.from?.toLocaleString() ?? "-"} to={c.includedCredits.to.toLocaleString()} />
          <Row label="Volume options" from={String(c.volumeOptions.from)} to={String(c.volumeOptions.to)} />
        </dl>

        {c.features.length > 0 && (
          <div className="mt-3">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Feature changes</p>
            <ul className="mt-1 space-y-0.5 text-sm">
              {c.features.map((f) => (
                <li key={f.key} className="flex justify-between gap-2">
                  <span className="font-mono text-xs text-gray-600">{f.key}</span>
                  <span className={f.to ? "text-emerald-700" : "text-red-700"}>
                    {f.from === null ? "new" : f.from ? "on" : "off"} → {f.to ? "on" : "off"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {c.limits.length > 0 && (
          <div className="mt-3">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Limit changes</p>
            <ul className="mt-1 space-y-0.5 text-sm">
              {c.limits.map((l) => (
                <li key={l.key} className="flex justify-between gap-2">
                  <span className="font-mono text-xs text-gray-600">{l.key}</span>
                  <span className="tabular-nums text-gray-700" dir="ltr">
                    {l.from ?? "-"} → {l.to}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* The blast radius, stated plainly. */}
        <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-3">
          <p className="text-sm font-medium text-blue-900">
            {preview.impact.organizationsOnPreviousVersion} organization
            {preview.impact.organizationsOnPreviousVersion === 1 ? "" : "s"} on the previous version
          </p>
          <p className="mt-1 text-xs leading-relaxed text-blue-800">{preview.impact.grandfathering}</p>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onCancel} className="rounded-lg px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700">
            Cancel
          </button>
          <button onClick={onConfirm} className="rounded-lg bg-gray-900 px-4 py-1.5 text-sm font-semibold text-white hover:bg-gray-800">
            Publish
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, from, to }: { label: string; from: string; to: string }) {
  const changed = from !== to;
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-gray-500">{label}</dt>
      <dd className={clsx("tabular-nums", changed ? "font-semibold text-gray-900" : "text-gray-400")} dir="ltr">
        {changed ? `${from} → ${to}` : to}
      </dd>
    </div>
  );
}

// ─── Public estimation ──────────────────────────────────────────────────────

function EstimationTab({
  token, configs, plans, onPublished,
}: { token: string; configs: EstimationConfig[]; plans: AdminPlan[]; onPublished: () => void }) {
  // Scope: the global assumption, or one plan's own. A plan whose credit
  // allowance does not divide into the volume it advertises needs its own
  // ratio - that is exactly what a PLAN-scoped version is for.
  const [planId, setPlanId] = useState<string>("");
  const targetPlan = plans.find((p) => p.id === planId) ?? null;
  const scope: "GLOBAL" | "PLAN" = planId ? "PLAN" : "GLOBAL";

  const activeGlobal = configs.find((c) => c.scope === "GLOBAL" && c.active);
  const activeForTarget = targetPlan
    ? configs.find((c) => c.scope === "PLAN" && c.active && c.planKey === targetPlan.key)
    : undefined;
  const active = activeForTarget ?? activeGlobal;

  const [chat, setChat] = useState(active?.chatCreditsPerEstimatedConversation ?? 8);
  const [voice, setVoice] = useState(active?.voiceCreditsPerEstimatedCall ?? 20);
  const [days, setDays] = useState(active?.businessDaysPerMonth ?? 25);
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<EstimationPreview | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Switching scope loads the values in force for it, so an operator never
  // publishes the global ratio onto a plan by accident.
  const selectScope = (id: string) => {
    setPlanId(id);
    setPreview(null);
    const p = plans.find((x) => x.id === id);
    const inForce =
      (p ? configs.find((c) => c.scope === "PLAN" && c.active && c.planKey === p.key) : undefined) ?? activeGlobal;
    setChat(inForce?.chatCreditsPerEstimatedConversation ?? 8);
    setVoice(inForce?.voiceCreditsPerEstimatedCall ?? 20);
    setDays(inForce?.businessDaysPerMonth ?? 25);
  };

  const body = () => ({
    chatCreditsPerEstimatedConversation: chat,
    voiceCreditsPerEstimatedCall: voice,
    businessDaysPerMonth: days,
    scope,
    planId: planId || null,
  });

  const doPreview = async () => {
    setErr(null);
    try {
      setPreview(await previewEstimation(token, body()));
    } catch (e: any) {
      setErr(e?.message ?? "Preview failed");
    }
  };

  const doPublish = async () => {
    setErr(null);
    try {
      await publishEstimation(token, { ...body(), internalNote: note || null });
      setPreview(null);
      onPublished();
    } catch (e: any) {
      setErr(e?.message ?? "Publish failed");
    }
  };

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-gray-200 bg-white p-5">
        <h3 className="font-semibold text-gray-900">Public commercial estimate</h3>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-gray-500">
          A deliberate commercial assumption, set by hand. It is not the platform average and is never derived from
          actual usage. It changes what pricing pages SAY - never consumed credits, ledger balances, invoices, or the
          terms of any existing subscription.
        </p>
        <p className="mt-2 max-w-2xl text-[11px] leading-relaxed text-gray-400">
          Where a plan sells an explicit volume - &quot;50 conversations per business day&quot; - that volume is what the
          pricing page shows. This ratio is the fallback for plans with no volume selector, and the yardstick the plan
          list uses to flag an allowance that does not cover what is advertised.
        </p>

        <label className="mt-4 block">
          <span className="text-xs font-medium uppercase tracking-wide text-gray-400">Applies to</span>
          <select
            value={planId}
            onChange={(e) => selectScope(e.target.value)}
            className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:border-gray-400 sm:max-w-md"
          >
            <option value="">All plans (global assumption)</option>
            {plans
              .filter((p) => p.status === "ACTIVE" || p.status === "DRAFT")
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.key} v{p.version} ({p.status.toLowerCase()}) - own ratio
                </option>
              ))}
          </select>
        </label>
        {targetPlan && (
          <p className="mt-1.5 text-[11px] text-gray-500">
            {activeForTarget
              ? `${targetPlan.key} already has its own ratio (v${activeForTarget.version}). Publishing replaces it.`
              : `${targetPlan.key} currently follows the global assumption. Publishing gives it its own.`}
            {impliedRatioFor(targetPlan) != null && (
              <>
                {" "}
                Its default chat tier implies{" "}
                <span className="font-medium tabular-nums" dir="ltr">
                  {impliedRatioFor(targetPlan)}
                </span>{" "}
                credits per conversation.
              </>
            )}
          </p>
        )}

        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <Field label="Credits per estimated chat" value={chat} onChange={setChat} />
          <Field label="Credits per estimated call" value={voice} onChange={setVoice} />
          <Field label="Business days per month" value={days} onChange={setDays} />
        </div>

        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Internal note (why this change?)"
          className="mt-4 w-full rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:border-gray-400"
        />

        {err && <p className="mt-3 text-sm text-red-600">{err}</p>}

        <div className="mt-4 flex gap-2">
          <button onClick={doPreview} className="rounded-lg border border-gray-300 px-3.5 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50">
            Preview impact
          </button>
          <button
            onClick={doPublish}
            disabled={!preview}
            className="rounded-lg bg-gray-900 px-3.5 py-1.5 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-40"
          >
            Publish new version
          </button>
        </div>
        {!preview && <p className="mt-2 text-[11px] text-gray-400">Preview the impact before publishing.</p>}
      </div>

      {preview && (
        <div className="rounded-2xl border border-gray-200 bg-white p-5">
          <h4 className="font-semibold text-gray-900">Impact preview</h4>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[34rem] text-sm">
              <thead className="text-[11px] uppercase tracking-wide text-gray-400">
                <tr>
                  <th className="py-2 text-start">Plan</th>
                  <th className="py-2 text-end">Chats / mo</th>
                  <th className="py-2 text-end">Chats / day</th>
                  <th className="py-2 text-end">Calls / mo</th>
                  <th className="py-2 text-end">Price / chat</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {preview.affectedPlans.map((p) => (
                  <tr key={`${p.key}-${p.version}`}>
                    <td className="py-2 font-mono text-xs text-gray-700">
                      {p.key} v{p.version}
                    </td>
                    <Delta before={p.before.monthlyChats} after={p.after.monthlyChats} />
                    <Delta before={p.before.dailyChats} after={p.after.dailyChats} />
                    <Delta before={p.before.monthlyCalls} after={p.after.monthlyCalls} />
                    <td className="py-2 text-end tabular-nums" dir="ltr">
                      <span className="text-gray-400">{p.before.pricePerChat ?? "-"}</span>
                      <span className="mx-1 text-gray-300">→</span>
                      <span className="font-semibold text-gray-900">{p.after.pricePerChat ?? "-"}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-3">
            <p className="text-sm font-medium text-blue-900">
              {preview.impact.subscriptionsRetainingTheirSnapshot} existing subscription
              {preview.impact.subscriptionsRetainingTheirSnapshot === 1 ? "" : "s"} keep their snapshot
            </p>
            <p className="mt-1 text-xs leading-relaxed text-blue-800">{preview.impact.guarantee}</p>
          </div>
        </div>
      )}

      <div className="rounded-2xl border border-gray-200 bg-white p-5">
        <h4 className="font-semibold text-gray-900">Version history</h4>
        <ul className="mt-3 divide-y divide-gray-100 text-sm">
          {configs.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="text-gray-600">
                <span className="font-mono text-xs">{c.scope}</span> v{c.version}
                {c.planKey ? ` · ${c.planKey}` : ""} {c.active && <span className="ms-1 text-emerald-600">active</span>}
              </span>
              <span className="tabular-nums text-gray-500" dir="ltr">
                {c.chatCreditsPerEstimatedConversation} chat · {c.voiceCreditsPerEstimatedCall} call · {c.businessDaysPerMonth} days
              </span>
              {c.internalNote && <span className="w-full text-[11px] text-gray-400">{c.internalNote}</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Delta({ before, after }: { before: number; after: number }) {
  const changed = before !== after;
  return (
    <td className="py-2 text-end tabular-nums" dir="ltr">
      {changed ? (
        <>
          <span className="text-gray-400">{before.toLocaleString()}</span>
          <span className="mx-1 text-gray-300">→</span>
          <span className={clsx("font-semibold", after < before ? "text-red-700" : "text-emerald-700")}>
            {after.toLocaleString()}
          </span>
        </>
      ) : (
        <span className="text-gray-400">{after.toLocaleString()}</span>
      )}
    </td>
  );
}

function Field({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="block">
      <span className="text-xs font-medium uppercase tracking-wide text-gray-400">{label}</span>
      <input
        type="number"
        min={0}
        step="0.1"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2 text-sm tabular-nums outline-none focus:border-gray-400"
        dir="ltr"
      />
    </label>
  );
}

// ─── Packages ───────────────────────────────────────────────────────────────

/**
 * The credit packages a customer can buy.
 *
 * Editable in place. The previous version rendered the same rows read-only
 * while savePackage sat in the API client, called from nowhere - so a package's
 * price could be read here and changed only in the database.
 *
 * Removing one is deliberately not always possible. A package a tenant's
 * automatic top-up points at, or one anybody has ever bought, is refused by the
 * server: the first would silently break their top-up, and the second is the
 * row that explains a real charge. Both are retired instead, which takes them
 * off sale and keeps the record.
 */
function PackagesTab({
  packages,
  token,
  onChanged,
  onError,
}: {
  packages: AdminPackage[];
  token: string;
  onChanged: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});

  function open(p: AdminPackage | null) {
    setEditing(p?.key ?? "__new__");
    setForm({
      key: p?.key ?? "",
      name: p?.name ?? "",
      nameHe: p?.nameHe ?? "",
      credits: String(p?.credits ?? ""),
      price: String(p?.price ?? ""),
      currency: p?.currency ?? "USD",
      status: p?.status ?? "DRAFT",
      discountLabel: p?.discountLabel ?? "",
      customerVisible: String(p?.customerVisible ?? true),
      sortOrder: String(p?.sortOrder ?? 0),
    });
  }

  async function save() {
    const key = form.key.trim();
    if (!key) return onError("A package needs a key.");
    setBusy(true);
    try {
      await savePackage(token, key, {
        name: form.name || key,
        nameHe: form.nameHe || null,
        credits: Number(form.credits) || 0,
        price: Number(form.price) || 0,
        currency: form.currency,
        status: form.status,
        customerVisible: form.customerVisible === "true",
        discountLabel: form.discountLabel || null,
        sortOrder: Number(form.sortOrder) || 0,
      });
      setEditing(null);
      onChanged(`Package ${key} saved.`);
    } catch (e: any) {
      onError(e?.message ?? "Could not save the package.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(p: AdminPackage) {
    // Asked plainly, because the server may refuse and the reason matters more
    // than the confirmation.
    if (!confirm(`Remove the package "${p.name}"? Retiring it is usually the right choice if anyone has bought it.`)) return;
    setBusy(true);
    try {
      await deletePackage(token, p.key);
      onChanged(`Package ${p.key} removed.`);
    } catch (e: any) {
      onError(packageError(e?.message));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="mb-3 flex justify-end">
        <button
          onClick={() => open(null)}
          className="rounded-lg bg-gray-900 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-gray-800"
        >
          New package
        </button>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-gray-200 bg-white">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-400">
            <tr>
              <th className="px-4 py-2.5 text-start">Package</th>
              <th className="px-4 py-2.5 text-end">Credits</th>
              <th className="px-4 py-2.5 text-end">Price</th>
              <th className="px-4 py-2.5 text-end">Per credit</th>
              <th className="px-4 py-2.5 text-center">Status</th>
              <th className="px-4 py-2.5 text-center">Visible</th>
              <th className="px-4 py-2.5 text-start">Expiry</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {packages.map((p) => (
              <tr key={p.key}>
                <td className="px-4 py-2.5">
                  <span className="font-medium text-gray-800">{p.name}</span>
                  {p.discountLabel && <span className="ms-2 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] text-emerald-700">{p.discountLabel}</span>}
                  <span className="block font-mono text-[11px] text-gray-400">{p.key}</span>
                </td>
                <td className="px-4 py-2.5 text-end tabular-nums" dir="ltr">{p.credits.toLocaleString()}</td>
                <td className="px-4 py-2.5 text-end tabular-nums" dir="ltr">{p.currency} {p.price}</td>
                <td className="px-4 py-2.5 text-end font-mono text-xs text-gray-500" dir="ltr">
                  {(Number(p.price) / p.credits).toFixed(4)}
                </td>
                <td className="px-4 py-2.5 text-center">
                  <span className={clsx("rounded-full border px-2 py-0.5 text-[11px]", STATUS_STYLE[p.status] ?? STATUS_STYLE.RETIRED)}>
                    {p.status}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-center text-gray-500">{p.customerVisible ? "yes" : "no"}</td>
                <td className="px-4 py-2.5 text-gray-500">
                  {p.expiryPolicy === "NEVER" ? "never" : p.expiryPolicy === "PERIOD_END" ? "period end" : `${p.expiryDays}d`}
                </td>
                <td className="px-4 py-2.5 text-end">
                  <div className="flex justify-end gap-2">
                    <button
                      disabled={busy}
                      onClick={() => open(p)}
                      className="rounded-lg border border-gray-300 px-2.5 py-1 text-[11.5px] font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                    >
                      Edit
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => remove(p)}
                      className="rounded-lg border border-red-200 px-2.5 py-1 text-[11.5px] font-medium text-red-700 hover:border-red-400 disabled:opacity-50"
                    >
                      Remove
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <div className="mt-4 rounded-2xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-900">
            {editing === "__new__" ? "New package" : `Edit ${editing}`}
          </h3>
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            <PkgField label="Key" hint="Permanent. Purchases reference it.">
              <input
                value={form.key}
                disabled={editing !== "__new__"}
                onChange={(e) => setForm({ ...form, key: e.target.value })}
                className={PKG_INPUT}
              />
            </PkgField>
            <PkgField label="Name"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={PKG_INPUT} /></PkgField>
            <PkgField label="Name (Hebrew)"><input dir="rtl" value={form.nameHe} onChange={(e) => setForm({ ...form, nameHe: e.target.value })} className={PKG_INPUT} /></PkgField>
            <PkgField label="Credits"><input inputMode="numeric" dir="ltr" value={form.credits} onChange={(e) => setForm({ ...form, credits: e.target.value })} className={PKG_INPUT} /></PkgField>
            <PkgField label="Price"><input inputMode="decimal" dir="ltr" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} className={PKG_INPUT} /></PkgField>
            <PkgField label="Currency">
              <select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} className={PKG_INPUT}>
                <option value="USD">USD</option>
                <option value="ILS">ILS</option>
              </select>
            </PkgField>
            <PkgField label="Status" hint="Only ACTIVE is on sale.">
              <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} className={PKG_INPUT}>
                <option value="DRAFT">DRAFT</option>
                <option value="ACTIVE">ACTIVE</option>
                <option value="RETIRED">RETIRED</option>
              </select>
            </PkgField>
            <PkgField label="Visible to customers">
              <select value={form.customerVisible} onChange={(e) => setForm({ ...form, customerVisible: e.target.value })} className={PKG_INPUT}>
                <option value="true">yes</option>
                <option value="false">no</option>
              </select>
            </PkgField>
            <PkgField label="Discount label"><input value={form.discountLabel} onChange={(e) => setForm({ ...form, discountLabel: e.target.value })} className={PKG_INPUT} /></PkgField>
          </div>

          {form.credits && form.price && (
            <p className="mt-3 text-[13px] text-gray-500" dir="ltr">
              {Number(form.credits).toLocaleString()} credits for {form.currency} {form.price} ·{" "}
              {(Number(form.price) / Number(form.credits)).toFixed(4)} per credit
            </p>
          )}

          <div className="mt-4 flex gap-3">
            <button disabled={busy} onClick={save} className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50">
              {busy ? "Saving…" : "Save package"}
            </button>
            <button onClick={() => setEditing(null)} className="rounded-xl px-3 py-2 text-sm text-gray-500 hover:text-gray-700">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const PKG_INPUT =
  "w-full rounded-xl border border-gray-300 px-3 py-2 text-[14px] text-gray-900 focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900 disabled:bg-gray-50 disabled:text-gray-500";

function PkgField({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium text-gray-700">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11.5px] text-gray-500">{hint}</span>}
    </label>
  );
}

/** The refusals worth explaining rather than showing as a failed request. */
function packageError(code?: string): string {
  switch (code) {
    case "package_in_use":
      return "Organizations have automatic top-up pointing at this package. Retire it instead, or move them first.";
    case "package_already_purchased":
      return "This package explains real charges. Set its status to RETIRED instead - that takes it off sale and keeps the record.";
    default:
      return "Could not remove that package.";
  }
}

// ─── Currency ───────────────────────────────────────────────────────────────

function CurrencyTab({ data, onRefresh }: { data: CurrencyAdmin | null; onRefresh: () => void }) {
  if (!data) return null;
  const c = data.config;
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-gray-200 bg-white p-5">
        <h3 className="font-semibold text-gray-900">Display currency</h3>
        <dl className="mt-3 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
          <Pair label="Canonical pricing currency" value={c.baseCurrency} />
          <Pair label="Display currencies" value={c.displayCurrencies.join(", ")} />
          <Pair label="ILS rounding" value={`up to the nearest ₪${c.ilsRoundingIncrement}`} />
          <Pair label="Rate source" value={c.fxSource} />
          <Pair label="Refresh window" value={`${c.fxRefreshHours}h`} />
          <Pair label="Fallback USD/ILS" value={c.fallbackUsdIls} />
          <Pair
            label="Checkout currency"
            value={c.chargeInDisplayCurrency ? "display currency (ILS billing enabled)" : `${c.baseCurrency} - ILS is an estimated display conversion`}
          />
        </dl>
      </div>

      <div className="rounded-2xl border border-gray-200 bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold text-gray-900">Representative rate</h3>
            {data.fx ? (
              <p className="mt-1 text-sm text-gray-600" dir="ltr">
                1 USD = {data.fx.rate} ILS · {data.fx.source} · {data.fx.rateDate}
                {data.fx.source === "fallback" && <span className="ms-2 text-amber-700">using configured fallback</span>}
              </p>
            ) : (
              <p className="mt-1 text-sm text-gray-400">No rate cached yet.</p>
            )}
          </div>
          <button onClick={onRefresh} className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50">
            Refresh now
          </button>
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-gray-400">
          Fetched server-side and cached. A client can never supply or influence the rate, and no outbound request
          happens while a pricing page renders.
        </p>
      </div>
    </div>
  );
}

function Pair({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-gray-400">{label}</dt>
      <dd className="text-gray-800">{value}</dd>
    </div>
  );
}

// ─── Evaluation ─────────────────────────────────────────────────────────────

function EvaluationTab({ templates }: { templates: EvaluationTemplate[] }) {
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-gray-200 bg-white p-5">
        <h3 className="font-semibold text-gray-900">POC and Trial templates</h3>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-gray-500">
          Evaluation access is a REAL enforced subscription: the credit gate bites, the threshold alerts fire, and
          expiry locks the workspace down. Only a platform administrator can provision it - there is no customer
          self-activation path.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {templates.map((t) => (
          <div key={t.key} className="rounded-2xl border border-gray-200 bg-white p-5">
            <div className="flex items-center gap-2">
              <h4 className="font-semibold text-gray-900">{t.nameEn}</h4>
              <span className="rounded-full bg-teal-50 px-2 py-0.5 text-[11px] font-medium text-teal-700">{t.bannerKind}</span>
            </div>
            <dl className="mt-3 space-y-1.5 text-sm">
              <Line label="Duration" value={`${t.durationDays} days`} />
              <Line label="Credit cap" value={t.creditCap.toLocaleString()} />
              <Line label="All capabilities" value={t.allFeatures ? "yes" : "no"} />
              <Line label="Auto-renew" value={t.autoRenew ? "yes" : "no"} />
              <Line label="Auto top-up" value={t.autoPurchaseEnabled ? "yes" : "no"} />
              <Line label="Customer self-activation" value={t.customerSelfActivate ? "allowed" : "not allowed"} />
              <Line label="Credits transfer on conversion" value={t.transferRemainingCredits ? "yes" : "no"} />
            </dl>
          </div>
        ))}
      </div>
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-gray-500">{label}</dt>
      <dd className="font-medium text-gray-800" dir="ltr">{value}</dd>
    </div>
  );
}
