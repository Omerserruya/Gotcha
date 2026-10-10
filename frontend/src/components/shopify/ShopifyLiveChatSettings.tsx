"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import {
  getShopifyStore,
  listShopifyLiveChatChannels,
  createShopifyLiveChatChannel,
  enableShopifyChat,
  getShopifyChatStatus,
  type ShopifyChatStatus,
  updateShopifyLiveChatChannel,
  deleteShopifyLiveChatChannel,
  getShopifyLiveChatDiagnostics,
  getShopifyLiveChatInstall,
  searchShopifyProducts,
  getAIAgents,
  getDepartments,
  type ShopifyLiveChatChannel,
} from "@/lib/api";
import ConfirmModal from "@/components/ConfirmModal";
import { ShopifyGlyph } from "./ShopifyGlyph";
// One editor for the shared experience, used here and by the website
// widget's settings - see components/chat-widget/ExperienceEditor.tsx.
import { ExperienceSection } from "@/components/chat-widget/ExperienceEditor";
import { Card, Field, Toggle, Select, ColorInput, Row } from "@/components/chat-widget/primitives";
import { WidgetPreview, PREVIEW_FIXTURE, type PreviewState, type PreviewDevice } from "./WidgetPreview";
import type { ProductView } from "./ProductCard";
import {
  heroHeightWarning,
  sanitizeMediaUrl,
  MEDIA_GUIDANCE,
  WELCOME_FALLBACK,
  HERO_FALLBACK,
} from "@/lib/shopify-chat-ux-client";

/**
 * Shopify Live Chat channel configuration.
 *
 * Structured so the merchant's next action is always obvious: the
 * diagnostics strip at the top says what is blocking them right now, and
 * the preview beside the form shows the consequence of whatever they just
 * changed. Everything is one saveable draft - a half-configured widget
 * should not be able to reach a live storefront by accident.
 */

const SECTIONS = [
  "store",
  "installation",
  "launcher",
  // One section, not four. "hero", "appearance", "welcome" and
  // "questions" all edited pieces of the same screen, so a merchant had
  // to visit four tabs to change one thing and could set the avatar in
  // two places that disagreed.
  "welcome",
  "appearance",
  "proactive",
  "sounds",
  "behavior",
  "commerce",
  // "ai" and "routing" are gone: the Main Playbook decides who handles a
  // conversation, on this channel as on every other one.
  "handoff",
  "hours",
  "privacy",
  "diagnostics",
] as const;
type Section = (typeof SECTIONS)[number];

const DAYS = ["0", "1", "2", "3", "4", "5", "6"];

