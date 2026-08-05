"use client";

/**
 * WhatsApp numbers: connect, manage, diagnose, repair.
 *
 * Phases 5, 6 and 8 of the redesign. Three principles run through the screen:
 *
 *  1. **No Meta vocabulary.** The customer never sees WABA, phone number ID,
 *     business token, business portfolio or Graph API. They see their phone
 *     numbers and whether each one works.
 *
 *  2. **Every number is independent.** Adding one shows only that number's
 *     progress. Repairing one only ever touches that one. Removing one says,
 *     in as many words, that the others are unaffected. The API enforces this;
 *     the UI has to make it visible, because a customer who does not believe
 *     it will not add a second number.
 *
 *  3. **No dead ends.** Meta makes us pick an onboarding flow BEFORE it will
 *     tell us which one was right, so some customers will pick wrong. Every
 *     empty result explains itself and, where it would genuinely help, offers
 *     one click to try the other way.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import { usePermissions } from "@/context/PermissionsContext";
import { useI18n } from "@/context/I18nContext";
import {
  listWhatsAppNumbers,
  inspectWhatsApp,
  connectWhatsAppNumber,
  resumeWhatsAppNumber,
  refreshWhatsAppNumber,
  repairWhatsAppNumber,
  disconnectWhatsAppNumber,
  getChannelsOauthConfig,
  type EmbeddedSignupLaunch,
  type WhatsAppNumberRow,
  type WhatsAppUnprofiledRow,
  type WhatsAppCandidate,
  type WhatsAppInspection,
  type WhatsAppHealthCheck,
} from "@/lib/api";
import {
  interpretSignupMessage,
  isMetaOrigin,
  mergeSignupAssets,
  outcomeMessageKey,
  readAuthCode,
  type SignupAssets,
} from "@/lib/whatsapp-signup-flow";
import { useFacebookSdk } from "@/lib/facebook-sdk";
import ConfirmModal from "@/components/ConfirmModal";
import clsx from "clsx";

// The Embedded Signup configuration id and extras are NOT read from the
// browser environment any more. They are fetched from /api/channels/config so
// that the server is the single source of truth for both this FB.login call
// and the server-side OAuth redirect. Two independently-assembled payloads is
// exactly how the frontend ended up launching v3 against a v4 configuration.
const META_APP_ID = process.env.NEXT_PUBLIC_META_APP_ID || "";

// ─── Small presentational pieces ─────────────────────────────

/**
 * State chip.
 *
 * "Needs you" rather than "error" for ACTION_REQUIRED: waiting on a PIN is not
 * a fault, and calling it one sends people looking for a bug that is not there.
 */
function StateChip({ state }: { state: string }) {
  const { t } = useI18n();
  const map: Record<string, { cls: string; key: string }> = {
    CONNECTED: { cls: "bg-emerald-50 text-emerald-700 ring-emerald-200", key: "connected" },
    DEGRADED: { cls: "bg-amber-50 text-amber-700 ring-amber-200", key: "degraded" },
    ACTION_REQUIRED: { cls: "bg-blue-50 text-blue-700 ring-blue-200", key: "actionRequired" },
    ONBOARDING: { cls: "bg-gray-100 text-gray-600 ring-gray-200", key: "onboarding" },
    DISCONNECTED: { cls: "bg-gray-100 text-gray-500 ring-gray-200", key: "disconnected" },
    FAILED: { cls: "bg-red-50 text-red-700 ring-red-200", key: "failed" },
    DISCOVERED: { cls: "bg-gray-100 text-gray-500 ring-gray-200", key: "discovered" },
  };
  const c = map[state] || map.DISCOVERED;
  return (
    <span
      className={clsx(
        "text-[10px] px-2 py-0.5 rounded-full font-medium ring-1 whitespace-nowrap",
        c.cls,
      )}
    >
      {t(`whatsappNumbers.state.${c.key}`)}
    </span>
  );
}

