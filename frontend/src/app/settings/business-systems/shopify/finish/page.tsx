"use client";

/**
 * Finish connecting a Shopify store that was installed FROM Shopify.
 *
 * This page exists because of the one ordering constraint the App Store
 * imposes: OAuth must complete before any GOTCHA screen appears. A merchant
 * who installs from the listing (or in a browser with no GOTCHA session)
 * therefore arrives here with a store that is already verified and authorized
 * - and no workspace to put it in.
 *
 * What is NOT on this page, deliberately:
 *
 *   • no shop-domain input. The store was identified by Shopify and its name
 *     is read back from the server by handle, never typed.
 *   • no workspace picker keyed off anything in the URL. The workspace is
 *     whichever one the session resolves to, and the server re-checks that
 *     this user may connect integrations to it.
 *   • no access token. The claim happens server-side; the browser only ever
 *     holds an opaque handle that is useless without a valid session.
 *
 * The handle is single-use on the server. Reloading this page is safe (the
 * lookup peeks); pressing the button twice is not harmful either - the second
 * attempt gets `pending_install_already_used`.
 */

import { useEffect, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { getPendingShopifyInstall, claimShopifyInstall } from "@/lib/api";

function FinishShopifyInstall() {
  const { token } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const handle = params.get("handle") || "";

  const [shopDomain, setShopDomain] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token || !handle) {
      setLoading(false);
      return;
    }
    getPendingShopifyInstall(token, handle)
      .then((r) => setShopDomain(r.data.shopDomain))
      .catch((e: any) => {
        // Expired or already claimed. Both mean "install again", and saying
        // which one would tell an unauthenticated prober whether a handle was
        // ever real.
        setError(
          e?.status === 404
            ? "This installation link has expired or was already used. Install the app again from Shopify."
            : "Could not load the pending installation.",
        );
      })
      .finally(() => setLoading(false));
  }, [token, handle]);

  async function claim() {
    if (!token || !handle || claiming) return;
    setClaiming(true);
    setError(null);
    try {
      const r = await claimShopifyInstall(token, handle);
      router.push(
        r.data.flow === "onboarding"
          ? "/setup?connected=shopify"
          : "/settings/business-systems?connected=shopify",
      );
    } catch (e: any) {
      const code = e?.code || e?.error;
      if (code === "shop_connected_to_another_workspace") {
        // Never silently moved. The merchant is told exactly what to do, and
        // the store stays where it is until somebody with access decides.
        setError(
          `${shopDomain ?? "This store"} is already connected to a different GOTCHA workspace. ` +
            "Disconnect it there first, then reconnect here.",
        );
      } else if (code === "pending_install_already_used") {
        setError("This installation was already connected. Check Business Systems.");
      } else {
        setError(e?.message || "Could not finish connecting this store.");
      }
      setClaiming(false);
    }
  }

  if (!handle) {
    return (
      <Shell>
        <p className="text-sm text-gray-600">
          No installation to finish. Start from Business Systems, or install GOTCHA from Shopify.
        </p>
      </Shell>
    );
  }

  if (loading) {
    return (
      <Shell>
        <p className="text-sm text-gray-500">Checking your installation…</p>
      </Shell>
    );
  }

  return (
    <Shell>
      {shopDomain && (
        <>
          <p className="text-sm text-gray-600">
            <span className="font-medium text-gray-900">{shopDomain}</span> is authorized and ready.
            Connect it to this workspace to finish.
          </p>
          <button
            type="button"
            onClick={claim}
            disabled={claiming}
            className="mt-4 inline-flex items-center px-5 py-2.5 bg-primary-500 hover:bg-primary-600 text-white rounded-xl text-sm font-medium transition disabled:opacity-50"
          >
            {claiming ? "Connecting…" : "Connect to this workspace"}
          </button>
        </>
      )}
      {error && <p className="mt-4 text-sm text-amber-700">{error}</p>}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-xl mx-auto py-12 px-6">
      <h1 className="text-xl font-semibold text-gray-900 mb-1">Finish connecting Shopify</h1>
      <p className="text-xs text-gray-400 mb-6">Your store is already authorized on Shopify.</p>
      {children}
    </div>
  );
}

// useSearchParams needs a Suspense boundary in the app router.
export default function Page() {
  return (
    <Suspense fallback={null}>
      <FinishShopifyInstall />
    </Suspense>
  );
}
