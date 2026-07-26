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
import { SystemLayout } from "@/components/SystemLayout";
import { useAuth } from "@/context/AuthContext";
import clsx from "clsx";
import {
  listAdminPlans,
  listAdminFeatures,
  listEstimationConfigs,
  listAdminPackages,
  getCurrencyAdmin,
  listEvaluationTemplates,
  createPlanVersion,
  publishPlan,
  previewPublish,
  previewEstimation,
  publishEstimation,
  refreshFx,
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
              <PlansTab plans={plans} features={features} onCreateVersion={doCreateVersion} onPreview={doPreview} />
            )}
            {tab === "estimation" && (
              <EstimationTab token={token!} configs={estimations} onPublished={() => { setMsg({ kind: "ok", text: "New estimation version published. Existing subscriptions keep their snapshot." }); reload(); }} />
            )}
            {tab === "packages" && <PackagesTab packages={packages} />}
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

function PlansTab({
  plans, features, onCreateVersion, onPreview,
}: {
  plans: AdminPlan[];
  features: AdminFeature[];
  onCreateVersion: (key: string) => void;
  onPreview: (id: string) => void;
}) {
  const unbuilt = features.filter((f) => !f.implemented);

  return (
    <div className="space-y-6">
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

      <div className="space-y-3">
        {plans.map((p) => (
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
                    <span className="font-medium" dir="ltr">{p.includedCredits.toLocaleString()}</span>
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
                  <button
                    onClick={() => onPreview(p.id)}
                    className="rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-gray-800"
                  >
                    Preview &amp; publish
                  </button>
                ) : p.status === "ACTIVE" ? (
                  <button
                    onClick={() => onCreateVersion(p.key)}
                    className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                  >
                    New draft version
                  </button>
                ) : null}
                {p.status === "ACTIVE" && (
                  <span className="text-[11px] text-gray-400">Published versions are immutable</span>
                )}
              </div>
            </div>

            {p.volumeOptions.length > 0 && (
              <div className="mt-4 border-t border-gray-100 pt-3">
                <div className="flex flex-wrap gap-1.5">
                  {p.volumeOptions.map((o) => (
                    <span
                      key={o.id}
                      className={clsx(
                        "rounded-lg border px-2 py-1 text-[11px]",
                        o.enabled ? "border-gray-200 text-gray-600" : "border-gray-100 text-gray-300 line-through",
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
              </p>
            )}
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
  token, configs, onPublished,
}: { token: string; configs: EstimationConfig[]; onPublished: () => void }) {
  const active = configs.find((c) => c.scope === "GLOBAL" && c.active);
  const [chat, setChat] = useState(active?.chatCreditsPerEstimatedConversation ?? 8);
  const [voice, setVoice] = useState(active?.voiceCreditsPerEstimatedCall ?? 20);
  const [days, setDays] = useState(active?.businessDaysPerMonth ?? 25);
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<EstimationPreview | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const doPreview = async () => {
    setErr(null);
    try {
      setPreview(await previewEstimation(token, {
        chatCreditsPerEstimatedConversation: chat,
        voiceCreditsPerEstimatedCall: voice,
        businessDaysPerMonth: days,
        scope: "GLOBAL",
      }));
    } catch (e: any) {
      setErr(e?.message ?? "Preview failed");
    }
  };

  const doPublish = async () => {
    setErr(null);
    try {
      await publishEstimation(token, {
        chatCreditsPerEstimatedConversation: chat,
        voiceCreditsPerEstimatedCall: voice,
        businessDaysPerMonth: days,
        scope: "GLOBAL",
        internalNote: note || null,
      });
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

function PackagesTab({ packages }: { packages: AdminPackage[] }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-400">
          <tr>
            <th className="px-4 py-2.5 text-start">Package</th>
            <th className="px-4 py-2.5 text-end">Credits</th>
            <th className="px-4 py-2.5 text-end">Price</th>
            <th className="px-4 py-2.5 text-end">Per credit</th>
            <th className="px-4 py-2.5 text-center">Status</th>
            <th className="px-4 py-2.5 text-center">Visible</th>
            <th className="px-4 py-2.5 text-start">Expiry</th>
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
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
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
