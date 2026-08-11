"use client";

/**
 * Hierarchical MFA enforcement - the client half.
 *
 * When a user's role + their tenant's policy require MFA and they have not
 * enrolled (an authenticator AND recovery codes), this renders a BLOCKING
 * full-screen gate immediately after sign-in. The user cannot reach GOTCHA
 * until enrolment completes; their only other move is to sign out.
 *
 * The steps embed Authentik's own setup flows in an iframe (same-site, framed
 * by the gateway CSP) so enrolment happens inside GOTCHA. Step 1 chains into
 * step 2 via a relative `?next` (Authentik rejects absolute/cross-host next
 * URLs with a "Request has been denied" card, so our app pages can never be
 * the redirect target); a background poll re-checks the gate to advance the
 * stepper and release when both factors exist.
 *
 * Mounted once under AuthProvider so it covers every authenticated area,
 * including the SYSTEM_ADMIN /system console (for whom MFA is always mandatory).
 */

import { useAppPathname } from "@/lib/pathname";
import { useCallback, useEffect, useRef, useState } from "react";

import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { getMfaGate, type MfaGate } from "@/lib/api";
import { authentikFlowUrl, AUTHENTIK_FLOWS, FLOW_DONE_MESSAGE } from "@/lib/oidc";

// Paths where the gate must never run: the login/callback dance and the
// signalling page itself (framing it would loop), plus the public join page.
const EXEMPT_PREFIXES = ["/login", "/auth", "/join", "/logout"];

