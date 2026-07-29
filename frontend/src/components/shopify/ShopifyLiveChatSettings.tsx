"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import {
  getShopifyStore,
  listShopifyLiveChatChannels,
  createShopifyLiveChatChannel,
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
 * changed. Everything is one saveable draft — a half-configured widget
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
  "ai",
  "routing",
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
      const [storeRes, channelsRes] = await Promise.all([
        getShopifyStore(token),
        listShopifyLiveChatChannels(token),
      ]);
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

  async function handleCreate() {
    if (!token) return;
    setSaving(true);
    try {
      const res = await createShopifyLiveChatChannel(token);
      setChannel(res.data);
      setDraft(structuredClone(res.data.config));
      setSection("installation");
      notify(t("shopifyChat.created"));
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

      {/* What is stopping this going live, right now */}
      <div
        className={clsx(
          "rounded-2xl border p-4 flex items-start gap-3",
          blocking ? "bg-red-50 border-red-200" : draft.enabled ? "bg-green-50 border-green-200" : "bg-gray-50 border-gray-200",
        )}
      >
        <div className="flex-1">
          <p className="font-semibold text-sm text-gray-900">
            {blocking
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
            <Card title={t("shopifyChat.section.launcher")} hint={t("shopifyChat.launcherHint")}>
              <div className="grid grid-cols-2 gap-3">
                <Field label={t("shopifyChat.launcherShape")}>
                  <Select
                    value={draft.ux?.launcher?.shape ?? "circle"}
                    onChange={(v) => patch("ux.launcher.shape", v)}
                    options={["circle", "rounded", "pill"].map((v) => ({ value: v, label: t(`shopifyChat.shape.${v}`) }))}
                  />
                </Field>
                <Field label={`${t("shopifyChat.launcherSize")}: ${draft.ux?.launcher?.size ?? 60}px`}>
                  <input type="range" min={44} max={96} value={draft.ux?.launcher?.size ?? 60}
                    onChange={(e) => patch("ux.launcher.size", Number(e.target.value))} className="w-full" />
                </Field>
                <Field label={t("shopifyChat.launcherBg")}>
                  <ColorInput value={draft.ux?.launcher?.backgroundColor ?? "#111827"} onChange={(v) => patch("ux.launcher.backgroundColor", v)} />
                </Field>
                <Field label={t("shopifyChat.launcherFg")}>
                  <ColorInput value={draft.ux?.launcher?.iconColor ?? "#ffffff"} onChange={(v) => patch("ux.launcher.iconColor", v)} />
                </Field>
                <Field label={t("shopifyChat.position")}>
                  <Select value={draft.ux?.launcher?.position ?? "right"} onChange={(v) => patch("ux.launcher.position", v)}
                    options={[{ value: "right", label: t("shopifyChat.right") }, { value: "left", label: t("shopifyChat.left") }]} />
                </Field>
                <Field label={t("shopifyChat.mobilePosition")}>
                  <Select value={draft.ux?.launcher?.mobilePosition ?? "right"} onChange={(v) => patch("ux.launcher.mobilePosition", v)}
                    options={[{ value: "right", label: t("shopifyChat.right") }, { value: "left", label: t("shopifyChat.left") }]} />
                </Field>
                <Field label={`${t("shopifyChat.offsetBottom")}: ${draft.ux?.launcher?.offsetBottom ?? 20}px`}>
                  <input type="range" min={0} max={120} value={draft.ux?.launcher?.offsetBottom ?? 20}
                    onChange={(e) => patch("ux.launcher.offsetBottom", Number(e.target.value))} className="w-full" />
                </Field>
                <Field label={`${t("shopifyChat.offsetSide")}: ${draft.ux?.launcher?.offsetSide ?? 20}px`}>
                  <input type="range" min={0} max={120} value={draft.ux?.launcher?.offsetSide ?? 20}
                    onChange={(e) => patch("ux.launcher.offsetSide", Number(e.target.value))} className="w-full" />
                </Field>
              </div>
              <Field label={`${t("shopifyChat.shadow")}: ${draft.ux?.launcher?.shadow ?? 2}`}>
                <input type="range" min={0} max={3} value={draft.ux?.launcher?.shadow ?? 2}
                  onChange={(e) => patch("ux.launcher.shadow", Number(e.target.value))} className="w-full" />
              </Field>
              <Field label={t("shopifyChat.launcherIcon")}>
                <Select value={draft.ux?.launcher?.icon ?? "chat"} onChange={(v) => patch("ux.launcher.icon", v)}
                  options={["chat", "sparkle", "bag", "question", "custom"].map((v) => ({ value: v, label: t(`shopifyChat.icon.${v}`) }))} />
              </Field>
              {draft.ux?.launcher?.icon === "custom" && (
                <Field label={t("shopifyChat.launcherIconUrl")} hint={t("shopifyChat.mediaHint")}>
                  <input type="url" value={draft.ux?.launcher?.iconUrl ?? ""}
                    onChange={(e) => patch("ux.launcher.iconUrl", e.target.value || null)}
                    className="w-full text-sm px-3 py-2 border border-gray-200 rounded-lg" />
                </Field>
              )}
              <Toggle label={t("shopifyChat.showLabel")} checked={!!draft.ux?.launcher?.showLabel}
                onChange={(v) => patch("ux.launcher.showLabel", v)} />
              {draft.ux?.launcher?.showLabel && (
                <Field label={t("shopifyChat.launcherLabel")}>
                  <input maxLength={24} value={draft.ux?.launcher?.label ?? ""}
                    onChange={(e) => patch("ux.launcher.label", e.target.value)}
                    placeholder={t("shopifyChat.launcherLabelPlaceholder")}
                    className="w-full text-sm px-3 py-2 border border-gray-200 rounded-lg" />
                </Field>
              )}
              <Toggle label={t("shopifyChat.showBorder")} checked={!!draft.ux?.launcher?.showBorder}
                onChange={(v) => patch("ux.launcher.showBorder", v)} />
              <Toggle label={t("shopifyChat.showUnreadBadge")} checked={draft.ux?.launcher?.showUnreadBadge !== false}
                onChange={(v) => patch("ux.launcher.showUnreadBadge", v)} />
            </Card>
          )}

          {section === "proactive" && (
            <Card title={t("shopifyChat.section.proactive")} hint={t("shopifyChat.proactiveHint")}>
              <Toggle label={t("shopifyChat.proactiveEnabled")} hint={t("shopifyChat.proactiveEnabledHint")}
                checked={!!draft.ux?.proactive?.enabled} onChange={(v) => patch("ux.proactive.enabled", v)} />
              {draft.ux?.proactive?.enabled && (
                <>
                  <Field label={t("shopifyChat.trigger")}>
                    <Select value={draft.ux?.proactive?.trigger ?? "time_on_page"} onChange={(v) => patch("ux.proactive.trigger", v)}
                      options={["time_on_page", "page_views", "scroll_depth", "exit_intent", "product_page", "cart_page", "inactivity", "custom_event"]
                        .map((v) => ({ value: v, label: t(`shopifyChat.trigger.${v}`) }))} />
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label={`${t("shopifyChat.delay")}: ${draft.ux?.proactive?.delaySeconds ?? 15}s`}>
                      <input type="range" min={3} max={120} value={draft.ux?.proactive?.delaySeconds ?? 15}
                        onChange={(e) => patch("ux.proactive.delaySeconds", Number(e.target.value))} className="w-full" />
                    </Field>
                    <Field label={`${t("shopifyChat.mobileDelay")}: ${draft.ux?.proactive?.mobileDelaySeconds ?? 25}s`}>
                      <input type="range" min={3} max={120} value={draft.ux?.proactive?.mobileDelaySeconds ?? 25}
                        onChange={(e) => patch("ux.proactive.mobileDelaySeconds", Number(e.target.value))} className="w-full" />
                    </Field>
                  </div>
                  <Field label={t("shopifyChat.teaserTitle")}>
                    <input maxLength={60} value={draft.ux?.proactive?.title ?? ""}
                      onChange={(e) => patch("ux.proactive.title", e.target.value)}
                      className="w-full text-sm px-3 py-2 border border-gray-200 rounded-lg" />
                  </Field>
                  <Field label={t("shopifyChat.teaserMessage")}>
                    <textarea rows={2} maxLength={200} value={draft.ux?.proactive?.message ?? ""}
                      onChange={(e) => patch("ux.proactive.message", e.target.value)}
                      className="w-full text-sm px-3 py-2 border border-gray-200 rounded-lg" />
                  </Field>
                  <Field label={t("shopifyChat.teaserAction")}>
                    <input maxLength={30} value={draft.ux?.proactive?.actionLabel ?? ""}
                      onChange={(e) => patch("ux.proactive.actionLabel", e.target.value)}
                      className="w-full text-sm px-3 py-2 border border-gray-200 rounded-lg" />
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label={t("shopifyChat.maxPerSession")}>
                      <Select value={String(draft.ux?.proactive?.maxPerSession ?? 1)} onChange={(v) => patch("ux.proactive.maxPerSession", Number(v))}
                        options={[1, 2, 3].map((n) => ({ value: String(n), label: String(n) }))} />
                    </Field>
                    <Field label={`${t("shopifyChat.cooldown")}: ${draft.ux?.proactive?.cooldownHours ?? 24}h`}>
                      <input type="range" min={1} max={168} value={draft.ux?.proactive?.cooldownHours ?? 24}
                        onChange={(e) => patch("ux.proactive.cooldownHours", Number(e.target.value))} className="w-full" />
                    </Field>
                  </div>
                  <Toggle label={t("shopifyChat.autoOpen")} hint={t("shopifyChat.autoOpenHint")}
                    checked={!!draft.ux?.proactive?.autoOpen} onChange={(v) => patch("ux.proactive.autoOpen", v)} />
                  <Toggle label={t("shopifyChat.desktopEnabled")} checked={draft.ux?.proactive?.desktopEnabled !== false}
                    onChange={(v) => patch("ux.proactive.desktopEnabled", v)} />
                  <Toggle label={t("shopifyChat.mobileEnabled")} checked={draft.ux?.proactive?.mobileEnabled !== false}
                    onChange={(v) => patch("ux.proactive.mobileEnabled", v)} />
                  <Toggle label={t("shopifyChat.respectHours")} checked={draft.ux?.proactive?.respectBusinessHours !== false}
                    onChange={(v) => patch("ux.proactive.respectBusinessHours", v)} />
                </>
              )}
            </Card>
          )}

          {section === "sounds" && (
            <Card title={t("shopifyChat.section.sounds")} hint={t("shopifyChat.soundsHint")}>
              <Toggle label={t("shopifyChat.soundsEnabled")} checked={!!draft.ux?.sounds?.enabled}
                onChange={(v) => patch("ux.sounds.enabled", v)} />
              {draft.ux?.sounds?.enabled && (
                <>
                  <Field label={t("shopifyChat.soundPack")}>
                    <Select value={draft.ux?.sounds?.pack ?? "subtle"} onChange={(v) => patch("ux.sounds.pack", v)}
                      options={["subtle", "classic"].map((v) => ({ value: v, label: t(`shopifyChat.pack.${v}`) }))} />
                  </Field>
                  <Field label={`${t("shopifyChat.volume")}: ${draft.ux?.sounds?.volume ?? 40}%`}>
                    <input type="range" min={0} max={100} value={draft.ux?.sounds?.volume ?? 40}
                      onChange={(e) => patch("ux.sounds.volume", Number(e.target.value))} className="w-full" />
                  </Field>
                  <SoundPreview pack={draft.ux?.sounds?.pack ?? "subtle"} volume={draft.ux?.sounds?.volume ?? 40} t={t} />
                  <Toggle label={t("shopifyChat.soundOutgoing")} checked={draft.ux?.sounds?.outgoing !== false}
                    onChange={(v) => patch("ux.sounds.outgoing", v)} />
                  <Toggle label={t("shopifyChat.soundIncomingAi")} checked={draft.ux?.sounds?.incomingAi !== false}
                    onChange={(v) => patch("ux.sounds.incomingAi", v)} />
                  <Toggle label={t("shopifyChat.soundIncomingHuman")} checked={draft.ux?.sounds?.incomingHuman !== false}
                    onChange={(v) => patch("ux.sounds.incomingHuman", v)} />
                  <Toggle label={t("shopifyChat.soundProactive")} checked={!!draft.ux?.sounds?.proactive}
                    onChange={(v) => patch("ux.sounds.proactive", v)} />
                  <Toggle label={t("shopifyChat.soundWhenClosed")} checked={draft.ux?.sounds?.playWhenClosed !== false}
                    onChange={(v) => patch("ux.sounds.playWhenClosed", v)} />
                  <Toggle label={t("shopifyChat.soundWhenTabActive")} checked={draft.ux?.sounds?.playWhenTabActive !== false}
                    onChange={(v) => patch("ux.sounds.playWhenTabActive", v)} />
                </>
              )}
            </Card>
          )}

          {section === "behavior" && (
            <Card title={t("shopifyChat.section.behavior")}>
              <Toggle label={t("shopifyChat.openOnLoad")} hint={t("shopifyChat.openOnLoadHint")}
                checked={!!draft.ux?.behavior?.openOnLoad} onChange={(v) => patch("ux.behavior.openOnLoad", v)} />
              <Toggle label={t("shopifyChat.closeOnOutsideClick")} checked={!!draft.ux?.behavior?.closeOnOutsideClick}
                onChange={(v) => patch("ux.behavior.closeOnOutsideClick", v)} />
              <Toggle label={t("shopifyChat.rememberOpenState")} checked={draft.ux?.behavior?.rememberOpenState !== false}
                onChange={(v) => patch("ux.behavior.rememberOpenState", v)} />
              <Toggle label={t("shopifyChat.mobileFullScreen")} checked={draft.ux?.behavior?.mobileFullScreen !== false}
                onChange={(v) => patch("ux.behavior.mobileFullScreen", v)} />
              <Toggle label={t("shopifyChat.keepHeaderMedia")} hint={t("shopifyChat.keepHeaderMediaHint")}
                checked={!!draft.ux?.behavior?.keepHeaderMedia} onChange={(v) => patch("ux.behavior.keepHeaderMedia", v)} />
            </Card>
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
            <>
              <Card title={t("shopifyChat.section.welcome")} hint={t("shopifyChat.welcomeSectionHint")}>
                <Field label={t("shopifyChat.assistantName")} hint={t("shopifyChat.assistantNameHint")}>
                  <input maxLength={40} value={welcome.assistantName}
                    onChange={(e) => patch("ux.welcome.assistantName", e.target.value)}
                    className="w-full text-sm px-3 py-2 border border-gray-200 rounded-lg" />
                </Field>
                <Field label={t("shopifyChat.headline")}>
                  <input maxLength={60} value={welcome.title}
                    onChange={(e) => patch("ux.welcome.title", e.target.value)}
                    className="w-full text-sm px-3 py-2 border border-gray-200 rounded-lg" />
                </Field>
                <Field label={t("shopifyChat.subline")}>
                  <textarea rows={3} maxLength={200} value={welcome.subtitle}
                    onChange={(e) => patch("ux.welcome.subtitle", e.target.value)}
                    className="w-full text-sm px-3 py-2 border border-gray-200 rounded-lg" />
                </Field>
                <Field label={t("shopifyChat.textAlign")}>
                  <Select value={welcome.textAlign} onChange={(v) => patch("ux.welcome.textAlign", v)}
                    options={[
                      { value: "center", label: t("shopifyChat.alignCenter") },
                      { value: "start", label: t("shopifyChat.alignStart") },
                    ]} />
                </Field>
              </Card>

              <Card title={t("shopifyChat.avatarCard")} hint={t("shopifyChat.avatarCardHint")}>
                <MediaField label={t("shopifyChat.avatarUrl")} slot="image"
                  value={welcome.avatarUrl} onChange={(v) => patch("ux.welcome.avatarUrl", v)} t={t} />
                <div className="grid grid-cols-2 gap-3">
                  <Field label={`${t("shopifyChat.heroAvatarSize")}: ${welcome.avatarSize}px`}>
                    <input type="range" min={40} max={96} value={welcome.avatarSize}
                      onChange={(e) => patch("ux.welcome.avatarSize", Number(e.target.value))} className="w-full" />
                  </Field>
                  <Field label={`${t("shopifyChat.heroOverlap")}: ${welcome.avatarOverlap}px`}
                    hint={t("shopifyChat.heroOverlapHint")}>
                    <input type="range" min={0} max={60} value={welcome.avatarOverlap}
                      onChange={(e) => patch("ux.welcome.avatarOverlap", Number(e.target.value))} className="w-full" />
                  </Field>
                </div>
              </Card>

              <Card title={t("shopifyChat.section.hero")} hint={t("shopifyChat.heroHint")}>
                <Field label={t("shopifyChat.heroMediaType")}>
                  <Select value={hero.mediaType} onChange={(v) => patch("ux.hero.mediaType", v)}
                    options={["none", "image", "gif", "video"].map((v) => ({ value: v, label: t(`shopifyChat.media.${v}`) }))} />
                </Field>
                {hero.mediaType !== "none" && (
                  <>
                    <MediaField label={t("shopifyChat.heroMediaUrl")}
                      slot={hero.mediaType === "video" ? "video" : "image"}
                      value={hero.mediaUrl} onChange={(v) => patch("ux.hero.mediaUrl", v)} t={t} />
                    {hero.mediaType === "video" && (
                      <MediaField label={t("shopifyChat.heroPoster")} slot="image" hint={t("shopifyChat.heroPosterHint")}
                        value={hero.posterUrl} onChange={(v) => patch("ux.hero.posterUrl", v)} t={t} />
                    )}
                    <div className="grid grid-cols-2 gap-3">
                      <Field label={`${t("shopifyChat.heroHeight")}: ${hero.height}px`}>
                        <input type="range" min={90} max={220} value={hero.height}
                          onChange={(e) => patch("ux.hero.height", Number(e.target.value))} className="w-full" />
                      </Field>
                      <Field label={`${t("shopifyChat.heroMobileHeight")}: ${hero.mobileHeight}px`}>
                        <input type="range" min={80} max={180} value={hero.mobileHeight}
                          onChange={(e) => patch("ux.hero.mobileHeight", Number(e.target.value))} className="w-full" />
                      </Field>
                      <Field label={`${t("shopifyChat.heroFade")}: ${hero.fadeStrength}%`}>
                        <input type="range" min={0} max={100} value={hero.fadeStrength}
                          onChange={(e) => patch("ux.hero.fadeStrength", Number(e.target.value))} className="w-full" />
                      </Field>
                      <Field label={`${t("shopifyChat.heroOverlay")}: ${hero.overlayStrength}%`}>
                        <input type="range" min={0} max={100} value={hero.overlayStrength}
                          onChange={(e) => patch("ux.hero.overlayStrength", Number(e.target.value))} className="w-full" />
                      </Field>
                    </div>
                    {/* The panel has the last word on height. Say so here
                        rather than letting the merchant wonder why their
                        220 looks like 180 on the storefront. */}
                    {heroFit !== "ok" && (
                      <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                        {t(heroFit === "dropped" ? "shopifyChat.heroDropped" : "shopifyChat.heroTight")}
                      </p>
                    )}
                    {hero.mediaType === "video" && (
                      <>
                        <Toggle label={t("shopifyChat.videoLoop")} checked={hero.videoLoop !== false}
                          onChange={(v) => patch("ux.hero.videoLoop", v)} />
                        <Toggle label={t("shopifyChat.videoAutoplay")} hint={t("shopifyChat.videoAutoplayHint")}
                          checked={hero.videoAutoplay !== false}
                          onChange={(v) => patch("ux.hero.videoAutoplay", v)} />
                      </>
                    )}
                  </>
                )}
              </Card>

              <Card title={t("shopifyChat.section.questions")} hint={t("shopifyChat.questionsHint")}>
                {welcome.suggestedQuestions.map((q: string, i: number) => (
                  <div key={i} className="flex gap-2">
                    <input maxLength={80} value={q}
                      onChange={(e) => {
                        const next = [...welcome.suggestedQuestions];
                        next[i] = e.target.value;
                        patch("ux.welcome.suggestedQuestions", next);
                      }}
                      className="flex-1 text-sm px-3 py-2 border border-gray-200 rounded-lg" />
                    <button type="button"
                      onClick={() => patch("ux.welcome.suggestedQuestions", welcome.suggestedQuestions.filter((_: string, j: number) => j !== i))}
                      aria-label={t("common.delete")}
                      className="px-3 py-2 text-sm text-gray-400 hover:text-red-600 rounded-lg">
                      ✕
                    </button>
                  </div>
                ))}
                {welcome.suggestedQuestions.length < 5 && (
                  <button type="button"
                    onClick={() => patch("ux.welcome.suggestedQuestions", [...welcome.suggestedQuestions, ""])}
                    className="text-sm text-primary-600 hover:text-primary-700">
                    + {t("shopifyChat.addQuestion")}
                  </button>
                )}
              </Card>
            </>
          )}

          {section === "ai" && (
            <Card title={t("shopifyChat.section.ai")}>
              <Field label={t("shopifyChat.aiEmployee")} hint={t("shopifyChat.aiEmployeeHint")}>
                <Select
                  value={draft.routing.aiAgentId || ""}
                  onChange={(v) => patch("routing.aiAgentId", v || null)}
                  options={[
                    { value: "", label: t("shopifyChat.noAiEmployee") },
                    ...agents.map((a) => ({ value: a.id, label: a.name })),
                  ]}
                />
              </Field>
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

          {section === "routing" && (
            <Card title={t("shopifyChat.section.routing")}>
              <Field label={t("shopifyChat.department")} hint={t("shopifyChat.departmentHint")}>
                <Select
                  value={draft.routing.departmentId || ""}
                  onChange={(v) => patch("routing.departmentId", v || null)}
                  options={[
                    { value: "", label: t("shopifyChat.noDepartment") },
                    ...departments.map((d) => ({ value: d.id, label: d.name })),
                  ]}
                />
              </Field>
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
              <Toggle
                label={t("shopifyChat.hoursEnabled")}
                hint={t("shopifyChat.hoursEnabledHint")}
                checked={!!draft.hours.enabled}
                onChange={(v) => patch("hours.enabled", v)}
              />
              {draft.hours.enabled && (
                <>
                  <Field label={t("shopifyChat.timezone")}>
                    <input
                      value={draft.hours.timezone}
                      onChange={(e) => patch("hours.timezone", e.target.value)}
                      placeholder="Asia/Jerusalem"
                      className="w-full text-sm px-3 py-2 border border-gray-200 rounded-lg"
                    />
                  </Field>
                  <div className="space-y-2">
                    {DAYS.map((d) => (
                      <div key={d} className="flex items-center gap-2">
                        <span className="w-24 text-xs text-gray-500">{t(`shopifyChat.day.${d}`)}</span>
                        <input
                          value={(draft.hours.week?.[d] || []).join(", ")}
                          onChange={(e) => {
                            const ranges = e.target.value
                              .split(",")
                              .map((r) => r.trim())
                              .filter(Boolean);
                            patch("hours.week", { ...(draft.hours.week || {}), [d]: ranges });
                          }}
                          placeholder="09:00-17:00"
                          className="flex-1 text-sm px-3 py-1.5 border border-gray-200 rounded-lg font-mono"
                        />
                      </div>
                    ))}
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
                </>
              )}
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

/**
 * A media URL input that validates against the SAME rule the storefront
 * applies, and explains a refusal in place.
 *
 * Without this the merchant pasted an http:// or .svg URL, saw the field
 * accept it, and found an empty hero on their live store with nothing to
 * explain it.
 */
function MediaField({
  label, hint, slot, value, onChange, t,
}: {
  label: string;
  hint?: string;
  slot: "image" | "video";
  value: string | null;
  onChange: (v: string | null) => void;
  t: (k: string) => string;
}) {
  const [raw, setRaw] = useState(value ?? "");
  useEffect(() => { setRaw(value ?? ""); }, [value]);

  const verdict = useMemo(() => {
    if (!raw.trim()) return null;
    return sanitizeMediaUrl(raw, slot);
  }, [raw, slot]);
  const rejected = raw.trim().length > 0 && verdict === null;

  return (
    <Field
      label={label}
      hint={
        hint ??
        (slot === "video"
          ? t("shopifyChat.mediaHintVideo")
              .replace("{mb}", String(Math.round(MEDIA_GUIDANCE.videoMaxBytes / 1e6)))
              .replace("{secs}", String(MEDIA_GUIDANCE.videoMaxSeconds))
          : t("shopifyChat.mediaHintImage")
              .replace("{mb}", String((MEDIA_GUIDANCE.imageMaxBytes / 1e6).toFixed(1)))
              .replace("{w}", String(MEDIA_GUIDANCE.recommendedWidth))
              .replace("{h}", String(MEDIA_GUIDANCE.recommendedHeight)))
      }
    >
      <input
        type="url"
        value={raw}
        placeholder="https://"
        onChange={(e) => {
          setRaw(e.target.value);
          // Only a URL the storefront would actually accept reaches the
          // draft; a rejected one stays in the box with the reason next
          // to it, rather than being saved and silently dropped later.
          const next = e.target.value.trim();
          onChange(next ? sanitizeMediaUrl(next, slot) : null);
        }}
        className={clsx(
          "w-full text-sm px-3 py-2 border rounded-lg",
          rejected ? "border-red-300 bg-red-50" : "border-gray-200",
        )}
      />
      {rejected && (
        <p className="mt-1 text-xs text-red-600">{t("shopifyChat.mediaRejected")}</p>
      )}
      {!rejected && verdict && (
        <div className="mt-2 overflow-hidden rounded-lg border border-gray-200 bg-gray-50">
          {slot === "video" ? (
            <video src={verdict} className="h-24 w-full object-cover" muted playsInline />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={verdict} alt="" className="h-24 w-full object-cover" />
          )}
        </div>
      )}
    </Field>
  );
}

function Card({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="bg-white border border-gray-200 rounded-2xl p-5 space-y-3.5">
      <div>
        <h2 className="font-semibold text-sm text-gray-900">{title}</h2>
        {hint && <p className="text-xs text-gray-500 mt-0.5">{hint}</p>}
      </div>
      {children}
    </section>
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
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-gray-700">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-gray-400">{hint}</span>}
    </label>
  );
}

/**
 * Play the built-in tones so a merchant can hear what they are choosing.
 *
 * Synthesised with the same oscillator recipe the widget uses, so the
 * preview cannot drift from the storefront. A click is itself the user
 * gesture browsers require, so nothing has to be unlocked first.
 */
function SoundPreview({ pack, volume, t }: { pack: string; volume: number; t: (k: string) => string }) {
  const TONES: Record<string, Record<string, [number, number]>> = {
    subtle: { outgoing: [520, 0.06], incoming_ai: [660, 0.09], incoming_human: [740, 0.09], proactive: [600, 0.1] },
    classic: { outgoing: [660, 0.07], incoming_ai: [880, 0.11], incoming_human: [990, 0.11], proactive: [780, 0.12] },
  };

  function play(event: string) {
    try {
      const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const spec = (TONES[pack] ?? TONES.subtle)[event] ?? [660, 0.09];
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = spec[0];
      const vol = Math.max(0, Math.min(1, volume / 100)) * 0.25;
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(vol, ctx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + spec[1]);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + spec[1] + 0.02);
      setTimeout(() => ctx.close().catch(() => {}), 600);
    } catch {
      /* a browser that will not make noise is not an error worth showing */
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      {["outgoing", "incoming_ai", "incoming_human", "proactive"].map((e) => (
        <button
          key={e}
          type="button"
          onClick={() => play(e)}
          className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50"
        >
          ▸ {t(`shopifyChat.sound.${e}`)}
        </button>
      ))}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 text-sm">
      <span className="text-gray-500">{label}</span>
      <span className="text-gray-900 font-medium text-end">{value}</span>
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
    <label className="flex items-start gap-2.5 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 w-4 h-4"
      />
      <span className="min-w-0">
        <span className="block text-sm text-gray-900">{label}</span>
        {hint && <span className="block text-[11px] text-gray-400">{hint}</span>}
      </span>
    </label>
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full text-sm px-3 py-2 border border-gray-200 rounded-lg bg-white"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function ColorInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex gap-2">
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-10 h-9 rounded-lg border border-gray-200"
        aria-label={value}
      />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 text-sm px-3 py-2 border border-gray-200 rounded-lg font-mono"
      />
    </div>
  );
}
