"use client";

/**
 * Workspace-wide AI-credit alerts for admins:
 *   • ≥80% of the credit budget consumed → amber warning (dismissable per session)
 *   • balance at zero → red "AI paused" (persistent - this is a real outage)
 *
 * Reads the same wallet snapshot the enforcement gate uses (billing
 * /credits/balance). Renders nothing when there is no budget in play (tenants
 * without a subscription/wallet) or when billing is unreachable - the banner
 * must never be noise.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { getBalance, type Balance } from "@/lib/api-billing";

const POLL_MS = 60_000;
const DISMISS_KEY = "creditAlert.dismissed80";

export function CreditAlertBanner() {
  const { token, user } = useAuth();
  const { locale } = useI18n();
  const he = locale === "he";
  const [balance, setBalance] = useState<Balance | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    try { setDismissed(sessionStorage.getItem(DISMISS_KEY) === "1"); } catch { /* */ }
  }, []);

  useEffect(() => {
    if (!token || user?.role !== "ADMIN") return;
    let alive = true;
    const tick = () =>
      getBalance(token)
        .then((b) => { if (alive) setBalance(b); })
        .catch(() => { if (alive) setBalance(null); });
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [token, user?.role]);

  if (!balance || user?.role !== "ADMIN") return null;
  const allowance = Number(balance.includedAllowance || 0);
  const total = Number(balance.total || 0);
  if (allowance <= 0) return null; // no budget in play - nothing honest to alert on

  const consumedPct = Math.min(100, Math.max(0, Math.round((1 - total / allowance) * 100)));
  const exhausted = total <= 0;
  if (!exhausted && (consumedPct < 80 || dismissed)) return null;

  // Floating pill overlay - never participates in the page layout, so
  // full-height screens are unaffected.
  return (
    <div className="absolute top-2 inset-x-0 z-30 flex justify-center pointer-events-none px-4" dir={he ? "rtl" : "ltr"}>
      {exhausted ? (
        <div className="pointer-events-auto flex items-center gap-3 px-4 py-2 rounded-full bg-red-600 text-white text-sm shadow-lg" role="alert">
          <span className="font-semibold">{he ? "קרדיטי ה-AI נגמרו - עובדי ה-AI מושהים." : "AI credits exhausted - your AI employees are paused."}</span>
          <Link href="/settings/billing" className="underline font-semibold hover:opacity-80 shrink-0">
            {he ? "הוסיפו קרדיטים ←" : "Add credits →"}
          </Link>
        </div>
      ) : (
        <div className="pointer-events-auto flex items-center gap-3 px-4 py-1.5 rounded-full bg-amber-50 border border-amber-200 text-amber-800 text-sm shadow-md" role="status">
          <span>
            <strong>{consumedPct}%</strong>{he ? " מתקציב קרדיטי ה-AI נוצל." : " of your AI credit budget used."}
          </span>
          <Link href="/settings/billing" className="underline font-medium hover:opacity-80 shrink-0">
            {he ? "לצפייה ורכישה" : "View & top up"}
          </Link>
          <button
            type="button"
            onClick={() => { setDismissed(true); try { sessionStorage.setItem(DISMISS_KEY, "1"); } catch { /* */ } }}
            className="text-amber-500 hover:text-amber-700 leading-none px-1"
            aria-label={he ? "סגירה" : "Dismiss"}
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
