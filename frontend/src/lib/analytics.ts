// Product-event tracking (guided tour, setup checklist, empty-state CTAs,
// outbound calling). Fire-and-forget: analytics must never block or break the
// UI, so every failure is swallowed. Events land on the analytics service
// (POST /api/analytics/events), which attributes them to the authenticated
// identity + active tenant server-side - the client never sends a tenant id.

import { API_URL } from "./api";

let currentToken: string | null = null;

/** Wire the session token once (AppLayout); track() calls stay one-liners. */
export function setAnalyticsToken(token: string | null): void {
  currentToken = token;
}

export function track(event: string, props?: Record<string, unknown>): void {
  if (!currentToken || typeof window === "undefined") return;
  try {
    void fetch(`${API_URL}/api/analytics/events`, {
      method: "POST",
      keepalive: true, // survives navigations (tour steps navigate constantly)
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${currentToken}`,
      },
      body: JSON.stringify({ event, props: props || {} }),
    }).catch(() => {});
  } catch {
    /* never let telemetry break the product */
  }
}
