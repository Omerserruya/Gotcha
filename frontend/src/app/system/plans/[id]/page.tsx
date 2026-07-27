"use client";

/**
 * Edit a DRAFT plan version.
 *
 * This screen was missing. The backend has always accepted the edits, the API
 * client has always had the functions, and the list page told whoever created a
 * draft to "edit it, preview, then publish" - while offering nowhere to do so.
 * A draft could only be published exactly as it was seeded.
 *
 * Three things shape the design.
 *
 * A draft is the ONLY place a plan can change. Published versions are immutable
 * because organizations hold a commercial snapshot of them, so this page exists
 * precisely to get it right before that becomes true. Nothing here is
 * auto-saved: leaving a half-finished price on a draft someone else publishes
 * is exactly the accident worth preventing.
 *
 * Money is shown as its effect. A price and a credit allowance mean little
 * apart; "$499 -> 2,000 credits, about $0.25 each" is the sentence someone can
 * actually judge.
 *
 * Features that are catalogued but NOT built cannot be sold. The server rejects
 * them with 422, so they render disabled with the reason attached rather than
 * letting someone toggle a capability that does not exist and discover it at
 * save time.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { SystemLayout } from "@/components/SystemLayout";
import { useAuth } from "@/context/AuthContext";
import {
  listAdminPlans,
  listAdminFeatures,
  updateDraftPlan,
  setPlanEntitlements,
  setPlanVolumeOptions,
  previewPublish,
  type AdminPlan,
  type AdminFeature,
  type AdminEntitlement,
  type AdminVolumeOption,
} from "@/lib/api-pricing-admin";

/** The fields PATCH /plans/:id accepts. Anything else is silently ignored. */
interface Draft {
  name: string;
  nameHe: string;
  descriptionEn: string;
  descriptionHe: string;
  basePrice: string;
  currency: string;
  includedCredits: string;
  supportLevel: string;
  sortOrder: string;
  chatVolumeEnabled: boolean;
  voiceVolumeEnabled: boolean;
  autoPurchaseEligible: boolean;
  creditPackagesEligible: boolean;
  internalNote: string;
}

const CATEGORY_LABEL: Record<string, string> = {
  COMMUNICATION: "Communication",
  AI: "AI",
  VOICE: "Voice",
  MANAGEMENT: "Management",
};