export function MfaEnrollmentGate() {
  const { user, token, logout } = useAuth();
  const { locale } = useI18n();
  const pathname = useAppPathname();
  const he = locale === "he";
  const L = (en: string, heb: string) => (he ? heb : en);

  const [gate, setGate] = useState<MfaGate | null>(null);
  const [verifying, setVerifying] = useState(false);
  const flowRef = useRef<HTMLIFrameElement | null>(null);
  const loadCountRef = useRef(0);
  const [flowNonce, setFlowNonce] = useState(0); // bump to reload the iframe

  const exempt = EXEMPT_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
  const active = !!user && !!token && !exempt;

  // SILENT by design: this runs on a 3s interval while the gate is open, and
  // any loading state tied to it would flash a mask over the embedded flow on
  // every tick (users read that as "the QR code keeps refreshing"). Callers
  // that want visible feedback (the footer button, the frame-load handler)
  // drive `verifying` themselves around the await.
  const check = useCallback(async () => {
    if (!token) return;
    try {
      const g = await getMfaGate(token);
      setGate(g);
    } catch {
      // On a transient error, PRESERVE the last-known state rather than clearing
      // it: if the gate was already blocking (mustEnroll), a network blip must
      // not silently release it (that was a fail-open). If we never had a gate,
      // we stay out of the way - the server is the real authority and the poll
      // will re-resolve on the next tick.
    }
  }, [token]);

  // Check on activation + whenever the route changes into a guarded area.
  useEffect(() => { if (active) void check(); else setGate(null); }, [active, pathname, check]);

  // Re-check when the window regains focus (e.g. after enrolling in a tab).
  useEffect(() => {
    if (!active) return;
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [active, check]);

  // A flow finished inside the iframe -> give Authentik a beat to persist, then
  // re-check so we advance to the next step or release the gate.
  useEffect(() => {
    if (!active) return;
    function onMessage(e: MessageEvent) {
      if (e?.data?.type === FLOW_DONE_MESSAGE) {
        setTimeout(() => void check(), 600);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [active, check]);

  // Authentik's setup flows don't redirect to our `next` page, so the
  // flow-done message can't be relied on to advance the gate. Poll while the
  // gate is open so completing a step advances (authenticator -> recovery) or
  // releases within a few seconds - and so Authentik's own post-completion
  // screen never lingers inside the iframe.
  useEffect(() => {
    if (!active || !gate?.mustEnroll) return;
    const iv = setInterval(() => void check(), 3000);
    return () => clearInterval(iv);
  }, [active, gate?.mustEnroll, check]);

  // Reset the per-step iframe load counter whenever the step (authenticator vs
  // recovery) changes or we force a reload, so the next step's initial render
  // isn't mistaken for a completion navigation.
  useEffect(() => { loadCountRef.current = 0; }, [gate?.hasAuthenticator, flowNonce]);

  // The iframe navigated. First load = the step's initial render; any load after
  // that means the flow advanced or completed (and Authentik may have bounced to
  // its own app library). Mask + re-check immediately so we advance/release
  // instead of showing that page.
  const handleFrameLoad = () => {
    loadCountRef.current += 1;
    if (loadCountRef.current <= 1) return;
    setVerifying(true);
    setTimeout(async () => { await check(); setVerifying(false); }, 500);
  };

  if (!active || !gate?.mustEnroll) return null;

  // Which step are we on? Authenticator first, then recovery codes. Both are
  // required to be considered enrolled.
  const step: "authenticator" | "recovery" = !gate.hasAuthenticator ? "authenticator" : "recovery";
  const flowSlug = step === "authenticator" ? AUTHENTIK_FLOWS.totp : AUTHENTIK_FLOWS.recoveryCodes;
  // Chain step 1 straight into step 2 via a RELATIVE next (Authentik rejects
  // absolute URLs with a "denied" card): finishing the authenticator lands on
  // the recovery-codes flow inside the same iframe, and the poll re-syncs the
  // stepper. The final step gets no next - completion is masked and released
  // by the poll.
  const nextPath = step === "authenticator" ? `/if/flow/${AUTHENTIK_FLOWS.recoveryCodes}/` : undefined;
  const flowUrl = `${authentikFlowUrl(flowSlug, nextPath)}${nextPath ? "&" : "?"}_n=${flowNonce}`;

  const reasonCopy =
    gate.reason === "system_admin"
      ? L("Two-factor authentication is required for platform administrators.",
          "אימות דו-שלבי נדרש עבור מנהלי הפלטפורמה.")
      : gate.reason === "tenant_admins"
      ? L("Your workspace requires administrators to use two-factor authentication.",
          "סביבת העבודה שלך מחייבת מנהלים להשתמש באימות דו-שלבי.")
      : L("Your workspace requires two-factor authentication for all members.",
          "סביבת העבודה שלך מחייבת אימות דו-שלבי לכל החברים.");

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-gray-900/70 p-4 backdrop-blur-sm" dir={he ? "rtl" : "ltr"}>
      <div className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        {/* Header */}
        <div className="border-b border-gray-100 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-50 text-primary-600">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-gray-900">{L("Set up two-factor authentication", "הגדרת אימות דו-שלבי")}</h2>
              <p className="mt-0.5 text-xs text-gray-500">{reasonCopy}</p>
            </div>
          </div>

          {/* Stepper */}
          <div className="mt-4 flex items-center gap-2">
            <StepPill n={1} label={L("Authenticator", "אפליקציית אימות")} state={gate.hasAuthenticator ? "done" : "current"} he={he} />
            <div className={`h-px flex-1 ${gate.hasAuthenticator ? "bg-green-300" : "bg-gray-200"}`} />
            <StepPill n={2} label={L("Recovery codes", "קודי שחזור")} state={gate.hasAuthenticator ? "current" : "todo"} he={he} />
          </div>
        </div>

        {/* Flow body */}
        <div className="relative min-h-[520px] flex-1 overflow-hidden">
          <iframe
            key={`${flowSlug}-${flowNonce}`}
            ref={flowRef}
            src={flowUrl}
            onLoad={handleFrameLoad}
            title={step === "authenticator" ? L("Authenticator setup", "הגדרת אפליקציית אימות") : L("Recovery codes", "קודי שחזור")}
            className="h-[540px] w-full border-0"
            allow="publickey-credentials-get *; publickey-credentials-create *; clipboard-write"
          />
          {/* Mask the iframe during explicit verification (frame navigated, or
              the user clicked "I've finished"). On completion of the FINAL step
              Authentik bounces to its root (no `next` there) - this overlay
              hides that while we verify and release, so the user never sees it.
              Background polls deliberately do NOT raise this mask. */}
          {verifying && (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-white">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-200 border-t-primary-500" />
              <span className="text-sm font-medium text-gray-500">{L("Finishing setup…", "מסיים הגדרה…")}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 border-t border-gray-100 px-6 py-3">
          <button
            onClick={() => logout()}
            className="text-xs font-medium text-gray-500 hover:text-gray-700"
          >
            {L("Sign out", "התנתקות")}
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setFlowNonce((n) => n + 1); }}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100"
            >
              {L("Restart step", "התחלה מחדש")}
            </button>
            <button
              onClick={() => {
                setVerifying(true);
                void check().finally(() => setVerifying(false));
              }}
              className="rounded-lg bg-primary-600 px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-primary-700"
            >
              {L("I've finished this step", "סיימתי שלב זה")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function StepPill({ n, label, state, he }: { n: number; label: string; state: "todo" | "current" | "done"; he: boolean }) {
  const dot =
    state === "done"
      ? "bg-green-500 text-white"
      : state === "current"
      ? "bg-primary-600 text-white"
      : "bg-gray-200 text-gray-500";
  const text = state === "todo" ? "text-gray-400" : "text-gray-700";
  return (
    <div className="flex items-center gap-1.5" dir={he ? "rtl" : "ltr"}>
      <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${dot}`}>
        {state === "done" ? "✓" : n}
      </span>
      <span className={`text-[11px] font-medium ${text}`}>{label}</span>
    </div>
  );
}