function CheckRow({ check }: { check: WhatsAppHealthCheck }) {
  const { t } = useI18n();
  const tone =
    check.status === "PASS"
      ? { icon: "✓", cls: "text-emerald-600" }
      : check.status === "FAIL"
        ? { icon: "✕", cls: "text-red-600" }
        : check.status === "WARN"
          ? { icon: "!", cls: "text-amber-600" }
          : { icon: "?", cls: "text-gray-400" };

  return (
    <li className="flex gap-2.5 items-start py-1.5">
      <span className={clsx("font-bold w-4 shrink-0 text-center leading-5", tone.cls)}>
        {tone.icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm text-gray-800 leading-5">{check.label}</div>
        {check.detail && <div className="text-xs text-gray-500 mt-0.5">{check.detail}</div>}
        {/*
          Meta's own remediation text, shown verbatim. It is written by the team
          that blocked the account and is invariably more actionable than
          anything we could infer from the error code.
        */}
        {check.metaSolution && (
          <div className="text-xs text-gray-600 mt-1.5 bg-gray-50 border border-gray-200 rounded-md px-2.5 py-1.5">
            <span className="font-medium">{t("whatsappNumbers.checks.metaSays")} </span>
            {check.metaSolution}
          </div>
        )}
      </div>
    </li>
  );
}

// ─── One number ──────────────────────────────────────────────

function NumberCard({
  row,
  onChanged,
  canManage,
}: {
  row: WhatsAppNumberRow;
  onChanged: () => void;
  canManage: boolean;
}) {
  const { token } = useAuth();
  const { t } = useI18n();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [pin, setPin] = useState("");

  const health = row.health;
  const label = row.phoneNumber || row.name || t("whatsappNumbers.card.fallbackName");

  async function run(key: string, fn: () => Promise<string>) {
    if (!token) return;
    setBusy(key);
    setMessage(null);
    try {
      setMessage(await fn());
      onChanged();
    } catch (err: any) {
      setMessage(err?.message || t("whatsappNumbers.card.genericError"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="border border-gray-200 rounded-xl bg-white shadow-sm overflow-hidden">
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium text-gray-900 truncate">{label}</span>
              <StateChip state={row.state} />
              {/*
                Coexistence changes what the customer can expect (throughput,
                no group chats), so it is labelled on the card rather than
                buried in a help article.
              */}
              {row.usesBusinessApp && (
                <span className="text-[10px] px-2 py-0.5 rounded-full font-medium ring-1 bg-violet-50 text-violet-700 ring-violet-200 whitespace-nowrap">
                  {t("whatsappNumbers.badge.alsoOnPhone")}
                </span>
              )}
            </div>
            {row.name && row.phoneNumber && (
              <div className="text-xs text-gray-500 mt-1">{row.name}</div>
            )}
          </div>

          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-xs text-gray-500 hover:text-gray-900 underline shrink-0"
          >
            {expanded ? t("whatsappNumbers.card.hideDetails") : t("whatsappNumbers.card.details")}
          </button>
        </div>

        {/* Waiting on the customer. Shown inline so the next action is obvious. */}
        {row.state === "ACTION_REQUIRED" && row.pendingAction === "TWO_STEP_PIN" && canManage && (
          <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50 p-3">
            <div className="text-sm text-blue-900 font-medium">
              {t("whatsappNumbers.pending.pinTitle")}
            </div>
            <p className="text-xs text-blue-800 mt-1 leading-relaxed">
              {t("whatsappNumbers.pending.pinBody")}
            </p>
            <div className="flex gap-2 mt-2.5">
              <input
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="••••••"
                dir="ltr"
                className="border border-blue-300 rounded-md px-2.5 py-1.5 text-sm w-28 tracking-[0.3em] text-center"
              />
              <button
                disabled={pin.length !== 6 || busy != null}
                onClick={() =>
                  run("resume", async () => {
                    const res = await resumeWhatsAppNumber(token!, row.id, { twoStepPin: pin });
                    setPin("");
                    return res.data.message || t("whatsappNumbers.pending.pinThanks");
                  })
                }
                className="text-sm px-3.5 py-1.5 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 transition"
              >
                {busy === "resume"
                  ? t("whatsappNumbers.pending.pinChecking")
                  : t("whatsappNumbers.pending.pinContinue")}
              </button>
            </div>
          </div>
        )}

        {row.state === "ACTION_REQUIRED" && row.pendingAction === "BUSINESS_APP_CONFIRMATION" && (
          <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50 p-3">
            <div className="text-sm text-blue-900 font-medium">
              {t("whatsappNumbers.pending.confirmTitle")}
            </div>
            {/*
              Implementation-neutral by design. Meta has changed this step's
              mechanics before (code by message, in-app confirmation), and
              promising a specific artefact sends people hunting for something
              that may not be on their screen.
            */}
            <p className="text-xs text-blue-800 mt-1 leading-relaxed">
              {t("whatsappNumbers.pending.confirmBody")}
            </p>
          </div>
        )}

        <ul className="mt-3 divide-y divide-gray-100">
          {health.checks.map((c, i) => (
            <CheckRow key={`${c.id}-${i}`} check={c} />
          ))}
        </ul>

        {message && (
          <div className="mt-3 text-xs rounded-md bg-gray-50 border border-gray-200 px-2.5 py-2 text-gray-700">
            {message}
          </div>
        )}

        {canManage && (
          <div className="mt-3.5 flex flex-wrap gap-2">
            {/*
              Repair buttons appear only for repairs that can genuinely be run.
              Offering a button that cannot work and watching it fail is worse
              than saying plainly that this one is the customer's to resolve.
            */}
            {health.availableRepairs.includes("RESUBSCRIBE_WEBHOOKS") && (
              <button
                disabled={busy != null}
                onClick={() =>
                  run("repair", async () => {
                    const res = await repairWhatsAppNumber(token!, row.id, "RESUBSCRIBE_WEBHOOKS");
                    return res.data.message;
                  })
                }
                className="text-xs px-3 py-1.5 rounded-md border border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 disabled:opacity-40 transition"
              >
                {busy === "repair"
                  ? t("whatsappNumbers.card.fixing")
                  : t("whatsappNumbers.card.fixDelivery")}
              </button>
            )}
            <button
              disabled={busy != null}
              onClick={() =>
                run("refresh", async () => {
                  await refreshWhatsAppNumber(token!, row.id);
                  return t("whatsappNumbers.card.refreshed");
                })
              }
              className="text-xs px-3 py-1.5 rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-40 transition"
            >
              {busy === "refresh"
                ? t("whatsappNumbers.card.checking")
                : t("whatsappNumbers.card.checkAgain")}
            </button>
            <button
              disabled={busy != null}
              onClick={() => setConfirmRemove(true)}
              className="text-xs px-3 py-1.5 rounded-md border border-red-200 text-red-700 hover:bg-red-50 disabled:opacity-40 transition ms-auto"
            >
              {t("whatsappNumbers.card.remove")}
            </button>
          </div>
        )}
      </div>

      {expanded && (
        <div className="border-t border-gray-100 bg-gray-50 px-4 py-3">
          <div className="text-xs text-gray-500 mb-1.5">
            {t("whatsappNumbers.card.technical")}
          </div>
          <pre
            dir="ltr"
            className="text-[10px] bg-gray-900 text-gray-100 rounded-md p-2.5 overflow-x-auto"
          >
            {JSON.stringify(
              {
                state: row.state,
                connectedVia: row.onboardingFlow,
                quality: row.qualityRating,
                throughput: row.throughputLevel,
                lastChecked: health.lastCheckedAt,
                whatsappHealth: health.healthSnapshot,
              },
              null,
              2,
            )}
          </pre>
        </div>
      )}

      <ConfirmModal
        isOpen={confirmRemove}
        title={t("whatsappNumbers.card.removeTitle")}
        // Says the quiet part out loud. A customer who is not certain their
        // other numbers are safe will simply never remove anything.
        message={t("whatsappNumbers.card.removeBody", { number: label })}
        confirmText={t("whatsappNumbers.card.remove")}
        danger
        onCancel={() => setConfirmRemove(false)}
        onConfirm={async () => {
          setConfirmRemove(false);
          await run("remove", async () => {
            const res = await disconnectWhatsAppNumber(token!, row.id);
            return res.data.message;
          });
        }}
      />
    </div>
  );
}

// ─── Add a number ────────────────────────────────────────────

/**
 * Connect flow: choose a path, authorize with Meta, then pick ONE number.
 *
 * The path choice is unavoidable. Meta selects the WhatsApp Business app flow
 * through `extras.featureType`, which must be set before authorization, while
 * the field that reveals which flow was right (`is_on_biz_app`) is only
 * readable after it. So the customer picks, and a wrong pick is recoverable in
 * one click rather than being a dead end.
 */
function AddNumberPanel({ onDone }: { onDone: () => void }) {
  const { token } = useAuth();
  const { t } = useI18n();
  const [stage, setStage] = useState<"idle" | "authorizing" | "choosing" | "connecting">("idle");
  const [error, setError] = useState<string | null>(null);
  const [inspection, setInspection] = useState<WhatsAppInspection | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  /**
   * Asset ids from the popup. A ref, NOT state, and that is load-bearing: the
   * message arrives AFTER `startSignup` has run, so a state value would be
   * captured empty by the callback closure and `business_id` would be lost on
   * every single connection.
   */
  const assetsRef = useRef<SignupAssets>({});

  /**
   * Launch parameters, fetched from the server rather than assembled here.
   * Until they arrive the button stays disabled: launching with a guessed
   * config id is what produced the wrong Embedded Signup experience.
   */
  const [launch, setLaunch] = useState<EmbeddedSignupLaunch | null>(null);

  const sdkStatus = useFacebookSdk(META_APP_ID);
  const launchBlocked = !launch?.configured || sdkStatus !== "ready";
  const busy = stage === "authorizing" || stage === "connecting";

  useEffect(() => {
    if (!token) return;
    getChannelsOauthConfig(token)
      .then((r) => setLaunch(r.data?.embeddedSignup ?? null))
      .catch(() => setLaunch(null));
  }, [token]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!isMetaOrigin(event.origin)) return;
      const msg = interpretSignupMessage(event.data);
      if (msg.kind === "cancel") {
        setStage("idle");
        setError(t("whatsappNumbers.add.cancelled"));
        return;
      }
      if (msg.kind === "assets") {
        assetsRef.current = mergeSignupAssets(assetsRef.current, msg.assets);
      }
      // Verification trail for dev runs, matching `[wa-verify]` on the server
      // so a full flow can be reconstructed from both sides. The payload holds
      // asset IDs, never a token.
      console.info("[wa-verify] callback", msg.kind, event.data);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [t]);

  function startSignup() {
    const FB = (window as any).FB;
    if (!FB) {
      // Should be unreachable: the buttons are disabled unless the SDK is
      // ready. Kept as a guard.
      setError(t("whatsappNumbers.add.sdkFailed"));
      return;
    }
    setError(null);
    setNote(null);
    setInspection(null);
    setStage("authorizing");
    assetsRef.current = {};

    // The callback MUST be a plain function. The SDK type-checks it and
    // rejects an async arrow outright ("Expression is of type asyncfunction,
    // not function"), throwing before the popup ever opens.
    const onLogin = (response: unknown) => {
      const code = readAuthCode(response);
      if (!code) {
        // Closed or declined. Not worth an error message.
        setStage("idle");
        return;
      }
      // Brief delay so the popup's message can land before we read the ref; it
      // is posted independently of this callback.
      window.setTimeout(() => void runInspection(code), 600);
    };

    try {
      // Passed through verbatim from the server. Nothing is assembled or
      // defaulted here, so this call and the server-side OAuth redirect are
      // guaranteed to describe the same Embedded Signup experience.
      FB.login(onLogin, {
        config_id: launch!.configId,
        response_type: launch!.responseType,
        override_default_response_type: launch!.overrideDefaultResponseType,
        extras: launch!.extras,
      });
    } catch (err) {
      // A throw here would otherwise leave the panel stuck on "Opening
      // WhatsApp..." forever.
      console.error("[wa-connect] FB.login failed:", err);
      setStage("idle");
      setError(t("whatsappNumbers.add.sdkFailed"));
    }
  }

  /** Exchange + inspect server-side. Separate so the SDK callback stays sync. */
  async function runInspection(code: string) {
    try {
      // The server exchanges the code and keeps the token. Nothing is written
      // at Meta or in our database yet, so the customer sees their options
      // before anything is committed.
      const res = await inspectWhatsApp(token!, { code, ...assetsRef.current });
      setInspection(res.data);
      setStage("choosing");
    } catch (err: any) {
      setError(err?.message || t("whatsappNumbers.add.inspectFailed"));
      setStage("idle");
    }
  }

  async function connect(candidate: WhatsAppCandidate) {
    if (!inspection) return;
    setChosen(candidate.phoneNumberId);
    setStage("connecting");
    setError(null);
    try {
      const res = await connectWhatsAppNumber(token!, {
        sessionId: inspection.sessionId,
        phoneNumberId: candidate.phoneNumberId,
      });
      setNote(res.data.message);
      onDone();
      // Stay on the picker: the session is still valid, so a customer with
      // three numbers adds all three without re-authorising for each.
      setStage("choosing");
    } catch (err: any) {
      setError(err?.message || t("whatsappNumbers.add.connectFailed"));
      setStage("choosing");
    } finally {
      setChosen(null);
    }
  }

  // ── Entry: choose a path ──
  if (stage === "idle" || stage === "authorizing") {
    return (
      <div className="border border-dashed border-gray-300 rounded-xl p-5 bg-gradient-to-b from-gray-50 to-white">
        <div className="text-center">
          <div className="text-sm font-semibold text-gray-900">
            {t("whatsappNumbers.add.title")}
          </div>
          <p className="text-xs text-gray-600 mt-1 max-w-md mx-auto leading-relaxed">
            {t("whatsappNumbers.add.subtitle")}
          </p>
        </div>

        {/*
          ONE button. Embedded Signup v4 is a single unified flow that presents
          the supported onboarding choices - including connecting a number
          already in the WhatsApp Business app - inside Meta's own UI. The
          earlier two-button entry pre-selected a flow through
          `extras.featureType`, which on a v4 configuration is at best
          redundant and at worst pins a different experience.
        */}
        <div className="mt-4 flex justify-center">
          <button
            onClick={startSignup}
            disabled={busy || launchBlocked}
            className="rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-40 transition"
          >
            {t("whatsappNumbers.add.connect")}
          </button>
        </div>

        <div className="mt-3 text-center space-y-1">
          {stage === "authorizing" && (
            <p className="text-xs text-gray-600">{t("whatsappNumbers.add.opening")}</p>
          )}
          {sdkStatus === "loading" && (
            <p className="text-xs text-gray-500">{t("whatsappNumbers.add.preparing")}</p>
          )}
          {launch && !launch.configured && (
            <p className="text-xs text-amber-700">{t("whatsappNumbers.add.notConfigured")}</p>
          )}
          {/*
            Distinct from "not configured": set up correctly, but the sign-in
            script did not load. Deliberately does NOT blame the customer's ad
            blocker - we cannot tell from the browser whether the cause is an
            extension, a network filter, or our own CSP, and on this very stack
            it was ours.
          */}
          {launch?.configured && sdkStatus === "unavailable" && (
            <p className="text-xs text-amber-700 leading-relaxed">
              {t("whatsappNumbers.add.sdkUnavailable")}
            </p>
          )}
          {error && <p className="text-xs text-red-600">{error}</p>}
          {note && <p className="text-xs text-emerald-700">{note}</p>}
        </div>
      </div>
    );
  }

  // ── Picker ──
  const outcome = inspection?.outcome;
  const nothingToConnect = (outcome?.eligibleCount ?? 0) === 0;

  return (
    <div className="border border-gray-200 rounded-xl p-5 bg-white shadow-sm">
      <div className="text-sm font-semibold text-gray-900">
        {t("whatsappNumbers.choose.title")}
      </div>

      {/*
        Says what could not be checked, rather than presenting a narrower view
        as if it were complete. A confidently wrong flow selection is worse
        than an honest gap.
      */}
      {inspection?.degraded && (
        <div className="mt-2.5 text-xs rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-amber-800">
          {t("whatsappNumbers.choose.degraded")}
        </div>
      )}

      <div className="mt-3 space-y-2.5">
        {inspection?.candidates.map((c) => {
          const blocked = c.scenario === "BLOCKED";
          const isConnecting = stage === "connecting" && chosen === c.phoneNumberId;
          return (
            <div
              key={c.phoneNumberId}
              className={clsx(
                "border rounded-lg p-3",
                blocked ? "border-gray-200 bg-gray-50" : "border-gray-200 bg-white",
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium text-sm text-gray-900">
                    {c.phoneNumber || c.name || t("whatsappNumbers.card.fallbackName")}
                  </div>
                  <p className="text-xs text-gray-600 mt-1 leading-relaxed">{c.message}</p>
                  {c.blockers.map((b) => (
                    <p key={b.code} className="text-xs text-red-600 mt-1">
                      {b.message}
                    </p>
                  ))}
                </div>

                <button
                  disabled={blocked || c.alreadyConnectedHere || stage === "connecting"}
                  onClick={() => connect(c)}
                  className="text-xs px-3 py-1.5 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 shrink-0 transition"
                >
                  {c.alreadyConnectedHere
                    ? t("whatsappNumbers.choose.alreadyAdded")
                    : isConnecting
                      ? t("whatsappNumbers.choose.connecting")
                      : t("whatsappNumbers.choose.connectThis")}
                </button>
              </div>

              {/* Phase 6: the Business app choice, stated honestly. */}
              {c.businessAppOptions && (
                <div className="mt-3 border-t border-gray-100 pt-3 space-y-2">
                  <div className="rounded-md border border-emerald-200 bg-emerald-50 p-2.5">
                    <div className="text-xs font-medium text-emerald-900">
                      {c.businessAppOptions.keepUsingBusinessApp.title}{" "}
                      <span className="font-normal">
                        ({t("whatsappNumbers.businessApp.recommended")})
                      </span>
                    </div>
                    <p className="text-[11px] text-emerald-800 mt-1 leading-relaxed">
                      {c.businessAppOptions.keepUsingBusinessApp.description}
                    </p>
                    <p className="text-[11px] text-emerald-800 mt-1">
                      {c.businessAppOptions.keepUsingBusinessApp.throughputNote}
                    </p>
                    <ul className="text-[11px] text-emerald-800 mt-1 list-disc ps-4 space-y-0.5">
                      {c.businessAppOptions.keepUsingBusinessApp.limitations.map((l) => (
                        <li key={l}>{l}</li>
                      ))}
                    </ul>
                  </div>
                  {/*
                    Shown as unavailable rather than hidden. A customer who has
                    heard that platforms can "take over" a number needs to know
                    why we decline, or they will assume we simply cannot.
                  */}
                  <div className="rounded-md border border-gray-200 bg-gray-50 p-2.5">
                    <div className="text-xs font-medium text-gray-700">
                      {c.businessAppOptions.fullMigration.title}{" "}
                      <span className="font-normal">
                        ({t("whatsappNumbers.businessApp.notAvailable")})
                      </span>
                    </div>
                    <p className="text-[11px] text-gray-600 mt-1 leading-relaxed">
                      {c.businessAppOptions.fullMigration.reason}
                    </p>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/*
        The recoverable dead end. Never a bare empty list: the server computed
        WHY there is nothing to connect, and whether the other flow would
        plausibly do better. `switchTo` is null when it would not, so we explain
        without offering a pointless second round trip.
      */}
      {nothingToConnect && outcome && (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3.5">
          <p className="text-xs text-amber-900 leading-relaxed">
            {t(outcomeMessageKey(outcome.reason))}
          </p>
          {/*
            No cross-path relaunch button. With v4 there is one flow, so
            "try the other way" is not an option we can offer honestly. The
            reason above still explains what happened.
          */}
        </div>
      )}

      {error && <p className="text-xs text-red-600 mt-3">{error}</p>}
      {note && <p className="text-xs text-emerald-700 mt-3">{note}</p>}

      <button
        onClick={() => {
          setStage("idle");
          setInspection(null);
          setError(null);
        }}
        className="mt-3 text-xs text-gray-600 underline"
      >
        {t("whatsappNumbers.choose.back")}
      </button>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────

export function WhatsAppNumbersContent() {
  const { token } = useAuth();
  const { can } = usePermissions();
  const { t } = useI18n();
  const canManage = can("channels:manage:update");

  const [rows, setRows] = useState<WhatsAppNumberRow[]>([]);
  const [unprofiled, setUnprofiled] = useState<WhatsAppUnprofiledRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const res = await listWhatsAppNumbers(token);
      setRows(res.data);
      setUnprofiled(res.unprofiled || []);
      setError(null);
    } catch (err: any) {
      setError(err?.message || t("whatsappNumbers.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [token, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const working = rows.filter((r) => r.state === "CONNECTED").length;
  const needsAttention = rows.filter(
    (r) => r.state === "DEGRADED" || r.state === "ACTION_REQUIRED" || r.state === "FAILED",
  ).length;

  return (
    <div className="max-w-3xl mx-auto p-4 sm:p-6">
      {/*
        Back to /settings/channels, matching the twilio and shopify-live-chat
        sub-pages. The arrow flips under RTL so Hebrew gets an arrow that
        points the way the reader actually came from.
      */}
      <Link
        href="/settings/channels"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-gray-700"
      >
        <svg
          className="h-4 w-4 rtl:rotate-180"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
        </svg>
        {t("whatsappNumbers.backToChannels")}
      </Link>

      <div className="mt-3">
        <h1 className="text-2xl font-bold text-gray-900">{t("whatsappNumbers.title")}</h1>
        <p className="text-sm text-gray-500 mt-0.5">{t("whatsappNumbers.subtitle")}</p>
      </div>

      {rows.length > 0 && (
        <div className="mt-4 flex items-center gap-2 text-xs text-gray-600">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            {t("whatsappNumbers.summaryWorking", { count: String(working) })}
          </span>
          {needsAttention > 0 && (
            <span className="inline-flex items-center gap-1.5 text-amber-700">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
              {t("whatsappNumbers.summaryAttention", { count: String(needsAttention) })}
            </span>
          )}
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="mt-4 space-y-3">
        {loading && <div className="text-sm text-gray-500">{t("whatsappNumbers.loading")}</div>}

        {!loading &&
          rows.map((row) => (
            <NumberCard key={row.id} row={row} onChanged={load} canManage={canManage} />
          ))}

        {/*
          Numbers connected before per-number health existed. Surfaced rather
          than hidden: a number the customer sees in their inbox but not on
          this page reads as a bug in the page.
        */}
        {unprofiled.map((u) => (
          <div key={u.channelAccountId} className="border border-gray-200 rounded-xl p-4 bg-gray-50">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium text-gray-900">{u.name}</span>
              <span className="text-[10px] px-2 py-0.5 rounded-full font-medium ring-1 bg-gray-100 text-gray-500 ring-gray-200">
                {t("whatsappNumbers.badge.legacy")}
              </span>
            </div>
            <p className="text-xs text-gray-600 mt-1">{t("whatsappNumbers.legacy.note")}</p>
          </div>
        ))}

        {!loading && canManage && <AddNumberPanel onDone={load} />}

        {!loading && rows.length === 0 && unprofiled.length === 0 && !canManage && (
          <p className="text-sm text-gray-600">{t("whatsappNumbers.noneYet")}</p>
        )}
      </div>
    </div>
  );
}