export function ShopifyLiveChatSettings() {
  const { token, user } = useAuth();
  const { t, locale } = useI18n();

  const [loading, setLoading] = useState(true);
  const [store, setStore] = useState<any>(null);
  /** Why the page could not load - kept apart from "no store connected". */
  const [loadError, setLoadError] = useState<{ code?: string; message: string } | null>(null);
  const [channel, setChannel] = useState<ShopifyLiveChatChannel | null>(null);
  const [draft, setDraft] = useState<any>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; kind: "ok" | "err" } | null>(null);
  const [section, setSection] = useState<Section>("store");

  const [agents, setAgents] = useState<any[]>([]);
  const [departments, setDepartments] = useState<any[]>([]);
  const [diagnostics, setDiagnostics] = useState<any>(null);
  const [install, setInstall] = useState<any>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  // Resolved once, here, so every input below reads the same values the
  // storefront will. The server normalizes on every read and write, so a
  // saved channel arrives canonical; the fallbacks cover only a channel
  // that has never been saved.
  const welcome = useMemo(
    () => ({ ...WELCOME_FALLBACK, ...(draft?.ux?.welcome ?? {}) }),
    [draft?.ux?.welcome],
  );
  const hero = useMemo(
    () => ({ ...HERO_FALLBACK, ...(draft?.ux?.hero ?? {}) }),
    [draft?.ux?.hero],
  );
  const heroFit = useMemo(
    () => heroHeightWarning({ configured: hero.height, panelHeight: 640, isMobile: false }),
    [hero.height],
  );

  // Installation health, read separately from the channel. The two are
  // different rows and CAN disagree: an uninstall retires the installation
  // while the channel keeps enabled=true, which is how the UI came to show a
  // healthy toggle while the storefront bootstrap refused.
  const [chatStatus, setChatStatus] = useState<ShopifyChatStatus | null>(null);

  const [previewState, setPreviewState] = useState<PreviewState>("welcome");
  const [previewDevice, setPreviewDevice] = useState<PreviewDevice>("desktop");
  const [previewLang, setPreviewLang] = useState<"en" | "he">(locale === "he" ? "he" : "en");
  const [previewProducts, setPreviewProducts] = useState<ProductView[]>([]);
  const [productsAreReal, setProductsAreReal] = useState(false);

  const notify = (text: string, kind: "ok" | "err" = "ok") => {
    setMessage({ text, kind });
    setTimeout(() => setMessage(null), 5000);
  };

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setLoadError(null);
    try {
      // Deliberately NOT swallowed into `{ connected: false }`. A 403 from
      // the licence gate or a 500 from the adapter is not the same fact as
      // "this workspace has no Shopify store", and telling a merchant whose
      // store IS connected to go connect one sends them to fix nothing.
      const [storeRes, channelsRes, statusRes] = await Promise.all([
        getShopifyStore(token),
        listShopifyLiveChatChannels(token),
        // Best-effort: an older API without this route must not break the page.
        getShopifyChatStatus(token).catch(() => null),
      ]);
      setChatStatus(statusRes?.data ?? null);
      setStore(storeRes.data);
      const first = (channelsRes.data || [])[0] || null;
      setChannel(first);
      setDraft(first ? structuredClone(first.config) : null);
      setDirty(false);
      if (first) setSection((s) => (s === "store" ? "installation" : s));
    } catch (err: any) {
      setStore(null);
      setChannel(null);
      setDraft(null);
      setLoadError({ code: err?.code, message: err?.message || t("common.error") });
    } finally {
      setLoading(false);
    }
  }, [token, t]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!token) return;
    getAIAgents(token).then((r) => setAgents(r.data || [])).catch(() => {});
    getDepartments(token).then((r) => setDepartments(r.data || [])).catch(() => {});
  }, [token]);

  useEffect(() => {
    if (!token || !channel) return;
    getShopifyLiveChatDiagnostics(token, channel.id).then((r) => setDiagnostics(r.data)).catch(() => {});
    getShopifyLiveChatInstall(token, channel.id).then((r) => setInstall(r.data)).catch(() => {});
  }, [token, channel]);

  // Real products for the preview. A merchant checking their branding
  // should see their own catalogue, not stock photos of somebody else's.
  useEffect(() => {
    if (!token || !store?.connected) return;
    searchShopifyProducts(token, "", { limit: 3 })
      .then((r) => {
        const products = (r.data.products || []) as ProductView[];
        if (products.length) {
          setPreviewProducts(products);
          setProductsAreReal(true);
        } else {
          setPreviewProducts(PREVIEW_FIXTURE);
          setProductsAreReal(false);
        }
      })
      .catch(() => {
        setPreviewProducts(PREVIEW_FIXTURE);
        setProductsAreReal(false);
      });
  }, [token, store]);

  const patch = (path: string, value: any) => {
    setDraft((prev: any) => {
      const next = structuredClone(prev ?? {});
      const keys = path.split(".");
      let node = next;
      for (let i = 0; i < keys.length - 1; i++) {
        node[keys[i]] = node[keys[i]] ?? {};
        node = node[keys[i]];
      }
      node[keys[keys.length - 1]] = value;
      return next;
    });
    setDirty(true);
  };

  /**
   * Enable Shopify Chat.
   *
   * Under the unified app this is NOT a second Shopify install: the merchant
   * already authorized one app and the Theme App Extension shipped with it,
   * so enabling is purely a GOTCHA-side provisioning step. `enableShopifyChat`
   * derives the shop from the existing Core connection and records the
   * installation row that activation state and the heartbeat hang off, which
   * creating a bare channel would not.
   *
   * Falls back to plain channel creation when the unified endpoint is not
   * available yet, so this keeps working against an older API during rollout.
   */
  async function handleCreate() {
    if (!token) return;
    setSaving(true);
    try {
      try {
        await enableShopifyChat(token);
      } catch (err: any) {
        // A store that is genuinely not connected is a real refusal and must
        // surface; anything else falls back to the legacy create path.
        if (err?.code === "SHOPIFY_NOT_CONNECTED") throw err;
        await createShopifyLiveChatChannel(token);
      }
      // Re-read rather than trusting the create response: `load()` is the one
      // place that reconciles channel + store + draft, and enabling may have
      // adopted a pre-existing channel instead of making a new one.
      await load();
      setSection("installation");
      notify(t("shopifyChat.created"));
    } catch (err: any) {
      notify(err.message || t("common.error"), "err");
    } finally {
      setSaving(false);
    }
  }

  /**
   * Repair a degraded installation by running the full enable path.
   *
   * Deliberately NOT a channel save. Saving would flip a flag the storefront
   * does not consult and leave the merchant believing chat is live.
   * `enableShopifyChat` revives the retired installation, re-binds it to this
   * tenant and re-homes its app identity, keeping the existing channel and
   * every conversation on it.
   */
  async function handleRepair() {
    if (!token) return;
    setSaving(true);
    try {
      await enableShopifyChat(token);
      await load();
      notify(t("shopifyChat.repair.done") || t("shopifyChat.created"));
    } catch (err: any) {
      notify(err.message || t("common.error"), "err");
    } finally {
      setSaving(false);
    }
  }

  async function handleSave(overrides?: any) {
    if (!token || !channel) return;
    setSaving(true);
    try {
      const config = overrides ? { ...draft, ...overrides } : draft;
      const res = await updateShopifyLiveChatChannel(token, channel.id, { config });
      setChannel(res.data);
      setDraft(structuredClone(res.data.config));
      setDirty(false);
      notify(t("common.saved"));
      const d = await getShopifyLiveChatDiagnostics(token, channel.id);
      setDiagnostics(d.data);
    } catch (err: any) {
      notify(err.message || t("common.error"), "err");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!token || !channel) return;
    try {
      await deleteShopifyLiveChatChannel(token, channel.id);
      setDeleteOpen(false);
      setChannel(null);
      setDraft(null);
      notify(t("shopifyChat.deleted"));
      load();
    } catch (err: any) {
      notify(err.message || t("common.error"), "err");
    }
  }

  const blocking = useMemo(
    () => (diagnostics?.checks || []).find((c: any) => c.state === "blocked" && !c.ok) ?? null,
    [diagnostics],
  );

  if (user?.role !== "ADMIN") {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-gray-400">{t("settings.adminRequired")}</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-primary-200 border-t-primary-500 rounded-full animate-spin" />
      </div>
    );
  }

  // ── The page could not load ───────────────────────────────
  // Two different truths, two different next actions: the workspace is not
  // licensed for this channel (nothing the merchant can fix here), or the
  // request failed (worth retrying). Neither is "connect your store".
  if (loadError) {
    const locked = loadError.code === "FEATURE_NOT_AVAILABLE";
    return (
      <div className="max-w-2xl mx-auto p-6 space-y-4">
        <Header t={t} />
        <div
          className={clsx(
            "rounded-2xl border p-5 space-y-2",
            locked ? "bg-amber-50 border-amber-200" : "bg-red-50 border-red-200",
          )}
        >
          <p className={clsx("font-semibold", locked ? "text-amber-900" : "text-red-900")}>
            {locked ? t("shopifyChat.lockedTitle") : t("shopifyChat.loadFailedTitle")}
          </p>
          <p className={clsx("text-sm", locked ? "text-amber-800" : "text-red-800")}>
            {locked ? t("shopifyChat.lockedBody") : loadError.message}
          </p>
          {!locked && (
            <button
              onClick={load}
              className="inline-block text-sm font-medium px-4 py-2 rounded-lg bg-red-600 text-white hover:bg-red-700"
            >
              {t("shopifyChat.retry")}
            </button>
          )}
        </div>
      </div>
    );
  }

  // ── No store connected ────────────────────────────────────
  if (!store?.connected) {
    // A connected integration with no shop domain recorded is a different
    // problem from no integration at all, and reconnecting is the fix for
    // exactly one of them.
    const noDomain = store?.reason === "no_shop_domain";
    return (
      <div className="max-w-2xl mx-auto p-6 space-y-4">
        <Header t={t} />
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-5 space-y-2">
          <p className="font-semibold text-amber-900">
            {noDomain ? t("shopifyChat.noShopDomainTitle") : t("shopifyChat.noStoreTitle")}
          </p>
          <p className="text-sm text-amber-800">
            {noDomain ? t("shopifyChat.noShopDomainBody") : t("shopifyChat.noStoreBody")}
          </p>
          <a
            href="/settings/integrations"
            className="inline-block text-sm font-medium px-4 py-2 rounded-lg bg-amber-600 text-white hover:bg-amber-700"
          >
            {t("shopifyChat.goToIntegrations")}
          </a>
        </div>
      </div>
    );
  }

  // ── Store connected, channel not created ──────────────────
  if (!channel || !draft) {
    return (
      <div className="max-w-2xl mx-auto p-6 space-y-4">
        <Header t={t} />
        <div className="bg-white border border-gray-200 rounded-2xl p-6 space-y-3">
          <p className="text-sm text-gray-500">
            {t("shopifyChat.connectedTo")} <span className="font-medium text-gray-900">{store.shopDomain}</span>
          </p>
          <p className="text-sm text-gray-600">{t("shopifyChat.createIntro")}</p>
          <button
            onClick={handleCreate}
            disabled={saving}
            className="text-sm font-medium px-4 py-2 rounded-lg bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-40"
          >
            {t("shopifyChat.createChannel")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto p-3 md:p-6 space-y-5">
      <Header t={t} />

      {message && (
        <div
          className={clsx(
            "text-sm px-4 py-2.5 rounded-xl border",
            message.kind === "ok"
              ? "bg-green-50 text-green-700 border-green-200"
              : "bg-red-50 text-red-700 border-red-200",
          )}
          role="status"
        >
          {message.text}
        </div>
      )}

      {/* A DEGRADED INSTALLATION OUTRANKS THE CHANNEL FLAG.
          The installation and the channel are separate rows and can
          disagree: uninstalling the app retires the installation while the
          channel keeps enabled=true. Showing the normal toggle here told
          merchants chat was live while the storefront refused with
          "unavailable", so this state gets a repair action instead. */}
      {chatStatus?.needsRepair && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 flex items-start gap-3" role="alert">
          <div className="flex-1">
            <p className="font-semibold text-sm text-amber-900">
              {t(`shopifyChat.repair.${chatStatus.installHealth}`) || t("shopifyChat.repair.title")}
            </p>
            <p className="text-xs text-amber-800 mt-0.5">
              {t("shopifyChat.repair.detail")}
            </p>
          </div>
          <button
            onClick={handleRepair}
            disabled={saving}
            className="shrink-0 text-xs font-medium px-3 py-2 rounded-lg bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-40"
          >
            {t("shopifyChat.repair.action")}
          </button>
        </div>
      )}

      {/* What is stopping this going live, right now */}
      <div
        className={clsx(
          "rounded-2xl border p-4 flex items-start gap-3",
          blocking || chatStatus?.needsRepair
            ? "bg-red-50 border-red-200"
            : draft.enabled ? "bg-green-50 border-green-200" : "bg-gray-50 border-gray-200",
        )}
      >
        <div className="flex-1">
          <p className="font-semibold text-sm text-gray-900">
            {chatStatus?.needsRepair
              ? t("shopifyChat.statusNotServing")
              : blocking
                ? blocking.title
                : draft.enabled
                  ? t("shopifyChat.statusLive")
                  : t("shopifyChat.statusOff")}
          </p>
          <p className="text-xs text-gray-600 mt-0.5">
            {blocking ? blocking.fix || blocking.detail : t("shopifyChat.statusHint")}
          </p>
        </div>
        <label className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-gray-600">{t("shopifyChat.enabled")}</span>
          <input
            type="checkbox"
            checked={!!draft.enabled}
            onChange={(e) => {
              patch("enabled", e.target.checked);
              handleSave({ enabled: e.target.checked });
            }}
            className="w-4 h-4"
          />
        </label>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[180px_1fr_400px] gap-5">
        {/* Section nav */}
        <nav aria-label={t("shopifyChat.sections")} className="lg:sticky lg:top-4 lg:self-start">
          <ul className="flex lg:flex-col gap-1 overflow-x-auto pb-1">
            {SECTIONS.map((s) => (
              <li key={s}>
                <button
                  onClick={() => setSection(s)}
                  aria-current={section === s ? "true" : undefined}
                  className={clsx(
                    "w-full text-start text-[13px] px-3 py-2 rounded-lg whitespace-nowrap transition",
                    section === s
                      ? "bg-primary-50 text-primary-700 font-medium"
                      : "text-gray-600 hover:bg-gray-50",
                  )}
                >
                  {t(`shopifyChat.section.${s}`)}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        {/* Form */}
        <div className="space-y-4 min-w-0">
          {section === "store" && (
            <Card title={t("shopifyChat.section.store")}>
              <Row label={t("shopifyChat.shopDomain")} value={draft.shopDomain || store.shopDomain} />
              <Row label={t("shopifyChat.currency")} value={store.currency} />
              <Row
                label={t("shopifyChat.productAccess")}
                value={
                  store.productCapability?.ok
                    ? t("shopifyChat.productAccessOk")
                    : store.productCapability?.detail || t("shopifyChat.productAccessNo")
                }
              />
              <p className="text-xs text-gray-500 pt-2">{t("shopifyChat.storeBindingNote")}</p>
            </Card>
          )}

          {section === "installation" && (
            <Card title={t("shopifyChat.section.installation")}>
              {/* The normal path is one button. A merchant who installed
                  from the App Store has already had their store, channel and
                  domains bound for them; all that is left is switching the
                  App Embed on in their theme. */}
              <p className="text-sm text-gray-600">{t("shopifyChat.activationIntro")}</p>
              {install?.themeEditorDeepLink ? (
                <a
                  href={install.themeEditorDeepLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block text-sm font-medium px-4 py-2 rounded-lg bg-primary-500 text-white hover:bg-primary-600"
                >
                  {t("shopifyChat.openThemeEditor")}
                </a>
              ) : (
                <p className="text-xs text-amber-700">{t("shopifyChat.noDeepLink")}</p>
              )}

              <ol className="text-sm text-gray-600 space-y-1.5 list-decimal ps-5 pt-1">
                {(install?.steps || []).map((step: string, i: number) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>

              {/* Everything below is recovery. Pasting a key and typing a
                  domain used to be step one of setup; they are now what
                  support reaches for when an installation record is lost. */}
              <details className="pt-2 border-t border-gray-100">
                <summary className="text-xs text-gray-400 cursor-pointer select-none">
                  {t("shopifyChat.advancedTroubleshooting")}
                </summary>
                <div className="space-y-3.5 pt-3">
                  <p className="text-xs text-gray-500">{t("shopifyChat.advancedIntro")}</p>
                  <Field label={t("shopifyChat.channelKey")} hint={t("shopifyChat.channelKeyHint")}>
                    <div className="flex gap-2">
                      <input
                        readOnly
                        value={channel.publicKey}
                        onFocus={(e) => e.currentTarget.select()}
                        className="flex-1 text-xs font-mono px-3 py-2 border border-gray-200 rounded-lg bg-gray-50"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard?.writeText(channel.publicKey);
                          notify(t("shopifyChat.copied"));
                        }}
                        className="text-xs px-3 py-2 rounded-lg border border-gray-200 hover:bg-gray-50"
                      >
                        {t("common.copy")}
                      </button>
                    </div>
                  </Field>

                  <Field
                    label={t("shopifyChat.storefrontDomains")}
                    hint={t("shopifyChat.storefrontDomainsHint")}
                  >
                    <textarea
                      rows={3}
                      value={(draft.install?.storefrontDomains || []).join("\n")}
                      onChange={(e) =>
                        patch(
                          "install.storefrontDomains",
                          e.target.value.split("\n").map((d) => d.trim()).filter(Boolean),
                        )
                      }
                      placeholder="shop.example.com"
                      className="w-full text-sm px-3 py-2 border border-gray-200 rounded-lg font-mono"
                    />
                  </Field>
                </div>
              </details>
            </Card>
          )}

          {section === "launcher" && (
            <ExperienceSection section="launcher" ux={draft.ux} patch={patch} t={t} />
          )}

          {section === "proactive" && (
            <ExperienceSection section="proactive" ux={draft.ux} patch={patch} t={t} />
          )}

          {section === "sounds" && (
            <ExperienceSection section="sounds" ux={draft.ux} patch={patch} t={t} />
          )}

          {section === "behavior" && (
            <ExperienceSection section="behavior" ux={draft.ux} patch={patch} t={t} />
          )}

          {section === "appearance" && (
            <Card title={t("shopifyChat.section.appearance")}>
              <div className="grid grid-cols-2 gap-3">
                <Field label={t("shopifyChat.primaryColor")}>
                  <ColorInput
                    value={draft.appearance.primaryColor}
                    onChange={(v) => patch("appearance.primaryColor", v)}
                  />
                </Field>
                <Field label={t("shopifyChat.contrastColor")}>
                  <ColorInput
                    value={draft.appearance.contrastColor}
                    onChange={(v) => patch("appearance.contrastColor", v)}
                  />
                </Field>
              </div>
              <Field label={t("shopifyChat.logoUrl")} hint={t("shopifyChat.httpsOnly")}>
                <input
                  type="url"
                  value={draft.appearance.logoUrl || ""}
                  onChange={(e) => patch("appearance.logoUrl", e.target.value || null)}
                  className="w-full text-sm px-3 py-2 border border-gray-200 rounded-lg"
                />
              </Field>
              {/* The assistant avatar lives in Welcome experience now.
                  It used to be settable here as well, and the two inputs
                  wrote to different places. */}
              <div className="grid grid-cols-2 gap-3">
                <Field label={t("shopifyChat.launcherIcon")}>
                  <Select
                    value={draft.appearance.launcherIcon}
                    onChange={(v) => patch("appearance.launcherIcon", v)}
                    options={["chat", "sparkle", "bag", "question"].map((v) => ({
                      value: v,
                      label: t(`shopifyChat.icon.${v}`),
                    }))}
                  />
                </Field>
                <Field label={t("shopifyChat.position")}>
                  <Select
                    value={draft.appearance.launcherPosition}
                    onChange={(v) => patch("appearance.launcherPosition", v)}
                    options={[
                      { value: "right", label: t("shopifyChat.right") },
                      { value: "left", label: t("shopifyChat.left") },
                    ]}
                  />
                </Field>
              </div>
              <Field
                label={`${t("shopifyChat.cornerRadius")}: ${draft.appearance.cornerRadius}px`}
                hint={t("shopifyChat.cornerRadiusHint")}
              >
                <input
                  type="range"
                  min={0}
                  max={28}
                  value={draft.appearance.cornerRadius}
                  onChange={(e) => patch("appearance.cornerRadius", Number(e.target.value))}
                  className="w-full"
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label={t("shopifyChat.language")}>
                  <Select
                    value={draft.appearance.language}
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
                    value={draft.appearance.direction}
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
                checked={!!draft.appearance.showPoweredBy}
                onChange={(v) => patch("appearance.showPoweredBy", v)}
              />
            </Card>
          )}

          {section === "welcome" && (
            <ExperienceSection section="welcome" ux={draft.ux} patch={patch} t={t} />
          )}

          {section === "commerce" && (
            <Card title={t("shopifyChat.section.commerce")}>
              <Toggle
                label={t("shopifyChat.productMessaging")}
                hint={t("shopifyChat.productMessagingHint")}
                checked={!!draft.commerce.productMessagingEnabled}
                onChange={(v) => patch("commerce.productMessagingEnabled", v)}
              />
              <Toggle
                label={t("shopifyChat.addToCartEnabled")}
                checked={!!draft.commerce.addToCartEnabled}
                onChange={(v) => patch("commerce.addToCartEnabled", v)}
              />
              <Field label={t("shopifyChat.carouselSize")} hint={t("shopifyChat.carouselSizeHint")}>
                <Select
                  value={String(draft.commerce.carouselSize)}
                  onChange={(v) => patch("commerce.carouselSize", Number(v))}
                  options={[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: String(n) }))}
                />
              </Field>
              <Toggle
                label={t("shopifyChat.allowUnpublished")}
                hint={t("shopifyChat.allowUnpublishedHint")}
                checked={!!draft.commerce.allowUnpublishedProducts}
                onChange={(v) => patch("commerce.allowUnpublishedProducts", v)}
              />
            </Card>
          )}

          {section === "handoff" && (
            <Card title={t("shopifyChat.section.handoff")}>
              <Toggle
                label={t("shopifyChat.allowHumanHandoff")}
                hint={t("shopifyChat.allowHumanHandoffHint")}
                checked={!!draft.routing.allowHumanHandoff}
                onChange={(v) => patch("routing.allowHumanHandoff", v)}
              />
              <Toggle
                label={t("shopifyChat.allowReturnToAi")}
                checked={!!draft.routing.allowReturnToAi}
                onChange={(v) => patch("routing.allowReturnToAi", v)}
              />
            </Card>
          )}

          {section === "hours" && (
            <Card title={t("shopifyChat.section.hours")}>
              {/* The schedule itself lives with the business, not with this
                  channel. A widget that kept its own week silently
                  disagreed with the AI employee about whether the store
                  was open. */}
              <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm text-gray-600">
                <p>{t("shopifyChat.hoursMovedHint")}</p>
                <a
                  href="/settings/business-hours"
                  className="mt-1 inline-block text-primary-600 hover:text-primary-700"
                >
                  {t("shopifyChat.hoursMovedLink")} →
                </a>
              </div>
              <Field label={t("shopifyChat.offlineBehavior")}>
                    <Select
                      value={draft.hours.offlineBehavior}
                      onChange={(v) => patch("hours.offlineBehavior", v)}
                      options={[
                        { value: "ai", label: t("shopifyChat.offlineAi") },
                        { value: "form", label: t("shopifyChat.offlineForm") },
                        { value: "message_only", label: t("shopifyChat.offlineMessageOnly") },
                      ]}
                    />
                  </Field>
                  <Field label={t("shopifyChat.offlineMessage")}>
                    <textarea
                      rows={2}
                      maxLength={300}
                      value={draft.hours.offlineMessage}
                      onChange={(e) => patch("hours.offlineMessage", e.target.value)}
                      className="w-full text-sm px-3 py-2 border border-gray-200 rounded-lg"
                    />
                  </Field>
            </Card>
          )}

          {section === "privacy" && (
            <Card title={t("shopifyChat.section.privacy")}>
              <Toggle
                label={t("shopifyChat.useCartContext")}
                hint={t("shopifyChat.useCartContextHint")}
                checked={!!draft.privacy.useCartContext}
                onChange={(v) => patch("privacy.useCartContext", v)}
              />
              <Toggle
                label={t("shopifyChat.requireOfflineConsent")}
                hint={t("shopifyChat.requireOfflineConsentHint")}
                checked={!!draft.privacy.requireOfflineConsent}
                onChange={(v) => patch("privacy.requireOfflineConsent", v)}
              />
              <Field label={t("shopifyChat.consentText")}>
                <input
                  maxLength={300}
                  value={draft.hours.offlineConsentText || ""}
                  onChange={(e) => patch("hours.offlineConsentText", e.target.value)}
                  className="w-full text-sm px-3 py-2 border border-gray-200 rounded-lg"
                />
              </Field>
              <p className="text-xs text-gray-500">{t("shopifyChat.privacyNote")}</p>
            </Card>
          )}

          {section === "diagnostics" && (
            <Card title={t("shopifyChat.section.diagnostics")}>
              <ul className="space-y-2.5">
                {(diagnostics?.checks || []).map((c: any) => (
                  <li key={c.id} className="flex items-start gap-2.5">
                    <span
                      className={clsx(
                        "mt-1 w-2 h-2 rounded-full shrink-0",
                        c.ok ? "bg-green-500" : c.state === "blocked" ? "bg-red-500" : "bg-amber-500",
                      )}
                      aria-hidden="true"
                    />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900">{c.title}</p>
                      <p className="text-xs text-gray-500">{c.detail}</p>
                      {!c.ok && c.fix && <p className="text-xs text-primary-600 mt-0.5">{c.fix}</p>}
                    </div>
                  </li>
                ))}
              </ul>
              <div className="pt-3 border-t border-gray-100">
                <button
                  type="button"
                  onClick={() => setDeleteOpen(true)}
                  className="text-sm text-red-600 hover:text-red-700"
                >
                  {t("shopifyChat.deleteChannel")}
                </button>
              </div>
            </Card>
          )}

          {dirty && (
            <div className="sticky bottom-3 flex items-center justify-between gap-3 bg-white border border-gray-200 rounded-xl shadow-lg px-4 py-3">
              <span className="text-xs text-gray-500">{t("shopifyChat.unsaved")}</span>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setDraft(structuredClone(channel.config));
                    setDirty(false);
                  }}
                  className="text-sm px-3 py-1.5 rounded-lg text-gray-600 hover:bg-gray-50"
                >
                  {t("common.cancel")}
                </button>
                <button
                  onClick={() => handleSave()}
                  disabled={saving}
                  className="text-sm font-medium px-4 py-1.5 rounded-lg bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-40"
                >
                  {t("common.save")}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Preview */}
        <div className="lg:sticky lg:top-4 lg:self-start space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {(["welcome", "conversation", "product", "carousel", "offline"] as PreviewState[]).map((s) => (
              <button
                key={s}
                onClick={() => setPreviewState(s)}
                aria-pressed={previewState === s}
                className={clsx(
                  "text-[11px] px-2.5 py-1 rounded-full border transition",
                  previewState === s
                    ? "border-primary-500 bg-primary-50 text-primary-700"
                    : "border-gray-200 text-gray-600 hover:bg-gray-50",
                )}
              >
                {t(`shopifyChat.preview.${s}`)}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(["desktop", "mobile"] as PreviewDevice[]).map((d) => (
              <button
                key={d}
                onClick={() => setPreviewDevice(d)}
                aria-pressed={previewDevice === d}
                className={clsx(
                  "text-[11px] px-2.5 py-1 rounded-full border transition",
                  previewDevice === d
                    ? "border-primary-500 bg-primary-50 text-primary-700"
                    : "border-gray-200 text-gray-600 hover:bg-gray-50",
                )}
              >
                {t(`shopifyChat.preview.${d}`)}
              </button>
            ))}
            {(["en", "he"] as const).map((l) => (
              <button
                key={l}
                onClick={() => setPreviewLang(l)}
                aria-pressed={previewLang === l}
                className={clsx(
                  "text-[11px] px-2.5 py-1 rounded-full border transition",
                  previewLang === l
                    ? "border-primary-500 bg-primary-50 text-primary-700"
                    : "border-gray-200 text-gray-600 hover:bg-gray-50",
                )}
              >
                {l === "he" ? "עברית · RTL" : "English · LTR"}
              </button>
            ))}
          </div>
          <WidgetPreview
            config={draft}
            device={previewDevice}
            state={previewState}
            language={previewLang}
            sampleProducts={previewProducts.length ? previewProducts : PREVIEW_FIXTURE}
            productsAreReal={productsAreReal && previewProducts.length > 0}
          />
        </div>
      </div>

      <ConfirmModal
        isOpen={deleteOpen}
        title={t("shopifyChat.deleteTitle")}
        message={t("shopifyChat.deleteMessage")}
        confirmText={t("common.delete")}
        danger
        onConfirm={handleDelete}
        onCancel={() => setDeleteOpen(false)}
      />
    </div>
  );
}

// ── Small presentational helpers ────────────────────────────

function Header({ t }: { t: (k: string) => string }) {
  return (
    <div className="flex items-start gap-3">
      <span className="w-11 h-11 rounded-xl bg-gray-50 border border-gray-100 flex items-center justify-center shrink-0">
        <ShopifyGlyph className="w-6 h-6" />
      </span>
      <div className="min-w-0">
        <h1 className="text-2xl font-bold text-gray-900">{t("shopifyChat.title")}</h1>
        <p className="text-sm text-gray-500 mt-1">{t("shopifyChat.subtitle")}</p>
      </div>
    </div>
  );
}


