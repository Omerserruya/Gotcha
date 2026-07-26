"use client";

// Adjust plan - the pricing configurator.
//
// Kept OFF the main Billing page so the catalog only appears when the user
// explicitly chooses to change. Three things make this page trustworthy:
//
//   1. EVERY number comes from the server. The client sends plan and volume
//      KEYS to /pricing/quote and renders what comes back. It never computes a
//      price, a credit total or a conversation estimate locally, so what the
//      summary shows is exactly what will be charged.
//   2. Estimates are labelled as estimates, with the honest reason they vary.
//      Nothing here claims the number comes from other customers' usage.
//   3. ILS is shown as a converted display price when the charge happens in
//      USD, and says so - rather than implying the rounded shekel figure is the
//      amount that will hit the card.
//
// A change is confirmed only after the billing service (and its provider call)
// reports success: upgrades charge immediately and prorated, reductions are
// scheduled for period end so nothing already paid for is taken away early.

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { RequirePermission } from "@/components/RequirePermission";
import { track } from "@/lib/analytics";
import {
  getPricingCatalog,
  getQuote,
  applyPlanChange,
  type PricingCatalog,
  type CatalogPlan,
  type Quote,
  type VolumeOption,
} from "@/lib/api-billing";

/** Volume selection for one plan, keyed by plan so switching tabs keeps state. */
type Selection = { chat: string | null; voice: string | null };

