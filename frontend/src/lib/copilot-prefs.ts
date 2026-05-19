"use client";

import { useEffect, useState } from "react";

/**
 * Per-rep copilot calibration. Saved in localStorage so each device keeps
 * its own setting (handy for shared workstations + multi-account setups).
 *
 * Tier is the single knob: a senior rep needs whisper mode (pulse only,
 * no animation, no chatter); a junior rep needs more guidance and more
 * visible state. Mid is the sane default.
 */

export type CopilotTier = "junior" | "mid" | "senior";

export interface CopilotProfile {
  tier: CopilotTier;
  /** Lanes the rep is willing to receive. Senior = pulse only. */
  visibleLanes: ReadonlyArray<"pulse" | "direction" | "strategy">;
  /** Hard cap on visible cues at any moment. Excess queued silently. */
  maxVisible: number;
  /** Enable entrance / decay / micro-feedback animations. */
  animations: boolean;
  /** Cooldown between cues of the same dedup-prefix (ms). 0 = off. */
  sameKindCooldownMs: number;
  /** Stale-fade kicks in this many ms after the cue surfaces. */
  staleAfterMs: number;
}

const PROFILES: Record<CopilotTier, CopilotProfile> = {
  junior: {
    tier: "junior",
    visibleLanes: ["pulse", "direction", "strategy"],
    maxVisible: 6,
    animations: true,
    sameKindCooldownMs: 5_000,
    staleAfterMs: 45_000,
  },
  mid: {
    tier: "mid",
    visibleLanes: ["pulse", "direction", "strategy"],
    maxVisible: 4,
    animations: true,
    sameKindCooldownMs: 10_000,
    staleAfterMs: 30_000,
  },
  senior: {
    tier: "senior",
    visibleLanes: ["pulse"],
    maxVisible: 2,
    animations: false,
    sameKindCooldownMs: 20_000,
    staleAfterMs: 15_000,
  },
};

const LS_KEY = "copilot.tier";

function readTier(): CopilotTier {
  if (typeof window === "undefined") return "mid";
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw === "junior" || raw === "mid" || raw === "senior") return raw;
  } catch {
    /* ignore */
  }
  return "mid";
}

function writeTier(tier: CopilotTier): void {
  try {
    localStorage.setItem(LS_KEY, tier);
    window.dispatchEvent(new CustomEvent("copilot:tier-changed", { detail: tier }));
  } catch {
    /* ignore */
  }
}

export function profileFor(tier: CopilotTier): CopilotProfile {
  return PROFILES[tier];
}

/**
 * React hook — returns the current profile + setter. Subscribes to a
 * cross-component event so multiple CueLanesCard instances stay in sync
 * without prop drilling.
 */
export function useCopilotProfile(): {
  profile: CopilotProfile;
  setTier: (tier: CopilotTier) => void;
} {
  const [tier, setTierState] = useState<CopilotTier>("mid");

  // Hydrate after mount to avoid SSR/CSR mismatch.
  useEffect(() => {
    setTierState(readTier());
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent).detail as CopilotTier;
      if (detail === "junior" || detail === "mid" || detail === "senior") {
        setTierState(detail);
      }
    };
    window.addEventListener("copilot:tier-changed", onChange);
    return () => window.removeEventListener("copilot:tier-changed", onChange);
  }, []);

  return {
    profile: profileFor(tier),
    setTier: (next) => {
      writeTier(next);
      setTierState(next);
    },
  };
}
