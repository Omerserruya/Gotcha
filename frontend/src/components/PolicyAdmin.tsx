"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import { useI18n } from "@/context/I18nContext";
import { getPolicy as fetchPolicy, updatePolicy, type BusinessPolicy } from "@/lib/gotcha-api";

interface Props {
  token: string;
}

/**
 * F8.4 - Business Policy admin surface.
 *
 * The policy is a single JSON document per tenant (`BusinessPolicy`
 * table). This form edits every top-level field and write-throughs via
 * PUT /api/ai-assist/policy. The backend enforces the admin role.
 */
export default function PolicyAdmin({ token }: Props) {
  const { t } = useI18n();
  const [policy, setPolicy] = useState<BusinessPolicy | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetchPolicy(token);
        setPolicy(res.data);
      } catch (e: any) {
        setError(e?.message ?? t("settings.policy.errorLoad"));
      }
    })();
  }, [token, t]);

  function patch<K extends keyof BusinessPolicy>(key: K, value: BusinessPolicy[K]) {
    if (!policy) return;
    setPolicy({ ...policy, [key]: value });
    setDirty(true);
  }

  async function save() {
    if (!policy) return;
    setSaving(true);
    setError(null);
    try {
      const res = await updatePolicy(token, policy);
      setPolicy(res.data);
      setDirty(false);
      setToast(t("settings.policy.saved"));
      setTimeout(() => setToast(null), 2000);
    } catch (e: any) {
      setError(e?.message ?? t("settings.policy.errorSave"));
    } finally {
      setSaving(false);
    }
  }

  if (!policy) {
    return (
      <div className="bg-white rounded-xl shadow-subtle p-6 text-sm text-gray-500">
        {error ? <span className="text-red-600">{error}</span> : t("settings.policy.loading")}
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-3xl">
      {/* Header */}
      <div className="flex items-center justify-between bg-gradient-to-r from-violet-50 to-purple-50 border border-violet-100 rounded-xl px-5 py-4">
        <div>
          <h2 className="text-base font-semibold text-gray-900">{t("settings.policy.title")}</h2>
          <p className="text-xs text-gray-500 mt-0.5">{t("settings.policy.subtitle")}</p>
        </div>
        <button
          onClick={save}
          disabled={!dirty || saving}
          className={clsx(
            "px-4 py-2 rounded-lg text-sm font-medium transition shadow-sm",
            dirty && !saving
              ? "bg-violet-600 text-white hover:bg-violet-700"
              : "bg-gray-100 text-gray-400 cursor-not-allowed",
          )}
        >
          {saving ? t("settings.policy.saving") : dirty ? t("settings.policy.saveChanges") : t("settings.policy.saved")}
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2 rounded-lg">
          {error}
        </div>
      )}
      {toast && (
        <div className="bg-green-50 border border-green-200 text-green-700 text-sm px-4 py-2 rounded-lg">
          {toast}
        </div>
      )}

      {/* Discount + Refund */}
      <section className="bg-white rounded-xl shadow-subtle p-5 space-y-5">
        <h3 className="text-sm font-semibold text-gray-800">{t("settings.policy.financial")}</h3>

        <Field
          label={t("settings.policy.maxDiscountLabel")}
          hint={t("settings.policy.maxDiscountHint")}
        >
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              max={100}
              value={policy.maxDiscountPercent}
              onChange={(e) => patch("maxDiscountPercent", Number(e.target.value))}
              className="w-24 px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-200 text-sm"
            />
            <span className="text-sm text-gray-500">%</span>
          </div>
        </Field>

        <Toggle
          label={t("settings.policy.refundsApprovalLabel")}
          hint={t("settings.policy.refundsApprovalHint")}
          checked={policy.refundRequiresApproval}
          onChange={(v) => patch("refundRequiresApproval", v)}
        />
      </section>

      {/* Escalation */}
      <section className="bg-white rounded-xl shadow-subtle p-5 space-y-4">
        <h3 className="text-sm font-semibold text-gray-800">{t("settings.policy.escalationTitle")}</h3>
        <p className="text-xs text-gray-500 -mt-2">{t("settings.policy.escalationHint")}</p>
        <ChipEditor
          items={policy.escalationKeywords}
          onChange={(v) => patch("escalationKeywords", v)}
          placeholder={t("settings.policy.escalationPlaceholder")}
          addLabel={t("settings.policy.add")}
          emptyLabel={t("settings.policy.noneYet")}
        />
      </section>

      {/* Blocked topics */}
      <section className="bg-white rounded-xl shadow-subtle p-5 space-y-4">
        <h3 className="text-sm font-semibold text-gray-800">{t("settings.policy.blockedTitle")}</h3>
        <p className="text-xs text-gray-500 -mt-2">{t("settings.policy.blockedHint")}</p>
        <ChipEditor
          items={policy.blockedTopics}
          onChange={(v) => patch("blockedTopics", v)}
          placeholder={t("settings.policy.blockedPlaceholder")}
          addLabel={t("settings.policy.add")}
          emptyLabel={t("settings.policy.noneYet")}
        />
      </section>

      {/* Quiet hours */}
      <section className="bg-white rounded-xl shadow-subtle p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-gray-800">{t("settings.policy.quietTitle")}</h3>
            <p className="text-xs text-gray-500 mt-0.5">{t("settings.policy.quietHint")}</p>
          </div>
          <Toggle
            label=""
            checked={Boolean(policy.outboundQuietHours)}
            onChange={(v) =>
              patch(
                "outboundQuietHours",
                v ? { startHour: 22, endHour: 8, tz: "UTC" } : undefined,
              )
            }
          />
        </div>
        {policy.outboundQuietHours && (
          <div className="grid grid-cols-3 gap-3 pt-2 border-t border-gray-100">
            <NumField
              label={t("settings.policy.quietStart")}
              value={policy.outboundQuietHours.startHour}
              onChange={(v) =>
                patch("outboundQuietHours", {
                  ...policy.outboundQuietHours!,
                  startHour: v,
                })
              }
            />
            <NumField
              label={t("settings.policy.quietEnd")}
              value={policy.outboundQuietHours.endHour}
              onChange={(v) =>
                patch("outboundQuietHours", {
                  ...policy.outboundQuietHours!,
                  endHour: v,
                })
              }
            />
            <div>
              <label className="text-xs font-medium text-gray-600 block mb-1">{t("settings.policy.timezone")}</label>
              <input
                type="text"
                value={policy.outboundQuietHours.tz ?? "UTC"}
                onChange={(e) =>
                  patch("outboundQuietHours", {
                    ...policy.outboundQuietHours!,
                    tz: e.target.value,
                  })
                }
                className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-200 text-sm"
              />
            </div>
          </div>
        )}
      </section>
    </div>
  );
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
    <div>
      <label className="block text-xs font-medium text-gray-700 mb-1">{label}</label>
      {hint && <p className="text-[11px] text-gray-500 mb-2">{hint}</p>}
      {children}
    </div>
  );
}

