"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { useI18n } from "@/context/I18nContext";
import { getWebchatSettings, updateWebchatSettings } from "@/lib/api";
import { WidgetPreview, type PreviewState, type PreviewDevice } from "@/components/shopify/WidgetPreview";
import { ExperienceSection, EXPERIENCE_SECTIONS, type ExperienceSection as SectionName } from "./ExperienceEditor";
import { Card, Field, Toggle, Select, ColorInput } from "./primitives";

/**
 * The website chat widget's settings.
 *
 * Deliberately the SAME editor as the Shopify storefront widget: the
 * welcome screen, launcher, hero, proactive teaser and sounds are shared
 * sections, and the preview boots the same bundle a visitor loads. The
 * website widget used to have four fields — colour, icon, title, side —
 * which is how the two ended up feeling like different products.
 *
 * What is genuinely local sits in "appearance" and "behaviour": the
 * brand colours, language, and whether to offer a person.
 */

const SECTIONS = ["appearance", ...EXPERIENCE_SECTIONS, "behaviour"] as const;
type Section = (typeof SECTIONS)[number];

/** Write `a.b.c` into a nested draft without mutating the original. */
function setPath<T extends Record<string, any>>(source: T, path: string, value: unknown): T {
  const keys = path.split(".");
  const next: any = { ...source };
  let cursor = next;
  for (let i = 0; i < keys.length - 1; i++) {
    cursor[keys[i]] = { ...(cursor[keys[i]] ?? {}) };
    cursor = cursor[keys[i]];
  }
  cursor[keys[keys.length - 1]] = value;
  return next;
}

