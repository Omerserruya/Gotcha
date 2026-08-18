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

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import { usePermissions } from "@/context/PermissionsContext";
import { useI18n } from "@/context/I18nContext";
import { HistoricalImportPanel } from "@/components/channels/HistoricalImportPanel";
import { isHistoricalImportTerminal } from "@/lib/historical-import-client";
import {
  listHistoricalImports,
  type HistoricalImportView,
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
  type WhatsAppHealthReport,
  type WhatsAppBlocker,
  listWhatsAppExclusions,
  addWhatsAppExclusion,
  removeWhatsAppExclusion,
  type WhatsAppExclusion,
} from "@/lib/api";
import {
  interpretSignupMessage,
  isMetaOrigin,
  mergeSignupAssets,
  outcomeMessageKey,
  classifySignupAbort,
  describeSignupResponse,
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
function StateChip({ state, health }: { state: string; health?: WhatsAppHealthReport }) {
  const { t } = useI18n();

  // Connected and receiving, but Meta will not let it send: that is a
  // connected number with a warning, not a broken one. Labelling it "needs
  // attention" told a customer nothing was connected while their inbox filled
  // up, which is the opposite of what the screen should say.
  if (health?.receiving && health.sending === false) {
    // Green, not amber. The channel IS connected and IS delivering; the one
    // thing it cannot do has its own alert directly below. An amber chip on top
    // of that alert made a working channel read as a broken one.
    return (
      <span className="text-[10px] px-2 py-0.5 rounded-full font-medium ring-1 whitespace-nowrap bg-emerald-50 text-emerald-700 ring-emerald-200">
        {t("whatsappNumbers.state.connectedLimited")}
      </span>
    );
  }

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

/**
 * What is true about this number, in one sentence, before any diagnostics.
 *
 * The card used to open with a five-row list of ticks and crosses in Meta's
 * English. A customer read "Connected to WhatsApp ✓" and "WhatsApp is blocking
 * this number ✕" and could not tell whether the number worked. Receiving and
 * sending are separate facts and are now stated separately, because a number
 * that receives but cannot send is the single most common state here and it is
 * genuinely half-working.
 */
function StatusHeadline({
  health,
  t,
}: {
  health: WhatsAppHealthReport;
  t: (k: string) => string;
}) {
  const receiving = health.checks.find((c) => c.id === "WEBHOOKS")?.status === "PASS";
  const sending = health.checks.find((c) => c.id === "MESSAGING")?.status === "PASS";

  const key = health.ready
    ? "whatsappNumbers.headline.working"
    : receiving && !sending
      ? "whatsappNumbers.headline.receivingOnly"
      : !receiving && sending
        ? "whatsappNumbers.headline.sendingOnly"
        : "whatsappNumbers.headline.neither";

  return (
    <p
      className={
        "mt-2.5 text-sm leading-relaxed " +
        (health.ready ? "text-emerald-800" : "text-gray-800")
      }
    >
      {t(key)}
    </p>
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
        <div className="text-sm text-gray-800 leading-5">{healthText(check, t)}</div>
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
            {/*
              Meta's advice is always "go to business settings and do X", and
              the customer had no idea where that was. One link, on the rows
              that are genuinely theirs to fix in Meta rather than ours.
            */}
            <a
              href="https://business.facebook.com/settings"
              target="_blank"
              rel="noopener noreferrer"
              className="block mt-1 font-medium text-blue-700 hover:text-blue-800 underline"
            >
              {t("whatsappNumbers.meta.fixInMeta")}
            </a>
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
  historicalImport,
}: {
  row: WhatsAppNumberRow;
  onChanged: () => void;
  canManage: boolean;
  /**
   * The history import for this number, when there is one. Undefined for every
   * number that never had one, which is every number outside Coexistence.
   */
  historicalImport?: HistoricalImportView;
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

  // Two ways to land in "you have one step left": Meta asked for the two-step
  // PIN explicitly, or the number was never registered at all.
  const needsPin = row.state === "ACTION_REQUIRED" && row.pendingAction === "TWO_STEP_PIN";
  const needsFinish = needsPin || !!health.needsRegistration;

  // Registration has its own box above; showing it again in the list would read
  // as two separate problems.
  const problems = health.checks.filter((c) => c.status !== "PASS");
  const blocking = problems.filter((c) => c.blocking && !(needsFinish && c.id === "REGISTRATION"));
  const advisory = problems.filter((c) => !blocking.includes(c) && !(needsFinish && c.id === "REGISTRATION"));

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
              <StateChip state={row.state} health={health} />
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

        {/* The one thing to do next, in one sentence, before any diagnostics. */}
        <StatusHeadline health={health} t={t} />

        {/*
          The history import, BELOW the channel's own status and never mixed
          into it.

          The order is the message: whether this number works is answered
          first, by StateChip and StatusHeadline, and stays answered whatever
          the import is doing. An import that failed shows an amber panel here
          while the chip above still reads Connected, because it is.
        */}
        {historicalImport && <HistoricalImportPanel imp={historicalImport} />}

        {/*
          Waiting on the customer. Shown inline so the next action is obvious.

          Also shown when Meta reports the number as never registered (141000):
          that state arrives as DEGRADED with no pendingAction, so keying the box
          on pendingAction alone left the customer looking at "WhatsApp is
          blocking this number" with nothing on screen to press. `resume` runs
          the register step, with the two-step PIN if the number has one.
        */}
        {(needsFinish) && canManage && (
          <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50 p-3">
            <div className="text-sm text-blue-900 font-medium">
              {t(needsPin ? "whatsappNumbers.pending.pinTitle" : "whatsappNumbers.pending.registerTitle")}
            </div>
            <p className="text-xs text-blue-800 mt-1 leading-relaxed">
              {t(needsPin ? "whatsappNumbers.pending.pinBody" : "whatsappNumbers.pending.registerBody")}
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
                  : t(needsPin ? "whatsappNumbers.pending.pinContinue" : "whatsappNumbers.pending.registerContinue")}
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

        {/*
          Triaged, not dumped. Every signal Meta emits used to render at the
          same weight - an unregistered number sat in the same flat list as a
          SIP calling notice and an unapproved display name, all in Meta's
          English, and the customer could not tell which line was the reason
          nothing worked. Blocking problems lead; the rest is one quiet line
          and the full list stays under Details.
        */}
        {blocking.length > 0 && (
          <ul className="mt-3 divide-y divide-gray-100">
            {blocking.map((c, i) => (
              <CheckRow key={`${c.id}-${i}`} check={c} />
            ))}
          </ul>
        )}

        {advisory.length > 0 && (
          <button
            onClick={() => setExpanded(true)}
            className="mt-2.5 text-[11px] text-gray-500 hover:text-gray-700 underline text-start"
          >
            {t("whatsappNumbers.card.alsoWorthKnowing").replace("{count}", String(advisory.length))}
          </button>
        )}

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

/**
 * Can this candidate actually be added right now?
 *
 * The picker used to render EVERY number Meta returned, each with a Connect
 * button, and then disable the ones that could not be connected. A customer who
 * authorized one number was shown three, two of them greyed out with red text
 * about another workspace and about payment methods - none of it actionable
 * here. The eligible ones are now separated from the rest, and the rest lose
 * the button entirely, because a button that can never be pressed is noise.
 */
function isConnectable(c: WhatsAppCandidate): boolean {
  return c.scenario !== "BLOCKED" && !c.alreadyConnectedHere;
}

/**
 * A blocker, in the reader's language.
 *
 * The server composes these strings in English - `flow-selector.ts` and
 * `buildHealthReport` both build prose rather than returning keys - so a Hebrew
 * customer got Hebrew page furniture wrapped around English sentences about
 * SIP, payment methods and business verification. It read like a broken page.
 *
 * Translating by CODE rather than replacing the server strings keeps this a UI
 * change: the codes are already a closed set and already travel to the client.
 * An unrecognised code falls back to the server's own text, so a new blocker
 * added server-side degrades to English instead of disappearing.
 */
function blockerText(
  b: WhatsAppBlocker,
  t: (key: string, vars?: Record<string, string>) => string,
): string {
  const key = `whatsappNumbers.blocker.${b.code}`;
  const translated = t(key);
  return translated === key ? b.message : translated;
}

/**
 * The same idea for a health check row. `id` is the closed set; `label` and
 * `detail` are the server's English.
 */
function healthText(
  check: { id: string; label: string },
  t: (key: string, vars?: Record<string, string>) => string,
): string {
  const key = `whatsappNumbers.health.${check.id}`;
  const translated = t(key);
  return translated === key ? check.label : translated;
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
        // A dismissal deserves silence. A flow that RAN and still produced no
        // code does not: that used to land here too, so a customer who
        // completed the whole signup saw the panel quietly reset and had no
        // way to tell that anything had gone wrong.
        if (classifySignupAbort(response) === "NO_CODE") {
          console.error("[wa-connect] signup returned no code:", describeSignupResponse(response));
          setError(t("whatsappNumbers.add.noCode"));
        }
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

      // One eligible number: connect it. Do not ask.
      //
      // The customer has just spent a minute inside Meta's dialog choosing this
      // exact number and pressing Finish. Coming back to a list containing that
      // one number and a "Connect this" button reads as though the thing they
      // just did did not register - and several people simply stopped there,
      // believing they were done, which is how a number ends up authorized at
      // Meta and absent from GOTCHA.
      //
      // Only when there is genuinely nothing to choose between. Two or more
      // eligible numbers is a real decision and still gets the picker.
      const eligible = (res.data.candidates ?? []).filter(isConnectable);
      if (eligible.length === 1) {
        await connect(eligible[0]);
        return;
      }
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

      // Mark it connected in the list we are already showing.
      //
      // Staying on the picker is deliberate - a customer with three numbers
      // adds all three without re-authorising - but the list was never updated
      // afterwards, so the number just connected sat there with a live
      // "Connect this" button WHILE also appearing as a connected card above.
      // The same number, twice, in two contradictory states.
      const remaining = (inspection?.candidates ?? []).map((x) =>
        x.phoneNumberId === candidate.phoneNumberId ? { ...x, alreadyConnectedHere: true } : x,
      );
      setInspection((prev) => (prev ? { ...prev, candidates: remaining } : prev));

      // Nothing left to add: close, rather than leaving a picker whose every
      // row is disabled. That screen has no purpose and reads as a dead end.
      if (!remaining.some(isConnectable)) {
        setStage("idle");
        return;
      }
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
        {/*
          Only what can actually be added. Everything else moves below, without
          a button, because it is context rather than a choice.
        */}
        {(inspection?.candidates ?? []).filter(isConnectable).map((c) => {
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
                  {/*
                    Two at most. The screen showed five near-identical red
                    lines per number, which turned a list of things to fix into
                    a wall that reads as "this is broken" and gets skipped.
                  */}
                  {c.blockers.slice(0, 2).map((b) => (
                    <p key={b.code} className="text-xs text-amber-700 mt-1">
                      {blockerText(b, t)}
                    </p>
                  ))}
                  {c.blockers.length > 2 && (
                    <p className="text-[11px] text-gray-500 mt-1">
                      {t("whatsappNumbers.choose.moreBlockers", {
                        count: String(c.blockers.length - 2),
                      })}
                    </p>
                  )}
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
        Numbers Meta returned that cannot be added from here: already on this
        workspace, or held by another one. Listed so a customer who expected to
        see them is not left wondering, and collapsed because none of it is a
        decision they make on this screen.
      */}
      {(inspection?.candidates ?? []).some((c) => !isConnectable(c)) && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-gray-500 hover:text-gray-700">
            {t("whatsappNumbers.choose.otherNumbers", {
              count: String((inspection?.candidates ?? []).filter((c) => !isConnectable(c)).length),
            })}
          </summary>
          <div className="mt-2 space-y-2">
            {(inspection?.candidates ?? [])
              .filter((c) => !isConnectable(c))
              .map((c) => (
                <div key={c.phoneNumberId} className="rounded-lg border border-gray-200 bg-gray-50 p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-gray-800" dir="ltr">
                      {c.phoneNumber || c.name}
                    </span>
                    <span className="shrink-0 rounded-full bg-gray-200 px-2 py-0.5 text-[10px] text-gray-700">
                      {c.alreadyConnectedHere
                        ? t("whatsappNumbers.choose.alreadyAdded")
                        : t("whatsappNumbers.choose.unavailable")}
                    </span>
                  </div>
                  {/*
                    ONE reason, not the whole list. Five identical red lines on
                    a number the customer cannot act on here is what made this
                    screen unreadable.
                  */}
                  {c.blockers[0] && (
                    <p className="mt-1 text-[11px] text-gray-600">
                      {blockerText(c.blockers[0], t)}
                    </p>
                  )}
                </div>
              ))}
          </div>
        </details>
      )}

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


/**
 * Numbers that must never enter the shared inbox.
 *
 * Only rendered when a number actually runs in the Business app. On a pure
 * Cloud API number nothing arrives that the owner did not route here on
 * purpose, so the control would be an answer to a question nobody asked - and
 * a list of phone numbers on screen that has no effect is worse than absent.
 */
function ExclusionsPanel({ canManage }: { canManage: boolean }) {
  const { token } = useAuth();
  const { t } = useI18n();
  const [rules, setRules] = useState<WhatsAppExclusion[]>([]);
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      setRules((await listWhatsAppExclusions(token)).data);
    } catch { /* the panel is additive - a failed read must not break the page */ }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!token || !value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await addWhatsAppExclusion(token, value.trim(), note.trim() || undefined);
      setValue("");
      setNote("");
      await load();
    } catch (err: any) {
      setError(err?.message || t("whatsappNumbers.exclusions.addFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!token) return;
    try {
      await removeWhatsAppExclusion(token, id);
      await load();
    } catch { /* the row stays; the next load reconciles */ }
  }

  return (
    <div className="border border-gray-200 rounded-xl bg-white shadow-sm p-4">
      <div className="font-medium text-gray-900">{t("whatsappNumbers.exclusions.title")}</div>
      <p className="text-xs text-gray-600 mt-1 leading-relaxed">
        {t("whatsappNumbers.exclusions.body")}
      </p>

      {canManage && (
        <form onSubmit={add} className="mt-3 flex flex-col sm:flex-row gap-2">
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={t("whatsappNumbers.exclusions.numberPlaceholder")}
            inputMode="tel"
            className="flex-1 px-3 py-2 text-sm rounded-lg ring-1 ring-gray-200 outline-none focus:ring-2 focus:ring-primary-300"
          />
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t("whatsappNumbers.exclusions.notePlaceholder")}
            className="flex-1 px-3 py-2 text-sm rounded-lg ring-1 ring-gray-200 outline-none focus:ring-2 focus:ring-primary-300"
          />
          <button
            type="submit"
            disabled={busy || !value.trim()}
            className="px-3 py-2 text-sm rounded-lg bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-40 shrink-0"
          >
            {t("whatsappNumbers.exclusions.add")}
          </button>
        </form>
      )}

      {error && <div className="mt-2 text-xs text-red-600">{error}</div>}

      <div className="mt-3 divide-y divide-gray-100">
        {rules.length === 0 && (
          <p className="text-xs text-gray-400 py-2">{t("whatsappNumbers.exclusions.empty")}</p>
        )}
        {rules.map((r) => (
          <div key={r.id} className="flex items-center gap-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="text-sm text-gray-900 truncate" dir="ltr">{r.value}</div>
              {r.note && <div className="text-xs text-gray-500 truncate">{r.note}</div>}
            </div>
            {canManage && (
              <button
                onClick={() => remove(r.id)}
                className="text-xs text-gray-400 hover:text-red-600 shrink-0"
              >
                {t("common.remove")}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

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

  // ── History imports, polled separately from the numbers ──
  //
  // Its own request and its own cadence, because the two change at completely
  // different rates: a number's health is checked in minutes, while an import's
  // progress moves every few seconds during transfer. Folding the import into
  // the numbers response would mean either polling health far too often or
  // watching a progress bar that updates once a minute.
  //
  // Polling stops the moment every import reaches a terminal state, so a
  // settings page left open on a finished import is not a permanent request
  // every ten seconds.
  const [imports, setImports] = useState<HistoricalImportView[]>([]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const res = await listHistoricalImports(token);
        if (cancelled) return;
        setImports(res.imports);
        const active = res.imports.some((i) => !isHistoricalImportTerminal(i.status));
        if (active) timer = setTimeout(tick, 10000);
      } catch {
        // A failing status poll must never take the channels page down with it.
        // The numbers themselves are loaded separately and are what matters.
        if (!cancelled) timer = setTimeout(tick, 30000);
      }
    };
    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [token]);

  const importsByChannel = useMemo(() => {
    const map = new Map<string, HistoricalImportView>();
    // Newest first from the API, so the first row for a channel wins and a
    // previous import from before a re-onboarding does not shadow the current one.
    for (const imp of imports) {
      if (imp.channelAccountId && !map.has(imp.channelAccountId)) {
        map.set(imp.channelAccountId, imp);
      }
    }
    return map;
  }, [imports]);

  // Counted by what the number DOES, not by its lifecycle label.
  //
  // A number whose inbox is filling up is working, even while Meta blocks
  // outbound over a billing problem on the WhatsApp account. Counting by state
  // alone told a customer "0 working, 1 needs attention" about a number that
  // was delivering their customers' messages at that moment.
  const isReceiving = (r: WhatsAppNumberRow) =>
    r.health?.receiving ?? r.state === "CONNECTED";
  const working = rows.filter(isReceiving).length;
  const needsAttention = rows.filter((r) => !isReceiving(r)).length;
  // Working, but Meta will not let it send yet. Worth saying out loud rather
  // than hiding inside a green count.
  const limited = rows.filter((r) => isReceiving(r) && r.health?.sending === false).length;

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
          {/*
            Phrased as a SUBSET, not a second tally. "1 working" beside
            "1 cannot send yet" read as two numbers to the customer who had
            exactly one, and made a connected channel look half-broken.
          */}
          {limited > 0 && (
            <span className="inline-flex items-center gap-1.5 text-amber-700">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
              {t("whatsappNumbers.summaryLimited", { count: String(limited) })}
            </span>
          )}
          {needsAttention > 0 && (
            <span className="inline-flex items-center gap-1.5 text-red-700">
              <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
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
            <NumberCard
              key={row.id}
              row={row}
              onChanged={load}
              canManage={canManage}
              historicalImport={
                row.channelAccountId ? importsByChannel.get(row.channelAccountId) : undefined
              }
            />
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

        {/* Coexistence only - see the panel's own note for why. */}
        {!loading && rows.some((r) => r.usesBusinessApp) && (
          <ExclusionsPanel canManage={canManage} />
        )}

        {!loading && canManage && <AddNumberPanel onDone={load} />}

        {!loading && rows.length === 0 && unprofiled.length === 0 && !canManage && (
          <p className="text-sm text-gray-600">{t("whatsappNumbers.noneYet")}</p>
        )}
      </div>
    </div>
  );
}