export default function EditPlanPage() {
  const { token } = useAuth();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const planId = String(params?.id ?? "");

  const [plan, setPlan] = useState<AdminPlan | null>(null);
  const [features, setFeatures] = useState<AdminFeature[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [entitlements, setEntitlements] = useState<Record<string, unknown>>({});
  const [volume, setVolume] = useState<AdminVolumeOption[]>([]);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [{ plans }, { features: f }] = await Promise.all([
        listAdminPlans(token),
        listAdminFeatures(token),
      ]);
      const p = plans.find((x) => x.id === planId) ?? null;
      setPlan(p);
      setFeatures(f);
      if (p) {
        setDraft({
          name: p.name ?? "",
          nameHe: p.nameHe ?? "",
          descriptionEn: p.descriptionEn ?? "",
          descriptionHe: p.descriptionHe ?? "",
          basePrice: p.basePrice ?? "",
          currency: p.currency ?? "USD",
          includedCredits: String(p.includedCredits ?? 0),
          supportLevel: p.supportLevel ?? "",
          sortOrder: String(p.sortOrder ?? 0),
          chatVolumeEnabled: p.chatVolumeEnabled,
          voiceVolumeEnabled: p.voiceVolumeEnabled,
          autoPurchaseEligible: p.autoPurchaseEligible,
          creditPackagesEligible: p.creditPackagesEligible,
          internalNote: p.internalNote ?? "",
        });
        const map: Record<string, unknown> = {};
        for (const e of p.entitlements) map[e.key] = e.value;
        setEntitlements(map);
        setVolume(p.volumeOptions ?? []);
      }
    } catch (err) {
      setError(humanError((err as Error).message));
    } finally {
      setLoading(false);
    }
  }, [token, planId]);

  useEffect(() => {
    load();
  }, [load]);

  /** What a customer effectively pays per credit. The judgeable number. */
  const perCredit = useMemo(() => {
    const price = Number(draft?.basePrice ?? 0);
    const credits = Number(draft?.includedCredits ?? 0);
    if (!price || !credits) return null;
    return (price / credits).toFixed(4);
  }, [draft?.basePrice, draft?.includedCredits]);

  async function save(): Promise<boolean> {
    if (!token || !plan || !draft) return false;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await updateDraftPlan(token, plan.id, {
        name: draft.name,
        nameHe: draft.nameHe,
        descriptionEn: draft.descriptionEn,
        descriptionHe: draft.descriptionHe,
        basePrice: draft.basePrice,
        currency: draft.currency,
        includedCredits: Number(draft.includedCredits),
        supportLevel: draft.supportLevel,
        sortOrder: Number(draft.sortOrder),
        chatVolumeEnabled: draft.chatVolumeEnabled,
        voiceVolumeEnabled: draft.voiceVolumeEnabled,
        autoPurchaseEligible: draft.autoPurchaseEligible,
        creditPackagesEligible: draft.creditPackagesEligible,
        internalNote: draft.internalNote,
      });

      const payload: AdminEntitlement[] = features
        .filter((f) => entitlements[f.key] !== undefined)
        .map((f) => ({ key: f.key, valueType: f.entitlementType, value: entitlements[f.key] }));
      if (payload.length) await setPlanEntitlements(token, plan.id, payload);

      if (volume.length) {
        await setPlanVolumeOptions(
          token,
          plan.id,
          volume.map((v) => ({
            key: v.key,
            channel: v.channel,
            dailyVolume: v.dailyVolume,
            creditsPerUnit: v.creditsPerUnit,
            additionalCredits: v.additionalCredits,
            additionalPrice: v.additionalPrice,
            currency: v.currency,
            isDefault: v.isDefault,
            enabled: v.enabled,
            sortOrder: v.sortOrder,
          })),
        );
      }

      await load();
      setSaved(true);
      return true;
    } catch (err) {
      setError(humanError((err as Error).message));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function saveAndPreview() {
    // Preview reads what is STORED, so an unsaved edit would be previewed as
    // though it had never been made - and published that way.
    if (!(await save())) return;
    if (!token || !plan) return;
    try {
      await previewPublish(token, plan.id);
      router.push("/system/plans");
    } catch (err) {
      setError(humanError((err as Error).message));
    }
  }

  if (loading) {
    return (
      <SystemLayout>
        <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
          <div className="h-40 animate-pulse rounded-2xl bg-gray-100 motion-reduce:animate-none" />
        </div>
      </SystemLayout>
    );
  }

  if (!plan || !draft) {
    return (
      <SystemLayout>
        <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
          <p className="text-sm text-gray-500">That plan version no longer exists.</p>
          <Link href="/system/plans" className="mt-3 inline-block text-sm font-medium text-gray-900 underline">
            Back to plans
          </Link>
        </div>
      </SystemLayout>
    );
  }

  // Published versions are immutable because organizations hold a snapshot of
  // them. Saying so beats a 409 from the server after someone has typed.
  if (plan.status !== "DRAFT") {
    return (
      <SystemLayout>
        <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
          <h1 className="text-2xl font-semibold tracking-tight text-gray-900">
            {plan.key} v{plan.version}
          </h1>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-gray-500">
            This version is {plan.status.toLowerCase()} and cannot be changed. Organizations on it
            hold a commercial snapshot, so editing it would alter what they already agreed to.
            Create a new draft version instead.
          </p>
          <Link href="/system/plans" className="mt-4 inline-block text-sm font-medium text-gray-900 underline">
            Back to plans
          </Link>
        </div>
      </SystemLayout>
    );
  }

  const byCategory = groupBy(features, (f) => f.category);

  return (
    <SystemLayout>
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
        <header className="mb-8">
          <Link href="/system/plans" className="text-[13px] text-gray-500 hover:text-gray-900">
            ← Plans
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-gray-900">
            {plan.key} <span className="text-gray-400">v{plan.version}</span>
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-gray-500">
            A draft changes nothing until it is published. Once published it can never be edited,
            because organizations hold a snapshot of it - so this is the moment to get it right.
          </p>
        </header>

        {/* ── Commercial terms ─────────────────────────────────────────── */}
        <section className="rounded-2xl border border-gray-200 p-5">
          <h2 className="text-sm font-semibold text-gray-900">Commercial terms</h2>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label="Name (English)">
              <input {...text(draft.name, (v) => setDraft({ ...draft, name: v }))} />
            </Field>
            <Field label="Name (Hebrew)">
              <input dir="rtl" {...text(draft.nameHe, (v) => setDraft({ ...draft, nameHe: v }))} />
            </Field>
            <Field label="Description (English)">
              <input {...text(draft.descriptionEn, (v) => setDraft({ ...draft, descriptionEn: v }))} />
            </Field>
            <Field label="Description (Hebrew)">
              <input dir="rtl" {...text(draft.descriptionHe, (v) => setDraft({ ...draft, descriptionHe: v }))} />
            </Field>
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            <Field label="Price per month">
              <input
                inputMode="decimal"
                dir="ltr"
                {...text(draft.basePrice, (v) => setDraft({ ...draft, basePrice: v }))}
              />
            </Field>
            <Field label="Currency" hint="Catalog prices are in USD; charges are converted to ILS.">
              <select
                value={draft.currency}
                onChange={(e) => setDraft({ ...draft, currency: e.target.value })}
                className={INPUT}
              >
                <option value="USD">USD</option>
                <option value="ILS">ILS</option>
              </select>
            </Field>
            <Field label="Included credits">
              <input
                inputMode="numeric"
                dir="ltr"
                {...text(draft.includedCredits, (v) => setDraft({ ...draft, includedCredits: v }))}
              />
            </Field>
          </div>

          {/* The price and the allowance mean little apart. Together they are a
              decision someone can actually judge. */}
          <div className="mt-4 rounded-xl bg-gray-50 px-4 py-3">
            <p className="text-[11px] uppercase tracking-wide text-gray-500">What this means</p>
            <p className="mt-1 text-[15px] text-gray-900" dir="ltr">
              {draft.basePrice && draft.includedCredits
                ? `${draft.currency === "USD" ? "$" : "₪"}${draft.basePrice} / month → ${Number(
                    draft.includedCredits,
                  ).toLocaleString()} credits`
                : "Set a price and a credit allowance"}
              {perCredit && (
                <span className="text-gray-500">
                  {" "}
                  · about {draft.currency === "USD" ? "$" : "₪"}
                  {perCredit} per credit
                </span>
              )}
            </p>
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label="Support level">
              <input {...text(draft.supportLevel, (v) => setDraft({ ...draft, supportLevel: v }))} />
            </Field>
            <Field label="Display order" hint="Lower appears first on the pricing page.">
              <input
                inputMode="numeric"
                dir="ltr"
                {...text(draft.sortOrder, (v) => setDraft({ ...draft, sortOrder: v }))}
              />
            </Field>
          </div>

          <div className="mt-4 space-y-2">
            <Toggle
              checked={draft.chatVolumeEnabled}
              onChange={(v) => setDraft({ ...draft, chatVolumeEnabled: v })}
              label="Chat volume tiers"
              hint="Lets a customer choose their conversation capacity."
            />
            <Toggle
              checked={draft.voiceVolumeEnabled}
              onChange={(v) => setDraft({ ...draft, voiceVolumeEnabled: v })}
              label="Voice volume tiers"
            />
            <Toggle
              checked={draft.creditPackagesEligible}
              onChange={(v) => setDraft({ ...draft, creditPackagesEligible: v })}
              label="Can buy extra credit packages"
            />
            <Toggle
              checked={draft.autoPurchaseEligible}
              onChange={(v) => setDraft({ ...draft, autoPurchaseEligible: v })}
              label="Can enable automatic top-up"
            />
          </div>

          <div className="mt-4">
            <Field label="Internal note" hint="Never shown to a customer.">
              <input {...text(draft.internalNote, (v) => setDraft({ ...draft, internalNote: v }))} />
            </Field>
          </div>
        </section>

        {/* ── What the plan includes ───────────────────────────────────── */}
        <section className="mt-8 rounded-2xl border border-gray-200 p-5">
          <h2 className="text-sm font-semibold text-gray-900">What this plan includes</h2>
          <p className="mt-1 text-[13px] leading-relaxed text-gray-500">
            Every capability in the catalog. Anything switched off here is refused at runtime for
            organizations on this plan, so this list is the plan - not a description of it.
          </p>

          {Object.entries(byCategory).map(([category, list]) => (
            <div key={category} className="mt-5">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                {CATEGORY_LABEL[category] ?? category}
              </h3>
              <div className="mt-2 divide-y divide-gray-100 rounded-xl border border-gray-100">
                {list.map((f) => (
                  <EntitlementRow
                    key={f.key}
                    feature={f}
                    value={entitlements[f.key]}
                    onChange={(v) => setEntitlements({ ...entitlements, [f.key]: v })}
                  />
                ))}
              </div>
            </div>
          ))}
        </section>

        {/* ── Volume tiers ─────────────────────────────────────────────── */}
        {volume.length > 0 && (
          <section className="mt-8 rounded-2xl border border-gray-200 p-5">
            <h2 className="text-sm font-semibold text-gray-900">Volume tiers</h2>
            <p className="mt-1 text-[13px] leading-relaxed text-gray-500">
              What a customer can choose on the pricing page. The credit allowance and the price
              move together.
            </p>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-[13px]">
                <thead className="border-b border-gray-100 text-[11px] uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="py-2 font-medium">Channel</th>
                    <th className="py-2 font-medium">Per business day</th>
                    <th className="py-2 font-medium">Extra credits</th>
                    <th className="py-2 font-medium">Extra price</th>
                    <th className="py-2 font-medium">Default</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {volume.map((v, i) => (
                    <tr key={v.key}>
                      <td className="py-2 text-gray-500">{v.channel}</td>
                      <td className="py-2">
                        <input
                          inputMode="numeric"
                          dir="ltr"
                          value={String(v.dailyVolume)}
                          onChange={(e) => patchVolume(setVolume, volume, i, { dailyVolume: Number(e.target.value) || 0 })}
                          className={`${INPUT} w-24`}
                        />
                      </td>
                      <td className="py-2">
                        <input
                          inputMode="numeric"
                          dir="ltr"
                          value={String(v.additionalCredits)}
                          onChange={(e) =>
                            patchVolume(setVolume, volume, i, { additionalCredits: Number(e.target.value) || 0 })
                          }
                          className={`${INPUT} w-28`}
                        />
                      </td>
                      <td className="py-2">
                        <input
                          inputMode="decimal"
                          dir="ltr"
                          value={String(v.additionalPrice)}
                          onChange={(e) => patchVolume(setVolume, volume, i, { additionalPrice: e.target.value })}
                          className={`${INPUT} w-28`}
                        />
                      </td>
                      <td className="py-2">
                        <input
                          type="radio"
                          name="default-volume"
                          checked={v.isDefault}
                          onChange={() =>
                            setVolume(volume.map((o, j) => ({ ...o, isDefault: i === j })))
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {error && (
          <p role="alert" className="mt-6 text-[13px] text-red-600">
            {error}
          </p>
        )}
        {saved && !error && (
          <p className="mt-6 text-[13px] text-green-700">
            Saved. Nothing is live until this draft is published.
          </p>
        )}

        <div className="sticky bottom-0 mt-6 flex flex-wrap items-center gap-3 border-t border-gray-200 bg-white/95 py-4 backdrop-blur">
          <button
            type="button"
            disabled={saving}
            onClick={() => save()}
            className="rounded-xl bg-gray-900 px-4 py-2.5 text-[14px] font-medium text-white transition-colors hover:bg-gray-800 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save draft"}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={saveAndPreview}
            className="rounded-xl border border-gray-300 px-4 py-2.5 text-[14px] font-medium text-gray-900 transition-colors hover:border-gray-900 disabled:opacity-50"
          >
            Save and review for publishing
          </button>
          <span className="text-[12px] text-gray-500">
            {plan.subscriberCount > 0
              ? `${plan.subscriberCount} organizations are on the published version. They keep their snapshot.`
              : "No organizations are on this plan yet."}
          </span>
        </div>
      </div>
    </SystemLayout>
  );
}

/* ── Pieces ──────────────────────────────────────────────────────────── */

const INPUT =
  "w-full rounded-xl border border-gray-300 px-3 py-2 text-[15px] text-gray-900 focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900";

function text(value: string, onChange: (v: string) => void) {
  return {
    type: "text" as const,
    value,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value),
    className: INPUT,
  };
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium text-gray-700">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11.5px] text-gray-500">{hint}</span>}
    </label>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
  disabledReason,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
  disabledReason?: string;
}) {
  return (
    <label className={`flex items-start gap-3 ${disabled ? "opacity-60" : ""}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 rounded border-gray-300"
      />
      <span>
        <span className="block text-[13.5px] text-gray-900">{label}</span>
        {(disabled ? disabledReason : hint) && (
          <span className="block text-[11.5px] text-gray-500">{disabled ? disabledReason : hint}</span>
        )}
      </span>
    </label>
  );
}

/**
 * One capability, rendered by the shape of its value.
 *
 * A capability the product has NOT built cannot be sold, so it is disabled with
 * the reason attached. The server rejects it with 422 either way; being told
 * before typing is the difference between a UI and a trap.
 */
function EntitlementRow({
  feature,
  value,
  onChange,
}: {
  feature: AdminFeature;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const unbuilt = !feature.implemented;
  const v = (value ?? {}) as Record<string, unknown>;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
      <div className="min-w-[14rem] flex-1">
        <p className={`text-[13.5px] ${unbuilt ? "text-gray-400" : "text-gray-900"}`}>
          {feature.nameEn}
          {!feature.customerVisible && (
            <span className="ml-2 text-[11px] text-gray-400">internal</span>
          )}
        </p>
        <p className="text-[11.5px] text-gray-500">
          {unbuilt ? "Not built yet - cannot be sold" : feature.description}
        </p>
      </div>

      <div className="shrink-0">
        {feature.entitlementType === "BOOLEAN" && (
          <input
            type="checkbox"
            disabled={unbuilt}
            checked={Boolean(v.bool)}
            onChange={(e) => onChange({ bool: e.target.checked })}
            className="h-4 w-4 rounded border-gray-300"
          />
        )}

        {feature.entitlementType === "COUNTER" && (
          <input
            inputMode="numeric"
            dir="ltr"
            disabled={unbuilt}
            value={String(v.count ?? "")}
            placeholder="0"
            onChange={(e) => onChange({ count: Number(e.target.value) || 0 })}
            className={`${INPUT} w-28`}
          />
        )}

        {feature.entitlementType === "DECIMAL" && (
          <input
            inputMode="decimal"
            dir="ltr"
            disabled={unbuilt}
            value={String(v.amount ?? "")}
            onChange={(e) => onChange({ amount: e.target.value })}
            className={`${INPUT} w-28`}
          />
        )}

        {feature.entitlementType === "ENUM" && (
          <input
            disabled={unbuilt}
            value={String(v.value ?? "")}
            onChange={(e) => onChange({ value: e.target.value })}
            className={`${INPUT} w-36`}
          />
        )}

        {feature.entitlementType === "UNLIMITED" && (
          <span className="text-[12px] text-gray-500">unlimited</span>
        )}

        {(feature.entitlementType === "CONFIG" ||
          feature.entitlementType === "LIST" ||
          feature.entitlementType === "METERED") && (
          <JsonValue disabled={unbuilt} value={value} onChange={onChange} />
        )}
      </div>
    </div>
  );
}

/**
 * Arbitrary-shaped values, edited as JSON.
 *
 * Deliberately not a generated form. These carry per-feature shapes that change
 * with the feature, and a form built from a guess at the shape would quietly
 * drop the keys it did not know about. Invalid JSON is refused rather than
 * saved as a string.
 */
function JsonValue({
  value,
  onChange,
  disabled,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
}) {
  const [raw, setRaw] = useState(() => JSON.stringify(value ?? {}, null, 0));
  const [bad, setBad] = useState(false);

  return (
    <div className="w-64">
      <input
        dir="ltr"
        disabled={disabled}
        value={raw}
        onChange={(e) => {
          setRaw(e.target.value);
          try {
            onChange(JSON.parse(e.target.value));
            setBad(false);
          } catch {
            // Kept out of state entirely: saving a half-typed object would
            // write a broken entitlement.
            setBad(true);
          }
        }}
        className={`${INPUT} font-mono text-[12px] ${bad ? "border-red-400" : ""}`}
      />
      {bad && <span className="mt-0.5 block text-[11px] text-red-600">Not valid JSON - not saved</span>}
    </div>
  );
}

/* ── Helpers ─────────────────────────────────────────────────────────── */

function groupBy<T>(items: T[], key: (t: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const item of items) (out[key(item)] ??= []).push(item);
  return out;
}

function patchVolume(
  set: (v: AdminVolumeOption[]) => void,
  all: AdminVolumeOption[],
  index: number,
  patch: Partial<AdminVolumeOption>,
) {
  set(all.map((o, i) => (i === index ? { ...o, ...patch } : o)));
}

function humanError(code: string): string {
  switch (code) {
    case "plan_version_immutable":
      return "This version is published and cannot be changed. Create a new draft version instead.";
    case "feature_not_implemented":
      return "One of those capabilities has not been built yet, so it cannot be sold.";
    case "unknown_plan":
      return "That plan version no longer exists.";
    case "forbidden":
    case "insufficient_permissions":
      return "You do not have permission to change pricing.";
    default:
      return "That did not save. Nothing was changed.";
  }
}
