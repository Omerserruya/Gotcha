"use client";

/**
 * The Shopify billing state, said plainly on the Business Systems screen.
 *
 * WHY THIS IS A SEPARATE STRIP FROM THE CONNECTION CARD
 * ----------------------------------------------------
 * Installation and payment are two independent facts, and merging them into
 * one badge is how a merchant ends up reading "Not connected" when their store
 * is connected and simply unpaid - then disconnecting and reinstalling to fix a
 * problem that reinstalling cannot fix.
 *
 * So the integration card keeps saying whether the store is connected, and this
 * strip says whether it is paid for. When there is nothing to say - no store,
 * or Shopify billing switched off for this deployment - it renders nothing at
 * all rather than an empty box.
 *
 * NOTHING HERE DECIDES ANYTHING. Every state, and the plan URL, comes from the
 * server, which computed it from a verified read. The component cannot construct
 * a Shopify link, and deliberately has no code path that would let it: a URL
 * built here could point at a plan page for a store this workspace does not own.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import {
  getShopifyBillingState,
  startShopifyPlanSelection,
  type ShopifyBillingSnapshot,
} from "@/lib/api";

type Tone = "ok" | "warn" | "info";

const TONE_CLASS: Record<Tone, string> = {
  ok: "border-emerald-200 bg-emerald-50 text-emerald-900",
  warn: "border-amber-200 bg-amber-50 text-amber-900",
  info: "border-gray-200 bg-gray-50 text-gray-800",
};

interface Presentation {
  tone: Tone;
  title: string;
  body: string;
  /** Whether to offer the button that starts plan selection. */
  action: boolean;
}

/**
 * One state, one thing to say.
 *
 * Written for a merchant. Where the cause is ours rather than theirs - a
 * deployment with no plan configured - the copy says so instead of implying
 * they failed to do something.
 */
function present(s: ShopifyBillingSnapshot): Presentation | null {
  const shop = s.installation.shopDomain;

  switch (s.shopify.state) {
    case "UNRESOLVED":
      // Billing is off for this deployment. There is genuinely nothing to say.
      return null;

    case "NOT_REQUIRED_GRANDFATHERED":
      return {
        tone: "ok",
        title: "Included in your GOTCHA plan",
        body: "Your Shopify features are covered by your existing GOTCHA subscription. There is nothing to pay Shopify.",
        action: false,
      };

    case "ACTIVE":
      return {
        tone: "ok",
        title: "Shopify plan active",
        body: s.shopify.cancelAtPeriodEnd
          ? "Your plan is active but set to end at the close of the current period."
          : "Your Shopify subscription is active and your store features are on.",
        action: false,
      };

    case "TRIALING":
      return {
        tone: "ok",
        title: "Trial running",
        body: s.shopify.trialEndsAt
          ? `Your trial runs until ${new Date(s.shopify.trialEndsAt).toLocaleDateString()}.`
          : "Your trial is running and your store features are on.",
        action: false,
      };

    case "PLAN_SELECTION_REQUIRED":
      return {
        tone: "warn",
        title: s.shopify.declined ? "No plan approved" : "A Shopify plan is needed",
        body: s.shopify.declined
          ? `${shop ?? "Your store"} stays connected, but the paid Shopify features are off until a plan is approved on Shopify.`
          : `${shop ?? "Your store"} is connected. Choose a plan on Shopify to switch on the store features.`,
        // Only offered when the SERVER also gave us somewhere to go.
        action: !!s.planSelectionUrl,
      };

    case "APPROVAL_PENDING":
      return {
        tone: "warn",
        title: "Waiting for approval on Shopify",
        body: "Shopify still shows this subscription as awaiting approval. Finish approving it in your Shopify admin.",
        action: !!s.planSelectionUrl,
      };

    case "PAST_DUE":
      return {
        tone: "warn",
        title: "Payment overdue",
        body: "Shopify reports a failed charge. Settle it in your Shopify admin to restore the store features.",
        action: false,
      };

    case "FROZEN":
      return {
        tone: "warn",
        title: "Store frozen on Shopify",
        body: "Shopify has frozen this store, so the subscription is paused. Store features resume when Shopify unfreezes it.",
        action: false,
      };

    case "CANCELLED":
      return {
        tone: "warn",
        title: "Shopify subscription ended",
        body: "Your store stays connected and your data is untouched, but the paid Shopify features are off.",
        action: !!s.planSelectionUrl,
      };

    case "UNKNOWN_PLAN":
      // OUR configuration is wrong, not theirs. The merchant is paying
      // Shopify; we cannot yet say what that plan includes, and they keep
      // whatever was already verified while we sort it out. Saying "choose a
      // plan" here would ask somebody to pay twice.
      return {
        tone: "info",
        title: "We are finishing your plan setup",
        body: "Shopify has confirmed your subscription. We are completing the setup on our side and will email you when it is done - there is nothing for you to do, and you will not be charged again.",
        action: false,
      };

    case "ERROR":
    default:
      return {
        tone: "info",
        title: "We cannot read your Shopify billing state",
        body: "Nothing has changed on your account. Contact support and we will look into it.",
        action: false,
      };
  }
}

export default function ShopifyBillingBanner() {
  const { token } = useAuth();
  const router = useRouter();
  const [snapshot, setSnapshot] = useState<ShopifyBillingSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    getShopifyBillingState(token)
      .then((r) => setSnapshot(r.data))
      // Silent. This is a supplementary strip on a screen that must render
      // without it; a failed read here is not worth an error banner over the
      // whole page.
      .catch(() => setSnapshot(null));
  }, [token]);

  // No store connected: the connection card already says so, and repeating it
  // as a billing problem would send merchants looking in the wrong place.
  if (!snapshot || snapshot.installation.status === "NONE") return null;

  const p = present(snapshot);
  if (!p) return null;

  async function choosePlan() {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const { data } = await startShopifyPlanSelection(token);
      // A full navigation, not a new tab: the merchant comes back to
      // /integrations/shopify/billing/complete and the return has to land in
      // this same browser context.
      window.location.href = data.url;
    } catch (e: any) {
      setError(
        e?.code === "shopify_plan_selection_unavailable"
          ? "Plan selection is not available yet. Contact support and we will sort it out."
          : e?.code === "shopify_billing_not_required"
            ? "This workspace does not need a Shopify plan."
            : "Could not open the Shopify plan page. Please try again.",
      );
      setBusy(false);
    }
  }

  return (
    <div className={`rounded-xl border px-4 py-3 ${TONE_CLASS[p.tone]}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold">{p.title}</p>
          <p className="mt-1 text-sm opacity-90">{p.body}</p>
          {error && <p className="mt-2 text-sm font-medium text-red-700">{error}</p>}
        </div>

        {p.action && (
          <button
            type="button"
            onClick={choosePlan}
            disabled={busy}
            className="shrink-0 rounded-lg bg-gray-900 px-3 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-60"
          >
            {busy ? "Opening Shopify…" : "Choose a plan on Shopify"}
          </button>
        )}
      </div>

      {/* Deliberately the merchant's own store, not an id. The numeric shop id
          is what the system keys on and means nothing to the person reading. */}
      {snapshot.installation.shopDomain && (
        <p className="mt-2 text-xs opacity-70">{snapshot.installation.shopDomain}</p>
      )}
    </div>
  );
}
