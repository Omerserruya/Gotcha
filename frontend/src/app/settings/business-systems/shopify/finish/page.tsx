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

import { useCallback, useEffect, useRef, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { getPendingShopifyInstall, claimShopifyInstall } from "@/lib/api";

/**
 * How long to wait for a refreshed token before giving up.
 *
 * A merchant arriving from Shopify often has no live session, so the app
 * silently renews through Authentik while this page is already mounted. That
 * renewal is normally sub-second; 10s is generous enough to cover a slow one
 * and short enough that nobody is left staring at a spinner wondering whether
 * anything is happening.
 */
const TOKEN_REFRESH_GRACE_MS = 10_000;

/**
 * Lookup phases.
 *
 * `awaiting_refresh` is the one that matters. It is NOT an error: the token we
 * had was expired, the app is already renewing it, and the correct behaviour is
 * to wait rather than to tell the merchant their installation failed - which is
 * exactly what the previous "Could not load the pending installation" did.
 */
type Phase =
  | "loading"
  | "awaiting_refresh"
  | "ready"
  | "session_expired"
  | "handle_gone"
  | "error";

function FinishShopifyInstall() {
  const { token } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const handle = params.get("handle") || "";

  const [shopDomain, setShopDomain] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The store this workspace holds today, when connecting would replace it.
   *
   * Null in the ordinary case. Non-null turns the button into an explicit
   * two-option question, because a replacement is a decision and not a step.
   */
  const [replacing, setReplacing] = useState<string | null>(null);

  /**
   * Total lookups issued. Hard-capped at 2 - the first attempt and exactly one
   * retry. A counter rather than a boolean because the cap has to hold even if
   * the token changes repeatedly (a renew storm, or a user with two tabs
   * refreshing the same session), which is precisely when a "retry on new
   * token" rule would otherwise loop forever.
   */
  const attemptsRef = useRef(0);

  /**
   * The token that was rejected as expired.
   *
   * Retrying with the SAME token would fail identically and burn the single
   * retry for nothing, so the retry waits for a genuinely different value.
   */
  const rejectedTokenRef = useRef<string | null>(null);

  /**
   * Set once the lookup reaches an answer it will not improve on: the shop was
   * found, the handle is gone, or the server failed for a reason a new token
   * cannot fix.
   *
   * Without this, a token refresh arriving AFTER a 404 would re-issue the
   * lookup - pointless, because a consumed or expired handle cannot come back,
   * and undesirable because it is a second request against a single-use
   * installation.
   */
  const settledRef = useRef(false);

  const MAX_ATTEMPTS = 2;

  useEffect(() => {
    if (!handle) return;
    // No token yet: the silent renew has not produced one. Keep waiting; this
    // is the ordinary state for a merchant arriving straight from Shopify.
    if (!token) return;

    if (settledRef.current) return;
    if (attemptsRef.current >= MAX_ATTEMPTS) return;
    // Same token that was just rejected - nothing has changed, so do not spend
    // the retry on a request that is certain to fail the same way.
    if (rejectedTokenRef.current !== null && rejectedTokenRef.current === token) return;

    attemptsRef.current += 1;
    let cancelled = false;
    setPhase("loading");

    getPendingShopifyInstall(token, handle)
      .then((r) => {
        if (cancelled) return;
        settledRef.current = true;
        setShopDomain(r.data.shopDomain);
        setPhase("ready");
      })
      .catch((e: any) => {
        if (cancelled) return;

        // 404: expired or already claimed. Both mean "install again", and
        // saying which one would tell an unauthenticated prober whether a
        // handle was ever real.
        if (e?.status === 404) {
          // Terminal. A consumed or expired handle never becomes valid again.
          settledRef.current = true;
          setPhase("handle_gone");
          return;
        }

        // 401 + invalid_token: OUR session lapsed, the installation is fine.
        // Distinct from every other failure because the remedy is different -
        // there is nothing for the merchant to redo on Shopify's side.
        if (e?.status === 401 && e?.code === "invalid_token") {
          rejectedTokenRef.current = token;
          setPhase(
            attemptsRef.current >= MAX_ATTEMPTS ? "session_expired" : "awaiting_refresh",
          );
          return;
        }

        // Anything else - including a 401 that is NOT `invalid_token`, which
        // is a real authorization problem rather than a lapsed session.
        settledRef.current = true;
        setPhase("error");
      });

    return () => {
      cancelled = true;
    };
  }, [token, handle]);

  /**
   * Stop waiting eventually.
   *
   * Without this the page sits on "reconnecting" forever when the refresh never
   * lands - a silent hang is worse than an honest "sign in again", because the
   * pending installation is expiring the whole time.
   */
  useEffect(() => {
    if (phase !== "awaiting_refresh") return;
    const t = setTimeout(() => setPhase("session_expired"), TOKEN_REFRESH_GRACE_MS);
    return () => clearTimeout(t);
  }, [phase]);

  /**
   * Reload, preserving the handle.
   *
   * `location.reload()` rather than a router navigation: the whole point is to
   * restart with a fresh auth bootstrap, and the current URL already carries
   * the handle, so nothing has to be reconstructed or passed along.
   */
  const reload = useCallback(() => {
    if (typeof window !== "undefined") window.location.reload();
  }, []);

  async function claim(replace = false) {
    if (!token || !handle || claiming) return;
    setClaiming(true);
    setError(null);
    try {
      const r = await claimShopifyInstall(token, handle, replace);
      router.push(
        r.data.flow === "onboarding"
          ? "/setup?connected=shopify"
          : "/settings/business-systems?connected=shopify",
      );
    } catch (e: any) {
      const code = e?.code || e?.error;
      if (code === "another_store_connected") {
        // A workspace holds one Shopify store, so this connection would
        // disconnect the one it already has. That used to happen silently -
        // the row was overwritten and every AI answer quietly started reading a
        // different catalogue while the screen said "Connected".
        //
        // The handle is NOT spent when the server answers this, so the
        // merchant's answer goes straight back without another trip through
        // Shopify.
        // `body`, not `data`: apiFetch attaches the whole parsed response as
        // `err.body`, and the server nests the detail under `data`.
        setReplacing((e?.body as any)?.data?.currentShopDomain || "another store");
        setClaiming(false);
        return;
      }
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

  if (phase === "loading" || phase === "awaiting_refresh") {
    return (
      <Shell>
        <p className="text-sm text-gray-500">
          {phase === "awaiting_refresh"
            ? "Reconnecting your session…"
            : "Checking your installation…"}
        </p>
      </Shell>
    );
  }

  // OUR session lapsed. The Shopify authorization is intact and the pending
  // installation is untouched, so the only thing needed is a fresh sign-in -
  // and the merchant must be told that, rather than being sent back to Shopify
  // to redo work that already succeeded.
  if (phase === "session_expired") {
    return (
      <Shell>
        <p className="text-sm text-gray-600">
          Your GOTCHA session expired while we were finishing up. Your store is still authorized on
          Shopify - reload to sign in again and complete the connection.
        </p>
        <button
          type="button"
          onClick={reload}
          className="mt-4 inline-flex items-center px-5 py-2.5 bg-primary-500 hover:bg-primary-600 text-white rounded-xl text-sm font-medium transition"
        >
          Reload and continue
        </button>
      </Shell>
    );
  }

  if (phase === "handle_gone") {
    return (
      <Shell>
        <p className="text-sm text-amber-700">
          This installation link has expired or was already used. Install the app again from
          Shopify.
        </p>
      </Shell>
    );
  }

  if (phase === "error") {
    return (
      <Shell>
        <p className="text-sm text-amber-700">
          We could not load the pending installation. Please try again, or contact support if it
          keeps happening.
        </p>
        <button
          type="button"
          onClick={reload}
          className="mt-4 inline-flex items-center px-5 py-2.5 border border-gray-300 hover:bg-gray-50 text-gray-700 rounded-xl text-sm font-medium transition"
        >
          Try again
        </button>
      </Shell>
    );
  }

  // The replacement question. Both outcomes are named on their buttons - the
  // merchant should not have to infer which store survives.
  if (replacing) {
    return (
      <Shell>
        <p className="text-sm text-gray-600">
          This workspace is connected to{" "}
          <span className="font-medium text-gray-900">{replacing}</span>. A workspace can use one
          Shopify store at a time, so connecting{" "}
          <span className="font-medium text-gray-900">{shopDomain}</span> will disconnect it.
        </p>
        <p className="mt-2 text-sm text-gray-500">
          {replacing} stays on Shopify and keeps its data. GOTCHA just stops reading from it.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => claim(true)}
            disabled={claiming}
            className="inline-flex items-center px-5 py-2.5 bg-primary-500 hover:bg-primary-600 text-white rounded-xl text-sm font-medium transition disabled:opacity-50"
          >
            {claiming ? "Switching…" : `Disconnect ${replacing} and use ${shopDomain}`}
          </button>
          <button
            type="button"
            onClick={() => router.push("/settings/business-systems")}
            disabled={claiming}
            className="inline-flex items-center px-5 py-2.5 border border-gray-300 hover:bg-gray-50 text-gray-700 rounded-xl text-sm font-medium transition disabled:opacity-50"
          >
            Keep {replacing}
          </button>
        </div>
        {error && <p className="mt-4 text-sm text-amber-700">{error}</p>}
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
            onClick={() => claim()}
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
