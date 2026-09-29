"use client";

import { useEffect, useState } from "react";
import { getShopifyBillingState, type ShopifyBillingSnapshot } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import {
  presentShopifyFeatureAccess,
  type ShopifyFeatureAccess,
} from "@/lib/shopify-connector-state";

/**
 * The Shopify paid-access gate for an integration screen.
 *
 * Every Shopify-specific indicator on the integration screens reads this, so
 * the page cannot contradict the Connector banner beside it. The decision
 * itself lives in `presentShopifyFeatureAccess`, which is pure and tested; this
 * hook only fetches the snapshot.
 *
 * WHILE LOADING WE DO NOT FLASH A DENIAL.
 * Before the snapshot arrives the gate reports `applies: false`, leaving each
 * screen on its existing behaviour rather than showing "Connector required" for
 * one render to a merchant who has paid. A fetch that FAILS is treated the same
 * way, and that is deliberate: this gate is presentation, never enforcement.
 * `services/ai` refuses Shopify data on its own reading of the entitlements
 * whatever this screen happens to draw, so a screen that briefly looks
 * permissive grants nothing.
 */
export function useShopifyFeatureAccess(
  slug: string,
  integrationConnected: boolean,
): ShopifyFeatureAccess {
  const { token } = useAuth();
  const [snapshot, setSnapshot] = useState<ShopifyBillingSnapshot | null>(null);

  useEffect(() => {
    if (slug !== "shopify" || !token) {
      setSnapshot(null);
      return;
    }
    let cancelled = false;
    getShopifyBillingState(token)
      .then((res) => {
        if (!cancelled) setSnapshot(res.data ?? null);
      })
      .catch(() => {
        if (!cancelled) setSnapshot(null);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, token]);

  return presentShopifyFeatureAccess(slug, snapshot, { integrationConnected });
}
