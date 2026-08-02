"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getPublicPricing,
  defaultSelection,
  type PublicPricingCatalog,
  type PublicPlan,
  type Selection,
} from "@/lib/api-public-pricing";

export type PricingState = "loading" | "ready" | "disabled" | "empty" | "error";

interface UsePublicPricing {
  state: PricingState;
  catalog: PublicPricingCatalog | null;
  plans: PublicPlan[];
  currency: string;
  setCurrency: (c: string) => void;
  activeKey: string | null;
  setActiveKey: (k: string) => void;
  activePlan: PublicPlan | null;
  selections: Record<string, Selection>;
  setVolume: (planKey: string, channel: "chat" | "voice", optionKey: string) => void;
  retry: () => void;
}

/**
 * Loads the public catalog and owns plan/volume/currency selection.
 *
 * Selections are keyed by plan so moving between plans keeps each one's chosen
 * volume, and they survive a currency switch: changing how a price is DISPLAYED
 * must never silently reset what the visitor configured.
 */
export function usePublicPricing(locale: string): UsePublicPricing {
  const [state, setState] = useState<PricingState>("loading");
  const [catalog, setCatalog] = useState<PublicPricingCatalog | null>(null);
  const [currency, setCurrency] = useState("USD");
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [selections, setSelections] = useState<Record<string, Selection>>({});
  const [attempt, setAttempt] = useState(0);

  // Drops stale responses so a slow first request cannot overwrite a newer one.
  const seq = useRef(0);

  useEffect(() => {
    const mySeq = ++seq.current;
    const ac = new AbortController();
    // Keep the previous catalog on screen while re-fetching for a currency
    // change; blanking to a skeleton on every toggle reads as a page reload.
    if (!catalog) setState("loading");

    getPublicPricing({ currency, locale, signal: ac.signal })
      .then((c) => {
        if (mySeq !== seq.current) return;
        setCatalog(c);
        if (c.plans.length === 0) {
          setState("empty");
          return;
        }
        setSelections((prev) => {
          const next = { ...prev };
          for (const p of c.plans) if (!next[p.key]) next[p.key] = defaultSelection(p);
          return next;
        });
        setActiveKey((k) => k ?? c.plans.find((p) => p.recommended)?.key ?? c.plans[0].key);
        setState("ready");
      })
      .catch((err: any) => {
        if (mySeq !== seq.current || err?.name === "AbortError") return;
        // 404 is the flag being off. Anything else is a genuine outage, and the
        // two get different copy: "not available" versus "try again".
        setState(err?.status === 404 ? "disabled" : "error");
      });

    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currency, locale, attempt]);

  const setVolume = useCallback((planKey: string, channel: "chat" | "voice", optionKey: string) => {
    setSelections((s) => ({
      ...s,
      [planKey]: { ...(s[planKey] ?? { chat: null, voice: null }), [channel]: optionKey },
    }));
  }, []);

  const plans = catalog?.plans ?? [];
  return {
    state,
    catalog,
    plans,
    currency,
    setCurrency,
    activeKey,
    setActiveKey,
    activePlan: plans.find((p) => p.key === activeKey) ?? null,
    selections,
    setVolume,
    retry: () => setAttempt((a) => a + 1),
  };
}

/** Localized plan name/description, falling back to English when unset. */
export function planCopy(plan: PublicPlan, isHe: boolean) {
  return {
    name: isHe ? plan.nameHe ?? plan.name : plan.name,
    description: isHe ? plan.descriptionHe ?? plan.description : plan.description,
  };
}