function AdjustPlanInner() {
  const { token } = useAuth();
  const { t, locale } = useI18n();
  const router = useRouter();
  const isHe = locale === "he";

  const [catalog, setCatalog] = useState<PricingCatalog | null>(null);
  const [currency, setCurrency] = useState<string>("USD");
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [selections, setSelections] = useState<Record<string, Selection>>({});
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [confirm, setConfirm] = useState<{ plan: CatalogPlan; quote: Quote } | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);

  const dateFmt = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleDateString(isHe ? "he-IL" : undefined, { year: "numeric", month: "short", day: "numeric" }) : "";

  // ── Load the catalog ──────────────────────────────────────────────────────
  const reload = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const c = await getPricingCatalog(token, currency);
      setCatalog(c);
      // Default every plan to its own default volume options.
      setSelections((prev) => {
        const next = { ...prev };
        for (const p of c.plans) {
          if (next[p.key]) continue;
          next[p.key] = {
            chat: p.chatVolumeEnabled ? p.chatOptions.find((o) => o.isDefault)?.key ?? null : null,
            voice: p.voiceVolumeEnabled ? p.voiceOptions.find((o) => o.isDefault)?.key ?? null : null,
          };
        }
        return next;
      });
      setActiveKey((k) => k ?? c.currentPlanKey ?? c.plans.find((p) => p.recommended)?.key ?? c.plans[0]?.key ?? null);
    } catch (e: any) {
      setMsg({ kind: "err", text: e?.message ?? t("settings.billing.loadFailed") });
    } finally {
      setLoading(false);
    }
  }, [token, currency, t]);

  useEffect(() => {
    reload();
  }, [reload]);

  const activePlan = useMemo(
    () => catalog?.plans.find((p) => p.key === activeKey) ?? null,
    [catalog, activeKey],
  );

  // ── Re-quote whenever the selection changes ───────────────────────────────
  // A request counter drops stale responses, so rapid selector changes can never
  // leave the summary showing the price of a selection the user already left.
  const quoteSeq = useRef(0);
  useEffect(() => {
    if (!token || !activePlan) return;
    const sel = selections[activePlan.key] ?? { chat: null, voice: null };
    const seq = ++quoteSeq.current;
    setQuoting(true);
    getQuote(token, {
      planKey: activePlan.key,
      chatVolumeOptionKey: sel.chat,
      voiceVolumeOptionKey: sel.voice,
      currency,
    })
      .then((q) => {
        if (seq !== quoteSeq.current) return;
        setQuote(q);
      })
      .catch((e: any) => {
        if (seq !== quoteSeq.current) return;
        setMsg({ kind: "err", text: e?.message ?? t("settings.billing.loadFailed") });
      })
      .finally(() => {
        if (seq === quoteSeq.current) setQuoting(false);
      });
  }, [token, activePlan, selections, currency, t]);

  const setVolume = (planKey: string, channel: "chat" | "voice", optionKey: string) =>
    setSelections((s) => ({ ...s, [planKey]: { ...(s[planKey] ?? { chat: null, voice: null }), [channel]: optionKey } }));

  const apply = async (plan: CatalogPlan, q: Quote) => {
    if (!token) return;
    setBusy(true);
    setMsg(null);
    try {
      // Only keys travel. The server re-derives price and credits.
      const res = await applyPlanChange(token, {
        planKey: plan.key,
        chatVolumeOptionKey: q.chatVolumeOptionKey,
        voiceVolumeOptionKey: q.voiceVolumeOptionKey,
      });
      track("plan_change_confirmed", { plan: plan.key, applied: res.applied });
      router.push("/settings/billing");
    } catch (e: any) {
      setMsg({ kind: "err", text: e?.message ?? t("settings.billing.actionFailed") });
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-6xl space-y-6 p-6">
        <div className="h-9 w-64 animate-pulse rounded-xl bg-gray-100" />
        <div className="grid gap-4 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-96 animate-pulse rounded-2xl bg-gray-50" />
          ))}
        </div>
      </div>
    );
  }

  const isCurrent = (p: CatalogPlan) => catalog?.currentPlanKey === p.key;
  const sel = activePlan ? selections[activePlan.key] ?? { chat: null, voice: null } : { chat: null, voice: null };

  return (
    <div className="mx-auto max-w-6xl p-6 pb-40 lg:pb-6">
      <Link
        href="/settings/billing"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-gray-700"
      >
        <svg className="h-4 w-4 rtl:rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
        </svg>
        {t("settings.billing.backToBilling")}
      </Link>

      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="mb-8 mt-4 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-gray-900">{t("settings.billing.pricing.title")}</h1>
          <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-gray-500">
            {t("settings.billing.pricing.subtitle")}
          </p>
        </div>
        {catalog && catalog.currency.available.length > 1 && (
          <CurrencyToggle
            value={currency}
            options={catalog.currency.available}
            onChange={setCurrency}
            label={t("settings.billing.pricing.currencyLabel")}
          />
        )}
      </div>

      {msg && (
        <div
          className={`mb-6 rounded-xl border px-4 py-2.5 text-sm ${
            msg.kind === "ok" ? "border-green-200 bg-green-50 text-green-700" : "border-red-200 bg-red-50 text-red-700"
          }`}
        >
          {msg.text}
        </div>
      )}

      {/* ── Plan cards ─────────────────────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-3">
        {(catalog?.plans ?? []).map((p) => (
          <PlanCard
            key={p.key}
            plan={p}
            isHe={isHe}
            active={p.key === activeKey}
            current={isCurrent(p)}
            onSelect={() => setActiveKey(p.key)}
            t={t}
          />
        ))}
      </div>

      {/* ── Volume customization for the selected plan ─────────── */}
      {activePlan && (activePlan.chatVolumeEnabled || activePlan.voiceVolumeEnabled) && (
        <section className="mt-10">
          <h2 className="text-lg font-semibold text-gray-900">
            {t("settings.billing.pricing.customizeTitle").replace("{plan}", isHe ? activePlan.nameHe ?? activePlan.name : activePlan.name)}
          </h2>
          <p className="mt-1 text-sm text-gray-500">{t("settings.billing.pricing.customizeSubtitle")}</p>

          <div className="mt-5 space-y-6">
            {activePlan.chatVolumeEnabled && (
              <VolumeSelector
                label={t("settings.billing.pricing.chatVolume")}
                hint={t("settings.billing.pricing.perBusinessDay")}
                options={activePlan.chatOptions}
                value={sel.chat}
                onChange={(k) => setVolume(activePlan.key, "chat", k)}
                t={t}
              />
            )}
            {activePlan.voiceVolumeEnabled && (
              <VolumeSelector
                label={t("settings.billing.pricing.voiceVolume")}
                hint={t("settings.billing.pricing.perBusinessDay")}
                options={activePlan.voiceOptions}
                value={sel.voice}
                onChange={(k) => setVolume(activePlan.key, "voice", k)}
                t={t}
              />
            )}
          </div>
        </section>
      )}

      {activePlan && !activePlan.chatVolumeEnabled && !activePlan.voiceVolumeEnabled && (
        <p className="mt-8 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-600">
          {t("settings.billing.pricing.noVolumeSelector")}
        </p>
      )}

      {/* ── Feature comparison ─────────────────────────────────── */}
      {catalog && catalog.plans.length > 1 && (
        <section className="mt-10">
          <button
            onClick={() => setCompareOpen((v) => !v)}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-primary-600 hover:text-primary-700"
          >
            {compareOpen ? t("settings.billing.pricing.hideCompare") : t("settings.billing.pricing.showCompare")}
            <svg
              className={`h-4 w-4 transition-transform ${compareOpen ? "rotate-180" : ""}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
            </svg>
          </button>
          {compareOpen && <ComparisonTable plans={catalog.plans} isHe={isHe} t={t} />}
        </section>
      )}

      {/* ── Custom plan ────────────────────────────────────────── */}
      <section className="mt-10 rounded-2xl border border-gray-200 bg-gray-50/70 p-6">
        <h3 className="text-base font-semibold text-gray-900">{t("settings.billing.pricing.customTitle")}</h3>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-gray-600">
          {t("settings.billing.pricing.customBody")}
        </p>
        <a
          href="mailto:sales@gotcha.co.il"
          className="mt-3 inline-flex text-sm font-medium text-primary-600 hover:text-primary-700"
        >
          {t("settings.billing.pricing.customCta")}
        </a>
      </section>

      {/* ── Order summary ──────────────────────────────────────── */}
      {activePlan && quote && (
        <OrderSummary
          plan={activePlan}
          quote={quote}
          quoting={quoting}
          current={isCurrent(activePlan)}
          currency={catalog?.currency ?? null}
          disclaimer={isHe ? quote.disclaimer.he : quote.disclaimer.en}
          busy={busy}
          onApply={() => setConfirm({ plan: activePlan, quote })}
          isHe={isHe}
          t={t}
        />
      )}

      {/* ── Confirmation ───────────────────────────────────────── */}
      {confirm && (
        <ConfirmDialog
          plan={confirm.plan}
          quote={confirm.quote}
          currentKey={catalog?.currentPlanKey ?? null}
          currentPrice={catalog?.plans.find((p) => p.key === catalog?.currentPlanKey)?.basePrice ?? null}
          busy={busy}
          isHe={isHe}
          t={t}
          dateFmt={dateFmt}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const c = confirm;
            setConfirm(null);
            apply(c.plan, c.quote);
          }}
        />
      )}
    </div>
  );
}

// ─── Currency toggle ────────────────────────────────────────────────────────

function CurrencyToggle({
  value, options, onChange, label,
}: { value: string; options: string[]; onChange: (v: string) => void; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-medium uppercase tracking-wide text-gray-400">{label}</span>
      <div className="inline-flex rounded-xl border border-gray-200 bg-white p-0.5" dir="ltr">
        {options.map((c) => (
          <button
            key={c}
            onClick={() => onChange(c)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
              value === c ? "bg-gray-900 text-white" : "text-gray-500 hover:text-gray-800"
            }`}
          >
            {c}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Plan card ──────────────────────────────────────────────────────────────

function PlanCard({
  plan, active, current, onSelect, isHe, t,
}: {
  plan: CatalogPlan;
  active: boolean;
  current: boolean;
  onSelect: () => void;
  isHe: boolean;
  t: (k: string) => string;
}) {
  const name = isHe ? plan.nameHe ?? plan.name : plan.name;
  const description = isHe ? plan.descriptionHe ?? plan.description : plan.description;
  // Progressive disclosure: the card shows what the plan ADDS, not every feature.
  const headline = plan.features.filter((f) => f.included).slice(-4);

  return (
    <button
      onClick={onSelect}
      className={`relative flex flex-col rounded-2xl border p-6 text-start transition ${
        active ? "border-gray-900 shadow-sm ring-1 ring-gray-900" : "border-gray-200 hover:border-gray-300"
      }`}
    >
      {plan.recommended && (
        <span className="absolute -top-2.5 end-5 rounded-full bg-gray-900 px-2.5 py-0.5 text-[11px] font-semibold text-white">
          {t("settings.billing.pricing.recommended")}
        </span>
      )}

      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-lg font-semibold text-gray-900">{name}</h3>
        {current && (
          <span className="rounded-full bg-primary-50 px-2 py-0.5 text-[11px] font-medium text-primary-700">
            {t("settings.billing.currentPlan")}
          </span>
        )}
      </div>

      {description && <p className="mt-1.5 min-h-[2.5rem] text-sm leading-relaxed text-gray-500">{description}</p>}

      <div className="mt-4 flex items-baseline gap-1.5" dir="ltr">
        <span className="text-3xl font-bold tracking-tight text-gray-900">
          {plan.salesOnly ? t("settings.billing.custom") : plan.basePrice?.display.formatted ?? "-"}
        </span>
        {!plan.salesOnly && <span className="text-sm text-gray-400">/ {t("settings.billing.pricing.month")}</span>}
      </div>

      <dl className="mt-4 space-y-1.5 border-t border-gray-100 pt-4 text-sm">
        <div className="flex justify-between gap-2">
          <dt className="text-gray-500">{t("settings.billing.pricing.includedCredits")}</dt>
          <dd className="font-medium text-gray-900" dir="ltr">{plan.includedCredits.toLocaleString()}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-gray-500">{t("settings.billing.pricing.estimatedChats")}</dt>
          <dd className="font-medium text-gray-900" dir="ltr">
            ~{plan.estimate.chat.monthly.toLocaleString()}
          </dd>
        </div>
        {plan.estimate.voice.monthly > 0 && (
          <div className="flex justify-between gap-2">
            <dt className="text-gray-500">{t("settings.billing.pricing.estimatedCalls")}</dt>
            <dd className="font-medium text-gray-900" dir="ltr">~{plan.estimate.voice.monthly.toLocaleString()}</dd>
          </div>
        )}
      </dl>

      <ul className="mt-4 space-y-1.5 border-t border-gray-100 pt-4">
        {headline.map((f) => (
          <li key={f.key} className="flex items-start gap-2 text-sm text-gray-600">
            <svg className="mt-0.5 h-4 w-4 shrink-0 text-gray-900" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
            {isHe ? f.nameHe : f.nameEn}
          </li>
        ))}
      </ul>

      <span
        className={`mt-5 inline-flex w-full items-center justify-center rounded-xl px-4 py-2 text-sm font-medium ${
          active ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-700"
        }`}
      >
        {active ? t("settings.billing.pricing.configuring") : t("settings.billing.pricing.choose")}
      </span>
    </button>
  );
}

// ─── Volume selector ────────────────────────────────────────────────────────

function VolumeSelector({
  label, hint, options, value, onChange, t,
}: {
  label: string;
  hint: string;
  options: VolumeOption[];
  value: string | null;
  onChange: (key: string) => void;
  t: (k: string) => string;
}) {
  if (options.length === 0) return null;
  return (
    <div>
      <div className="mb-2.5 flex items-baseline gap-2">
        <span className="text-sm font-medium text-gray-900">{label}</span>
        <span className="text-xs text-gray-400">{hint}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => {
          const selected = value === o.key;
          const free = o.additionalPrice.display.amount === "0.00";
          return (
            <button
              key={o.key}
              onClick={() => onChange(o.key)}
              className={`rounded-xl border px-4 py-2.5 text-start transition ${
                selected ? "border-gray-900 bg-gray-900 text-white" : "border-gray-200 bg-white text-gray-700 hover:border-gray-300"
              }`}
            >
              <span className="block text-sm font-semibold" dir="ltr">{o.dailyVolume}</span>
              <span className={`block text-[11px] ${selected ? "text-white/70" : "text-gray-400"}`} dir="ltr">
                {free ? t("settings.billing.pricing.included") : `+${o.additionalPrice.display.formatted}`}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Order summary ──────────────────────────────────────────────────────────

function OrderSummary({
  plan, quote, quoting, current, currency, disclaimer, busy, onApply, isHe, t,
}: {
  plan: CatalogPlan;
  quote: Quote;
  quoting: boolean;
  current: boolean;
  currency: PricingCatalog["currency"] | null;
  disclaimer: string;
  busy: boolean;
  onApply: () => void;
  isHe: boolean;
  t: (k: string) => string;
}) {
  const e = quote.estimate;
  const money = (v: string | null) => (v == null ? "-" : `${currency?.display === "ILS" ? "₪" : "$"}${v}`);

  return (
    <div className="fixed inset-x-0 bottom-0 z-30 border-t border-gray-200 bg-white/95 p-4 backdrop-blur lg:static lg:mt-10 lg:rounded-2xl lg:border lg:bg-white lg:p-6 lg:backdrop-blur-none">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
            {t("settings.billing.pricing.summary")}
          </p>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-2xl font-bold tracking-tight text-gray-900" dir="ltr">
              {quote.monthlyPrice.display.formatted}
            </span>
            <span className="text-sm text-gray-400">/ {t("settings.billing.pricing.month")}</span>
            <span className="text-sm text-gray-500" dir="ltr">
              · {quote.includedCredits.toLocaleString()} {t("settings.billing.pricing.creditsWord")}
            </span>
            {quoting && <span className="text-xs text-gray-400">{t("settings.billing.pricing.updating")}</span>}
          </div>

          {/* Estimated capacity + per-conversation economics. */}
          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {e.chat.monthly > 0 && (
              <Stat
                label={t("settings.billing.pricing.estimatedChats")}
                value={`~${e.chat.monthly.toLocaleString()}`}
                sub={`~${e.chat.daily} ${t("settings.billing.pricing.perDayShort")}`}
              />
            )}
            {e.voice.monthly > 0 && (
              <Stat
                label={t("settings.billing.pricing.estimatedCalls")}
                value={`~${e.voice.monthly.toLocaleString()}`}
                sub={`~${e.voice.daily} ${t("settings.billing.pricing.perDayShort")}`}
              />
            )}
            {e.pricePerChat && (
              <Stat label={t("settings.billing.pricing.pricePerChat")} value={money(e.pricePerChat)} />
            )}
            {e.pricePerCall && (
              <Stat label={t("settings.billing.pricing.pricePerCall")} value={money(e.pricePerCall)} />
            )}
            {e.pricePerCall && e.pricePerChat && e.pricePerInteraction && (
              <Stat label={t("settings.billing.pricing.blended")} value={money(e.pricePerInteraction)} />
            )}
          </div>

          {/* Honest labelling: an estimate, and a converted display price. */}
          <p className="mt-3 max-w-3xl text-[11px] leading-relaxed text-gray-400">{disclaimer}</p>
          {currency?.isEstimatedConversion && currency.display !== currency.base && (
            <p className="mt-1 text-[11px] text-gray-400">
              {t("settings.billing.pricing.fxNote")
                .replace("{display}", currency.display)
                .replace("{charged}", currency.chargedCurrency)}
            </p>
          )}
        </div>

        <button
          disabled={busy || quoting || current}
          onClick={onApply}
          className="w-full shrink-0 rounded-xl bg-gray-900 px-6 py-3 text-sm font-semibold text-white transition hover:bg-gray-800 disabled:opacity-40 lg:w-auto"
        >
          {current ? t("settings.billing.pricing.currentSelection") : t("settings.billing.pricing.continue")}
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-gray-400">{label}</p>
      <p className="font-semibold text-gray-900" dir="ltr">{value}</p>
      {sub && <p className="text-[11px] text-gray-400" dir="ltr">{sub}</p>}
    </div>
  );
}

// ─── Comparison table ───────────────────────────────────────────────────────

function ComparisonTable({ plans, isHe, t }: { plans: CatalogPlan[]; isHe: boolean; t: (k: string) => string }) {
  // Union of every feature key across the plans, in catalog order.
  const keys: string[] = [];
  const meta = new Map<string, { nameEn: string; nameHe: string; category: string }>();
  for (const p of plans) {
    for (const f of p.features) {
      if (!meta.has(f.key)) {
        meta.set(f.key, { nameEn: f.nameEn, nameHe: f.nameHe, category: f.category });
        keys.push(f.key);
      }
    }
  }
  const categories = keys.reduce<string[]>((acc, k) => {
    const c = meta.get(k)!.category;
    if (!acc.includes(c)) acc.push(c);
    return acc;
  }, []);

  return (
    <div className="mt-4 overflow-x-auto rounded-2xl border border-gray-200">
      <table className="w-full min-w-[36rem] text-sm">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-4 py-3 text-start text-xs font-medium uppercase tracking-wide text-gray-400">
              {t("settings.billing.pricing.capability")}
            </th>
            {plans.map((p) => (
              <th key={p.key} className="px-4 py-3 text-center text-xs font-semibold text-gray-700">
                {isHe ? p.nameHe ?? p.name : p.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {categories.map((cat) => (
            <>
              <tr key={`h-${cat}`} className="bg-gray-50/60">
                <td colSpan={plans.length + 1} className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                  {t(`settings.billing.pricing.category.${cat}`)}
                </td>
              </tr>
              {keys
                .filter((k) => meta.get(k)!.category === cat)
                .map((k) => (
                  <tr key={k}>
                    <td className="px-4 py-2.5 text-gray-700">{isHe ? meta.get(k)!.nameHe : meta.get(k)!.nameEn}</td>
                    {plans.map((p) => {
                      const included = p.features.find((f) => f.key === k)?.included ?? false;
                      return (
                        <td key={p.key} className="px-4 py-2.5 text-center">
                          {included ? (
                            <svg className="mx-auto h-4 w-4 text-gray-900" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                            </svg>
                          ) : (
                            <span className="text-gray-300">-</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
            </>
          ))}
          {/* Numeric limits, which matter as much as the feature ticks. */}
          <tr className="bg-gray-50/60">
            <td colSpan={plans.length + 1} className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              {t("settings.billing.pricing.category.LIMITS")}
            </td>
          </tr>
          {["limit:users", "limit:ai_employees", "limit:channels", "limit:knowledge_sources"].map((lk) => (
            <tr key={lk}>
              <td className="px-4 py-2.5 text-gray-700">{t(`settings.billing.pricing.limit.${lk.replace("limit:", "")}`)}</td>
              {plans.map((p) => (
                <td key={p.key} className="px-4 py-2.5 text-center font-medium text-gray-900" dir="ltr">
                  {p.limits[lk] ?? "-"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Confirmation ───────────────────────────────────────────────────────────

function ConfirmDialog({
  plan, quote, currentKey, currentPrice, busy, isHe, t, dateFmt, onCancel, onConfirm,
}: {
  plan: CatalogPlan;
  quote: Quote;
  currentKey: string | null;
  currentPrice: CatalogPlan["basePrice"];
  busy: boolean;
  isHe: boolean;
  t: (k: string) => string;
  dateFmt: (iso: string | null | undefined) => string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // Direction decides timing, and the copy has to say which one applies -
  // "you'll be charged now" and "this starts at renewal" are very different
  // promises and getting them the wrong way round is a trust failure.
  const goingUp =
    !currentKey ||
    Number(quote.monthlyPrice.base.amount) > Number(currentPrice?.base.amount ?? 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
        <h4 className="text-base font-semibold text-gray-900">
          {t("settings.billing.changeTitle").replace("{plan}", isHe ? plan.nameHe ?? plan.name : plan.name)}
        </h4>

        <dl className="mt-4 space-y-2 rounded-xl bg-gray-50 p-4 text-sm">
          <div className="flex justify-between gap-2">
            <dt className="text-gray-500">{t("settings.billing.pricing.monthlyTotal")}</dt>
            <dd className="font-semibold text-gray-900" dir="ltr">{quote.monthlyPrice.display.formatted}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-gray-500">{t("settings.billing.pricing.includedCredits")}</dt>
            <dd className="font-medium text-gray-900" dir="ltr">{quote.includedCredits.toLocaleString()}</dd>
          </div>
          {quote.estimate.chat.monthly > 0 && (
            <div className="flex justify-between gap-2">
              <dt className="text-gray-500">{t("settings.billing.pricing.estimatedChats")}</dt>
              <dd className="font-medium text-gray-900" dir="ltr">~{quote.estimate.chat.monthly.toLocaleString()}</dd>
            </div>
          )}
          {quote.estimate.voice.monthly > 0 && (
            <div className="flex justify-between gap-2">
              <dt className="text-gray-500">{t("settings.billing.pricing.estimatedCalls")}</dt>
              <dd className="font-medium text-gray-900" dir="ltr">~{quote.estimate.voice.monthly.toLocaleString()}</dd>
            </div>
          )}
        </dl>

        <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-gray-600">
          {goingUp ? t("settings.billing.pricing.confirmUp") : t("settings.billing.pricing.confirmDown")}
        </p>

        {quote.monthlyPrice.isEstimatedConversion && (
          <p className="mt-2 text-[11px] text-gray-400">
            {t("settings.billing.pricing.chargedIn").replace("{currency}", quote.monthlyPrice.chargedCurrency)}{" "}
            <span dir="ltr">{quote.monthlyPrice.base.formatted}</span>
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onCancel} className="rounded-lg px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700">
            {t("settings.billing.back")}
          </button>
          <button
            disabled={busy}
            onClick={onConfirm}
            className="rounded-lg bg-gray-900 px-4 py-1.5 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-50"
          >
            {t("settings.billing.confirmChange")}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AdjustPlanPage() {
  return (
    <RequirePermission perm="settings:billing:manage" redirectTo="/settings/billing">
      <AdjustPlanInner />
    </RequirePermission>
  );
}