export function WebchatWidgetSettings({
  accountId,
  token,
  onSaved,
}: {
  accountId: string;
  token: string;
  onSaved?: (message: string, kind: "success" | "error") => void;
}) {
  const { t, locale } = useI18n();
  const [draft, setDraft] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [section, setSection] = useState<Section>("appearance");
  const [previewState, setPreviewState] = useState<PreviewState>("welcome");
  const [previewDevice, setPreviewDevice] = useState<PreviewDevice>("desktop");

  useEffect(() => {
    let alive = true;
    getWebchatSettings(token, accountId)
      .then((res) => { if (alive) setDraft(res.data ?? {}); })
      .catch(() => { if (alive) setDraft({}); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [token, accountId]);

  const patch = useCallback((path: string, value: unknown) => {
    setDraft((current: any) => setPath(current ?? {}, path, value));
    setDirty(true);
  }, []);

  async function save() {
    setSaving(true);
    try {
      const res = await updateWebchatSettings(token, accountId, { ...draft, v: 2 });
      // The server normalizes; taking its answer back means the form shows
      // what is actually stored rather than what was typed.
      setDraft((res as any)?.data?.config ?? draft);
      setDirty(false);
      onSaved?.(t("channels.widgetSaved"), "success");
    } catch (err: any) {
      onSaved?.(err?.message || t("common.error"), "error");
    } finally {
      setSaving(false);
    }
  }

  /**
   * The preview renders the real widget, which expects the PUBLIC config
   * shape rather than the stored one — the same projection the server
   * makes before a visitor's browser ever sees it.
   */
  const previewConfig = useMemo(() => {
    if (!draft) return null;
    return {
      appearance: {
        ...(draft.appearance ?? {}),
        avatarUrl: draft.ux?.welcome?.avatarUrl ?? null,
        launcherIcon: draft.ux?.launcher?.icon ?? "chat",
        launcherPosition: draft.ux?.launcher?.position ?? "right",
      },
      welcome: {
        headline: draft.ux?.welcome?.title ?? "",
        subline: draft.ux?.welcome?.subtitle ?? "",
        assistantName: draft.ux?.welcome?.assistantName ?? "",
        suggestedQuestions: draft.ux?.welcome?.suggestedQuestions ?? [],
      },
      hours: { offlineMessage: draft.offline?.message ?? "" },
      routing: { allowHumanHandoff: draft.behaviour?.allowHumanHandoff !== false },
      // A website widget has no catalogue to talk about.
      commerce: { addToCartEnabled: false },
      privacy: {},
      ux: draft.ux,
    };
  }, [draft]);

  if (loading || !draft) {
    return <p className="p-6 text-sm text-gray-400">{t("common.loading")}</p>;
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
      <div className="space-y-4">
        <nav className="flex flex-wrap gap-1.5">
          {SECTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSection(s)}
              className={clsx(
                "px-3 py-1.5 rounded-lg text-xs font-medium transition",
                section === s ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200",
              )}
            >
              {t(`shopifyChat.section.${s === "behaviour" ? "behavior" : s}`)}
            </button>
          ))}
        </nav>

        {section === "appearance" && (
          <Card title={t("shopifyChat.section.appearance")}>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t("shopifyChat.primaryColor")}>
                <ColorInput
                  value={draft.appearance?.primaryColor ?? "#7c3aed"}
                  onChange={(v) => patch("appearance.primaryColor", v)}
                />
              </Field>
              <Field label={t("shopifyChat.contrastColor")}>
                <ColorInput
                  value={draft.appearance?.contrastColor ?? "#ffffff"}
                  onChange={(v) => patch("appearance.contrastColor", v)}
                />
              </Field>
            </div>
            <Field label={t("shopifyChat.logoUrl")} hint={t("shopifyChat.httpsOnly")}>
              <input
                type="url"
                value={draft.appearance?.logoUrl ?? ""}
                onChange={(e) => patch("appearance.logoUrl", e.target.value || null)}
                className="w-full text-sm px-3 py-2 border border-gray-200 rounded-lg"
              />
            </Field>
            <Field
              label={`${t("shopifyChat.cornerRadius")}: ${draft.appearance?.cornerRadius ?? 20}px`}
              hint={t("shopifyChat.cornerRadiusHint")}
            >
              <input
                type="range"
                min={0}
                max={28}
                value={draft.appearance?.cornerRadius ?? 20}
                onChange={(e) => patch("appearance.cornerRadius", Number(e.target.value))}
                className="w-full"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t("shopifyChat.language")}>
                <Select
                  value={draft.appearance?.language ?? "auto"}
                  onChange={(v) => patch("appearance.language", v)}
                  options={[
                    { value: "auto", label: t("shopifyChat.langAuto") },
                    { value: "en", label: "English" },
                    { value: "he", label: "עברית" },
                  ]}
                />
              </Field>
              <Field label={t("shopifyChat.direction")}>
                <Select
                  value={draft.appearance?.direction ?? "auto"}
                  onChange={(v) => patch("appearance.direction", v)}
                  options={[
                    { value: "auto", label: t("shopifyChat.langAuto") },
                    { value: "ltr", label: "LTR" },
                    { value: "rtl", label: "RTL" },
                  ]}
                />
              </Field>
            </div>
            <Toggle
              label={t("shopifyChat.showPoweredBy")}
              checked={draft.appearance?.showPoweredBy !== false}
              onChange={(v) => patch("appearance.showPoweredBy", v)}
            />
          </Card>
        )}

        {(EXPERIENCE_SECTIONS as readonly string[]).includes(section) && (
          <ExperienceSection section={section as SectionName} ux={draft.ux} patch={patch} t={t} />
        )}

        {section === "behaviour" && (
          <Card title={t("shopifyChat.section.handoff")}>
            <Toggle
              label={t("shopifyChat.allowHumanHandoff")}
              hint={t("shopifyChat.allowHumanHandoffHint")}
              checked={draft.behaviour?.allowHumanHandoff !== false}
              onChange={(v) => patch("behaviour.allowHumanHandoff", v)}
            />
            <Field label={t("shopifyChat.offlineMessage")}>
              <textarea
                rows={2}
                maxLength={300}
                value={draft.offline?.message ?? ""}
                onChange={(e) => patch("offline.message", e.target.value)}
                className="w-full text-sm px-3 py-2 border border-gray-200 rounded-lg"
              />
            </Field>
            {/* Availability itself belongs to the business, not to this
                widget — the same schedule the AI employee reads. */}
            <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm text-gray-600">
              <p>{t("shopifyChat.hoursMovedHint")}</p>
              <a href="/settings/business-hours" className="mt-1 inline-block text-primary-600 hover:text-primary-700">
                {t("shopifyChat.hoursMovedLink")} →
              </a>
            </div>
          </Card>
        )}

        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={!dirty || saving}
            onClick={save}
            className="px-4 py-2 rounded-lg bg-gray-900 text-white text-sm font-medium disabled:opacity-40"
          >
            {saving ? t("common.saving") : t("common.save")}
          </button>
          {dirty && <span className="text-xs text-amber-600">{t("common.unsavedChanges")}</span>}
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {(["welcome", "conversation"] as PreviewState[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setPreviewState(s)}
              className={clsx(
                "px-3 py-1.5 rounded-lg text-xs font-medium transition",
                previewState === s ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200",
              )}
            >
              {t(`shopifyChat.preview.${s}`)}
            </button>
          ))}
          {(["desktop", "mobile"] as PreviewDevice[]).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setPreviewDevice(d)}
              className={clsx(
                "px-3 py-1.5 rounded-lg text-xs font-medium transition",
                previewDevice === d ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200",
              )}
            >
              {t(`shopifyChat.${d}`)}
            </button>
          ))}
        </div>
        {previewConfig && (
          <WidgetPreview
            config={previewConfig}
            device={previewDevice}
            state={previewState}
            language={locale === "he" ? "he" : "en"}
            sampleProducts={[]}
            productsAreReal={false}
          />
        )}
      </div>
    </div>
  );
}
