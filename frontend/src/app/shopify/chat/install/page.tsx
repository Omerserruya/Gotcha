"use client";

/**
 * GOTCHA Chat — Shopify App Store onboarding.
 *
 * Where a merchant lands after authorizing the app on Shopify. Seven steps,
 * of which the merchant performs three: sign in, choose an organization,
 * switch the App Embed on. Everything else — the channel, the public
 * binding, the storefront domains — is done for them, because every one of
 * those was previously a copy-paste step and every copy-paste step is a
 * place a merchant stops.
 *
 * The install itself is identified by an HttpOnly cookie the OAuth callback
 * set, with the `?session=` parameter as a fallback. Nothing here reads a
 * tenant id, an integration id or a channel key from the URL.
 */

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import clsx from "clsx";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { setActiveTenantId } from "@/lib/active-tenant";
import {
  getShopifyChatInstallContext,
  bindShopifyChatInstall,
  getShopifyChatActivation,
  type ShopifyChatInstallContext,
  type ShopifyChatActivation,
} from "@/lib/api";

type StepKey = "installed" | "signin" | "organization" | "connect" | "activate" | "verify" | "done";

const STEPS: StepKey[] = ["installed", "signin", "organization", "connect", "activate", "verify", "done"];

export default function ShopifyChatInstallPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-screen">
          <div className="w-6 h-6 border-2 border-primary-200 border-t-primary-500 rounded-full animate-spin" />
        </div>
      }
    >
      <InstallWizard />
    </Suspense>
  );
}

