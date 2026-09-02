"use client";

/**
 * `/integrations/shopify/billing/complete` - where Shopify returns a merchant
 * after they have chosen and approved (or declined) a plan.
 *
 * THE POINT OF THIS PAGE
 * ----------------------
 * Reaching this URL proves nothing. It is a plain browser navigation: a
 * merchant who declined can reach it from history, anyone can type it, and a
 * link to it can be shared. So this page renders NO outcome of its own. It
 * calls the server, the server asks Shopify what the subscription actually is,
 * and whatever comes back is what gets shown.
 *
 * That is why there is no "Thanks, you're subscribed!" state reachable from a
 * query parameter here, and no optimistic UI: the only success message on this
 * page is one the server produced after a verified read.
 *
 * WHAT IT DOES, IN ORDER
 * ----------------------
 *   1. Wait for a session. A merchant can land here with none - the plan page
 *      lives on Shopify and may have been opened in another browser context -
 *      so this asks them to sign in rather than failing.
 *   2. POST to the verification endpoint, which re-reads the subscription from
 *      Shopify, persists status and plan handle, and moves the Shopify-funded
 *      entitlements to match.
 *   3. Send them to the connected Shopify screen when access is on, or explain
 *      the state when it is not.
 *
 * The `shop` parameter Shopify appends is forwarded but never trusted: the
 * server compares it against the connection the SESSION owns and refuses a
 * mismatch. It is a guard, not a credential.
 */

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import {
  completeShopifyBilling,
  type ShopifyBillingSnapshot,
  type ShopifyBillingState,
} from "@/lib/api";

/**
 * Where a merchant goes once Shopify access is actually on.
 *
 * The LIST screen with a query parameter, NOT `/settings/business-systems/shopify`.
 * That path looks plausible and does not exist: the `[provider]` route's
 * `generateStaticParams` emits only a placeholder, and the static `shopify/`
 * directory holds `finish/` with no `page.tsx` of its own, so a static export
 * produces no HTML for it. This is the destination the OAuth callback already
 * uses (`postOAuthRedirect`), which keeps both arrivals consistent.
 */
const CONNECTED_SCREEN = "/settings/business-systems";

/**
 * What to say for each verified state.
 *
 * Written for a merchant, not an operator. Every one of these is a state the
 * SERVER reported after asking Shopify, so each can be stated as fact.
 */
function describe(state: ShopifyBillingState, declined: boolean): { title: string; body: string } {
  switch (state) {
    case "ACTIVE":
      return {
        title: "Your Shopify plan is active",
        body: "Shopify confirmed the subscription. Your store features are switched on.",
      };
    case "TRIALING":
      return {
        title: "Your trial has started",
        body: "Shopify confirmed the trial. Your store features are switched on for its duration.",
      };
    case "NOT_REQUIRED_GRANDFATHERED":
      return {
        title: "No Shopify charge needed",
        body: "Your workspace keeps its existing GOTCHA billing, so there is nothing to approve here.",
      };
    case "APPROVAL_PENDING":
      return {
        title: "Waiting for approval",
        body: "Shopify still shows this subscription as awaiting approval. Finish approving it in Shopify, then return here.",
      };
    case "PLAN_SELECTION_REQUIRED":
      return declined
        ? {
            title: "No plan was approved",
            body: "Your store stays connected, but the paid Shopify features remain off until a plan is approved.",
          }
        : {
            title: "A plan is still needed",
            body: "Shopify has no active subscription for this store yet.",
          };
    case "PAST_DUE":
      return {
        title: "Payment is overdue",
        body: "Shopify reports a failed charge on this subscription. Settle it in Shopify to restore the store features.",
      };
    case "FROZEN":
      return {
        title: "This store is frozen",
        body: "Shopify has frozen the store, so the subscription is paused. Store features resume when Shopify unfreezes it.",
      };
    case "CANCELLED":
      return {
        title: "The subscription has ended",
        body: "Your store stays connected and your data is untouched, but the paid Shopify features are off.",
      };
    case "UNRESOLVED":
      return {
        title: "Shopify billing is not active yet",
        body: "There is nothing to approve for this workspace right now.",
      };
    case "ERROR":
    default:
      return {
        title: "Something is not right",
        body: "We could not make sense of the subscription state. Contact support and we will sort it out.",
      };
  }
}