function NumField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <label className="text-xs font-medium text-gray-600 block mb-1">{label}</label>
      <input
        type="number"
        min={0}
        max={23}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-200 text-sm"
      />
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      {label && (
        <div className="flex-1">
          <div className="text-sm text-gray-800">{label}</div>
          {hint && <p className="text-[11px] text-gray-500 mt-0.5">{hint}</p>}
        </div>
      )}
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={clsx(
          "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition",
          checked ? "bg-violet-600" : "bg-gray-200",
        )}
      >
        <span
          className={clsx(
            "inline-block h-5 w-5 transform rounded-full bg-white shadow transition",
            checked ? "translate-x-5" : "translate-x-0.5",
          )}
        />
      </button>
    </div>
  );
}

function ChipEditor({
  items,
  onChange,
  placeholder,
  addLabel,
  emptyLabel,
}: {
  items: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
  addLabel?: string;
  emptyLabel?: string;
}) {
  const [draft, setDraft] = useState("");

  function commit() {
    const v = draft.trim();
    if (!v) return;
    if (items.includes(v)) {
      setDraft("");
      return;
    }
    onChange([...items, v]);
    setDraft("");
  }

  return (
    <div>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {items.length === 0 && (
          <span className="text-xs text-gray-400 italic">{emptyLabel ?? "None yet."}</span>
        )}
        {items.map((item) => (
          <span
            key={item}
            className="inline-flex items-center gap-1 bg-violet-50 border border-violet-100 text-violet-700 text-xs px-2 py-1 rounded-md"
          >
            {item}
            <button
              type="button"
              onClick={() => onChange(items.filter((x) => x !== item))}
              className="text-violet-400 hover:text-violet-600"
              aria-label={`Remove ${item}`}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
          }}
          placeholder={placeholder}
          className="flex-1 px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-200 text-sm"
        />
        <button
          type="button"
          onClick={commit}
          disabled={!draft.trim()}
          className="px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg disabled:opacity-50"
        >
          {addLabel ?? "Add"}
        </button>
      </div>
    </div>
  );
}
