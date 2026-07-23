"use client";

// Channel-connectivity summary hook for empty states.
//
// Small module cache so list pages that remount on navigation answer
// instantly; refreshes in the background and on window focus (catches a
// channel connected in another tab, and OAuth returns).

import { useEffect, useState } from "react";
import { getChannelsSummary, type ChannelsSummary } from "./api";

let cached: ChannelsSummary | null = null;

export function useChannelsSummary(token: string | null): ChannelsSummary | null {
  const [summary, setSummary] = useState<ChannelsSummary | null>(cached);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    const refresh = () => {
      getChannelsSummary(token)
        .then((r) => {
          cached = r.data;
          if (!cancelled) setSummary(r.data);
        })
        .catch(() => { /* empty states fall back to the neutral copy */ });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refresh);
    };
  }, [token]);

  return summary;
}