function BillingComplete() {
  const { token, isLoading: authLoading } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const shop = params.get("shop");

  const [snapshot, setSnapshot] = useState<ShopifyBillingSnapshot | null>(null);
  const [verifying, setVerifying] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const verify = useCallback(async () => {
    if (!token) return;
    setVerifying(true);
    setError(null);
    try {
      const res = await completeShopifyBilling(token, shop);
      setSnapshot(res.data);
      if (res.data.grantsAccess) {
        // Verified and entitled. Nothing more to say here, so do not make them
        // read a page and click through it.
        router.replace(`${CONNECTED_SCREEN}?connected=shopify`);
      }
    } catch (e: any) {
      // A 502 means we could not REACH Shopify, which is not the same as "you
      // did not pay" - and the copy must not imply it was the merchant's fault.
      setError(
        e?.code === "shopify_verification_failed"
          ? "We could not reach Shopify to confirm your subscription. Nothing has changed - please try again in a moment."
          : e?.code === "shopify_shop_mismatch"
            ? "This billing confirmation belongs to a different store than the one connected here."
            : e?.code === "shopify_not_connected"
              ? "There is no connected Shopify store in this workspace yet."
              : "We could not confirm your subscription. Please try again.",
      );
    } finally {
      setVerifying(false);
    }
  }, [token, shop, router]);

  useEffect(() => {
    if (authLoading) return;
    if (!token) {
      setVerifying(false);
      return;
    }
    void verify();
  }, [authLoading, token, verify]);

  if (authLoading || verifying) {
    return (
      <Shell>
        <p className="text-sm text-gray-600">Confirming your subscription with Shopify…</p>
      </Shell>
    );
  }

  // No session. The plan page lives on Shopify, so arriving here signed out is
  // ordinary rather than exceptional - ask for a sign-in and come straight back.
  if (!token) {
    const next = `/integrations/shopify/billing/complete${shop ? `?shop=${encodeURIComponent(shop)}` : ""}`;
    return (
      <Shell>
        <h1 className="text-lg font-semibold text-gray-900">Sign in to finish</h1>
        <p className="mt-2 text-sm text-gray-600">
          Sign in to your GOTCHA workspace and we will confirm the subscription with Shopify.
        </p>
        <button
          type="button"
          onClick={() => router.push(`/login?next=${encodeURIComponent(next)}`)}
          className="mt-4 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
        >
          Sign in
        </button>
      </Shell>
    );
  }

  if (error) {
    return (
      <Shell>
        <h1 className="text-lg font-semibold text-gray-900">We could not confirm it</h1>
        <p className="mt-2 text-sm text-gray-600">{error}</p>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={() => void verify()}
            className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => router.push(`${CONNECTED_SCREEN}?connected=shopify`)}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Back to Shopify settings
          </button>
        </div>
      </Shell>
    );
  }

  const state = snapshot?.shopify.state ?? "ERROR";
  const copy = describe(state, snapshot?.shopify.declined ?? false);

  return (
    <Shell>
      <h1 className="text-lg font-semibold text-gray-900">{copy.title}</h1>
      <p className="mt-2 text-sm text-gray-600">{copy.body}</p>

      {snapshot?.installation.shopDomain && (
        <p className="mt-3 text-xs text-gray-500">Store: {snapshot.installation.shopDomain}</p>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {/* Only offered when the SERVER said a plan is needed and told us where
            to send them. A link built client-side could point at a plan page
            for a store this workspace does not own. */}
        {snapshot?.requiresPlanSelection && snapshot.planSelectionUrl && (
          <a
            href={snapshot.planSelectionUrl}
            className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
          >
            Choose a plan on Shopify
          </a>
        )}
        <button
          type="button"
          onClick={() => router.push(`${CONNECTED_SCREEN}?connected=shopify`)}
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Go to Shopify settings
        </button>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-lg px-6 py-16">
      <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">{children}</div>
    </main>
  );
}

/**
 * `useSearchParams` requires a Suspense boundary, and this build is a static
 * export - without it the page fails to prerender rather than failing at
 * runtime, which is at least loud, but it fails the build.
 */
export default function Page() {
  return (
    <Suspense
      fallback={
        <Shell>
          <p className="text-sm text-gray-600">Loading…</p>
        </Shell>
      }
    >
      <BillingComplete />
    </Suspense>
  );
}