function InstallWizard() {
  const { t } = useI18n();
  const { user, token, isLoading, memberships, login } = useAuth();
  const params = useSearchParams();
  const session = params.get("session");
  const urlError = params.get("error");

  const [context, setContext] = useState<ShopifyChatInstallContext | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  const [activation, setActivation] = useState<ShopifyChatActivation | null>(null);
  const [selectedTenant, setSelectedTenant] = useState<string | null>(null);
  const [binding, setBinding] = useState(false);
  const [bindError, setBindError] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const [openedEditor, setOpenedEditor] = useState(false);

  // ── Load the verified install ────────────────────────────
  useEffect(() => {
    if (!token) return;
    getShopifyChatInstallContext(token, session)
      .then((r) => {
        setContext(r.data);
        setContextError(null);
      })
      .catch((err: any) => setContextError(err?.code || err?.message || "error"));
  }, [token, session]);

  const loadActivation = useCallback(async () => {
    if (!token || !context?.shopDomain) return null;
    try {
      const r = await getShopifyChatActivation(token, { shop: context.shopDomain, session });
      setActivation(r.data);
      return r.data;
    } catch {
      return null;
    }
  }, [token, context?.shopDomain, session]);

  useEffect(() => {
    if (context?.boundToThisOrganization) void loadActivation();
  }, [context?.boundToThisOrganization, loadActivation]);

  // ── Poll for the storefront heartbeat after activation ───
  useEffect(() => {
    if (!polling) return;
    const id = setInterval(async () => {
      const next = await loadActivation();
      if (next && (next.state === "LIVE" || next.state === "CORE_DISCONNECTED_PRODUCT_CHAT_UNAVAILABLE")) {
        setPolling(false);
      }
    }, 5000);
    return () => clearInterval(id);
  }, [polling, loadActivation]);

  // Only organizations this identity actually belongs to, and only ones
  // that can hold a channel. Membership is the authority, not the URL.
  const eligible = useMemo(
    () => memberships.filter((m) => m.tenant.isActive && m.tenant.status === "ACTIVE"),
    [memberships],
  );

  useEffect(() => {
    if (!selectedTenant && eligible.length === 1) setSelectedTenant(eligible[0].tenant.id);
  }, [eligible, selectedTenant]);

  const current: StepKey = (() => {
    if (isLoading) return "installed";
    if (!user) return "signin";
    if (!context) return "installed";
    if (!context.boundToThisOrganization) return "organization";
    if (!activation) return "connect";
    if (activation.state === "EMBED_NOT_ENABLED" || activation.state === "CHANNEL_NOT_CREATED") return "activate";
    if (activation.state === "EMBED_ENABLED_NOT_SEEN" || activation.state === "STALE") return "verify";
    if (activation.state === "LIVE" || activation.state === "CORE_DISCONNECTED_PRODUCT_CHAT_UNAVAILABLE") return "done";
    return "activate";
  })();

  async function handleBind() {
    if (!token) return;
    setBinding(true);
    setBindError(null);
    try {
      // Switching the active organization is what makes X-Tenant-Id carry
      // the merchant's choice; the server still validates the membership.
      if (selectedTenant) setActiveTenantId(selectedTenant);
      const res = await bindShopifyChatInstall(token, session);
      setActivation(res.data.activation);
      setContext((c) => (c ? { ...c, alreadyBound: true, boundToThisOrganization: true } : c));
    } catch (err: any) {
      setBindError(err?.code || err?.message || "error");
    } finally {
      setBinding(false);
    }
  }

  // ── Render ───────────────────────────────────────────────

  if (isLoading) {
    return (
      <Shell t={t} current="installed">
        <div className="flex justify-center py-10">
          <div className="w-6 h-6 border-2 border-primary-200 border-t-primary-500 rounded-full animate-spin" />
        </div>
      </Shell>
    );
  }

  if (urlError) {
    return (
      <Shell t={t} current="installed">
        <Panel tone="error" title={t("shopifyInstall.failedTitle")}>
          <p className="text-sm">{t(`shopifyInstall.error.${urlError}`) || t("shopifyInstall.failedBody")}</p>
          <p className="text-xs text-gray-500 mt-2">{t("shopifyInstall.failedRetry")}</p>
        </Panel>
      </Shell>
    );
  }

  return (
    <Shell t={t} current={current}>
      {/* Step 1 — the verified store */}
      <Panel
        tone={context ? "ok" : "neutral"}
        title={t("shopifyInstall.step1Title")}
        step={1}
        done={!!context}
      >
        {context ? (
          <p className="text-sm text-gray-700">
            {t("shopifyInstall.step1Verified")}{" "}
            <span dir="ltr" className="font-medium text-gray-900">{context.shopDomain}</span>
          </p>
        ) : contextError ? (
          <p className="text-sm text-amber-800">{t("shopifyInstall.noSession")}</p>
        ) : !user ? (
          // The install IS verified — we just cannot read it until there is
          // a GOTCHA session to read it with. "Loading..." forever would
          // read as a broken page.
          <p className="text-sm text-gray-600">{t("shopifyInstall.step1PendingSignIn")}</p>
        ) : (
          <p className="text-sm text-gray-500">{t("common.loading")}</p>
        )}
      </Panel>

      {/* Step 2 — GOTCHA identity */}
      <Panel tone={user ? "ok" : "active"} title={t("shopifyInstall.step2Title")} step={2} done={!!user}>
        {user ? (
          <p className="text-sm text-gray-700">{t("shopifyInstall.step2SignedIn")} {user.email}</p>
        ) : (
          <>
            <p className="text-sm text-gray-600 mb-3">{t("shopifyInstall.step2Body")}</p>
            <button
              onClick={() => login(typeof window !== "undefined" ? window.location.pathname + window.location.search : undefined)}
              className="text-sm font-medium px-4 py-2 rounded-lg bg-primary-500 text-white hover:bg-primary-600"
            >
              {t("shopifyInstall.step2Cta")}
            </button>
          </>
        )}
      </Panel>

      {/* Step 3 + 4 — organization and channel */}
      <Panel
        tone={context?.boundToThisOrganization ? "ok" : user ? "active" : "neutral"}
        title={t("shopifyInstall.step3Title")}
        step={3}
        done={!!context?.boundToThisOrganization}
      >
        {context?.claimedByAnotherOrganization ? (
          <p className="text-sm text-amber-800">{t("shopifyInstall.claimedElsewhere")}</p>
        ) : context?.boundToThisOrganization ? (
          <p className="text-sm text-gray-700">{t("shopifyInstall.step4Done")}</p>
        ) : user ? (
          <>
            <p className="text-sm text-gray-600 mb-3">{t("shopifyInstall.step3Body")}</p>
            <div className="space-y-2 mb-3">
              {eligible.map((m) => (
                <label
                  key={m.tenant.id}
                  className={clsx(
                    "flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition",
                    selectedTenant === m.tenant.id
                      ? "border-primary-400 bg-primary-50"
                      : "border-gray-200 hover:bg-gray-50",
                  )}
                >
                  <input
                    type="radio"
                    name="tenant"
                    checked={selectedTenant === m.tenant.id}
                    onChange={() => setSelectedTenant(m.tenant.id)}
                    className="w-4 h-4"
                  />
                  <span className="text-sm font-medium text-gray-900">{m.tenant.name}</span>
                </label>
              ))}
              {eligible.length === 0 && (
                <p className="text-sm text-amber-800">{t("shopifyInstall.noOrganizations")}</p>
              )}
            </div>
            {bindError && (
              <p className="text-sm text-red-700 mb-2">
                {t(`shopifyInstall.bindError.${bindError}`) || t("shopifyInstall.bindFailed")}
              </p>
            )}
            <button
              onClick={handleBind}
              disabled={!selectedTenant || binding}
              className="text-sm font-medium px-4 py-2 rounded-lg bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-40"
            >
              {binding ? t("shopifyInstall.connecting") : t("shopifyInstall.step4Cta")}
            </button>
          </>
        ) : (
          <p className="text-sm text-gray-400">{t("shopifyInstall.stepLocked")}</p>
        )}
      </Panel>

      {/* Step 5 — App Embed */}
      <Panel
        tone={
          activation && ["EMBED_ENABLED_NOT_SEEN", "LIVE", "STALE", "CORE_DISCONNECTED_PRODUCT_CHAT_UNAVAILABLE"].includes(activation.state)
            ? "ok"
            : context?.boundToThisOrganization
              ? "active"
              : "neutral"
        }
        title={t("shopifyInstall.step5Title")}
        step={4}
        done={!!activation && activation.state !== "EMBED_NOT_ENABLED" && activation.state !== "CHANNEL_NOT_CREATED"}
      >
        {context?.boundToThisOrganization ? (
          <>
            <p className="text-sm text-gray-600 mb-3">{t("shopifyInstall.step5Body")}</p>
            {activation?.themeEditorDeepLink ? (
              <a
                href={activation.themeEditorDeepLink}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => {
                  // Opening the editor proves nothing. Only a heartbeat from
                  // a real storefront moves this to "active".
                  setOpenedEditor(true);
                  setPolling(true);
                }}
                className="inline-block text-sm font-medium px-4 py-2 rounded-lg bg-primary-500 text-white hover:bg-primary-600"
              >
                {t("shopifyInstall.step5Cta")}
              </a>
            ) : (
              <p className="text-xs text-amber-700">{t("shopifyInstall.noDeepLink")}</p>
            )}
            {openedEditor && (
              <p className="text-xs text-gray-500 mt-2">{t("shopifyInstall.step5AfterSave")}</p>
            )}
          </>
        ) : (
          <p className="text-sm text-gray-400">{t("shopifyInstall.stepLocked")}</p>
        )}
      </Panel>

      {/* Step 6 — verification */}
      <Panel
        tone={activation?.state === "LIVE" || activation?.state === "CORE_DISCONNECTED_PRODUCT_CHAT_UNAVAILABLE" ? "ok" : "neutral"}
        title={t("shopifyInstall.step6Title")}
        step={5}
        done={activation?.state === "LIVE" || activation?.state === "CORE_DISCONNECTED_PRODUCT_CHAT_UNAVAILABLE"}
      >
        {activation ? (
          <>
            <p className="text-sm text-gray-700">{t(`shopifyInstall.state.${activation.state}`)}</p>
            <div className="mt-3 flex items-center gap-2">
              <button
                onClick={() => void loadActivation()}
                className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50"
              >
                {t("shopifyInstall.checkAgain")}
              </button>
              {polling && <span className="text-xs text-gray-400">{t("shopifyInstall.watching")}</span>}
            </div>
          </>
        ) : (
          <p className="text-sm text-gray-400">{t("shopifyInstall.stepLocked")}</p>
        )}
      </Panel>

      {/* Step 7 — the summary */}
      {activation && (
        <Panel tone="neutral" title={t("shopifyInstall.step7Title")} step={6}>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
            <Fact label={t("shopifyInstall.factStore")} value={activation.shopDomain} ok />
            <Fact label={t("shopifyInstall.factChannel")} value={activation.channelId ? t("common.yes") : t("common.no")} ok={!!activation.channelId} />
            <Fact
              label={t("shopifyInstall.factEmbed")}
              value={activation.state === "LIVE" || activation.state === "CORE_DISCONNECTED_PRODUCT_CHAT_UNAVAILABLE" ? t("shopifyInstall.factActive") : t("shopifyInstall.factInactive")}
              ok={activation.state === "LIVE" || activation.state === "CORE_DISCONNECTED_PRODUCT_CHAT_UNAVAILABLE"}
            />
            <Fact label={t("shopifyInstall.factChat")} value={activation.channelEnabled ? t("common.enabled") : t("common.disabled")} ok={activation.channelEnabled} />
            <Fact
              label={t("shopifyInstall.factProducts")}
              value={activation.productMessaging ? t("common.enabled") : t("shopifyInstall.factProductsOff")}
              ok={activation.productMessaging}
            />
            <Fact
              label={t("shopifyInstall.factCore")}
              value={activation.coreConnected ? t("common.connected") : t("common.notConnected")}
              ok={activation.coreConnected}
            />
          </dl>
          <div className="mt-4 flex flex-wrap gap-2">
            <a
              href="/settings/channels/shopify-live-chat"
              className="text-sm font-medium px-4 py-2 rounded-lg bg-primary-500 text-white hover:bg-primary-600"
            >
              {t("shopifyInstall.openSettings")}
            </a>
            <a
              href={`https://${activation.shopDomain}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium px-4 py-2 rounded-lg border border-gray-200 hover:bg-gray-50"
            >
              {t("shopifyInstall.openStorefront")}
            </a>
          </div>
          <details className="mt-4">
            <summary className="text-xs text-gray-400 cursor-pointer">
              {t("shopifyInstall.advanced")}
            </summary>
            <div className="mt-2 text-xs text-gray-500 space-y-1">
              <p>
                {t("shopifyInstall.advancedDomains")}{" "}
                <span dir="ltr">{activation.verifiedDomains.join(", ") || "—"}</span>
              </p>
              <p>{t("shopifyInstall.advancedManual")}</p>
            </div>
          </details>
        </Panel>
      )}
    </Shell>
  );
}

// ── Presentation ───────────────────────────────────────────

function Shell({
  t,
  current,
  children,
}: {
  t: (k: string) => string;
  current: StepKey;
  children: React.ReactNode;
}) {
  const idx = STEPS.indexOf(current);
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-2xl mx-auto px-4 py-10 space-y-4">
        <div className="flex items-center gap-3">
          <span className="w-11 h-11 rounded-xl bg-white border border-gray-200 flex items-center justify-center shrink-0">
            <svg className="w-6 h-6" viewBox="0 0 256 292" aria-label="Shopify" role="img">
              <path
                d="M223.774 57.34c-.201-1.46-1.48-2.268-2.537-2.357-1.055-.088-23.383-1.743-23.383-1.743s-15.507-15.395-17.209-17.099c-1.703-1.703-5.029-1.185-6.32-.805-.19.056-3.388 1.043-8.678 2.68-5.18-14.906-14.322-28.604-30.405-28.604-.444 0-.901.018-1.358.044C129.31 3.407 123.644.779 118.75.779c-37.465 0-55.364 46.835-60.976 70.635-14.558 4.511-24.9 7.718-26.221 8.133-8.126 2.549-8.383 2.805-9.45 10.462C21.3 95.806.038 260.235.038 260.235l165.678 31.042 89.77-19.42S223.973 58.8 223.774 57.34z"
                fill="#95BF46"
              />
              <path
                d="M135.242 104.585l-11.069 32.926s-9.698-5.176-21.586-5.176c-17.428 0-18.305 10.937-18.305 13.693 0 15.038 39.2 20.8 39.2 56.024 0 27.713-17.577 45.558-41.277 45.558-28.44 0-42.984-17.7-42.984-17.7l7.615-25.16s14.95 12.835 27.565 12.835c8.243 0 11.596-6.49 11.596-11.232 0-19.616-32.16-20.491-32.16-52.724 0-27.129 19.472-53.382 58.778-53.382 15.145 0 22.627 4.338 22.627 4.338"
                fill="#FFF"
              />
            </svg>
          </span>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{t("shopifyInstall.title")}</h1>
            <p className="text-sm text-gray-500">{t("shopifyInstall.subtitle")}</p>
          </div>
        </div>

        <div className="flex gap-1" aria-hidden="true">
          {STEPS.map((s, i) => (
            <span
              key={s}
              className={clsx(
                "h-1 flex-1 rounded-full",
                i <= idx ? "bg-primary-500" : "bg-gray-200",
              )}
            />
          ))}
        </div>

        {children}
      </div>
    </div>
  );
}

function Panel({
  tone,
  title,
  step,
  done,
  children,
}: {
  tone: "neutral" | "active" | "ok" | "error";
  title: string;
  step?: number;
  done?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      className={clsx(
        "rounded-2xl border p-5",
        tone === "ok" && "bg-white border-green-200",
        tone === "active" && "bg-white border-primary-300 shadow-sm",
        tone === "neutral" && "bg-white border-gray-200",
        tone === "error" && "bg-red-50 border-red-200",
      )}
    >
      <div className="flex items-center gap-2 mb-2">
        {step != null && (
          <span
            className={clsx(
              "w-6 h-6 rounded-full text-[11px] font-semibold flex items-center justify-center",
              done ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500",
            )}
          >
            {done ? "✓" : step}
          </span>
        )}
        <h2 className="font-semibold text-sm text-gray-900">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function Fact({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-gray-50 px-3 py-2">
      <dt className="text-gray-500">{label}</dt>
      <dd className={clsx("font-medium text-end", ok ? "text-green-700" : "text-gray-500")} dir="auto">
        {value}
      </dd>
    </div>
  );
}
